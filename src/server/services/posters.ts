// Posters page (/posters): the team's posters and flyers (a library demo, recruiting, a fundraiser…).
// - Everyone ACTIVE sees them and adds them directly (no approval).
// - A poster is an uploaded picture (PNG, JPG, GIF, WebP) or PDF, a link to the design (Canva, Drive…), or both.
// - Whoever added one changes or removes it; so does everyone with admin access (canEditPoster).
//
// Files live in Postgres like Resources files and count toward the same storage cap (../files/storage.ts,
// checked under its lock). Each person's poster files stay under POSTER_FILE_BYTES_PER_PERSON unless they
// have admin access, so one account can't fill the storage. Poster files are checked by their contents, not
// just their name: only real images and PDFs get in (never SVG or HTML), and only pictures small enough (in
// pixels) for a phone to draw, stored with the matching extension and type, so the file route
// (src/app/(app)/posters/files/[id]/route.ts) can always show them inline.
import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { LIMITS } from "@/lib/constants";
import { addDays, type DateOnly, dateOnlyToDb, dbToDateOnly, todayInTimezone } from "@/lib/dates";
import { formatFileSize } from "@/lib/files";
import {
  POSTER_FILE_TYPES_MESSAGE,
  POSTER_HEIC_MESSAGE,
  POSTER_IMAGE_MAX_PIXELS,
  POSTER_IMAGE_MAX_SIDE,
  POSTER_UNREADABLE_MESSAGE,
  posterFileTooBigMessage,
  posterImageTooLargeMessage,
} from "@/lib/posters";
import { withHttps } from "@/lib/sponsorships";
import { parseHttpUrl } from "@/lib/urls";
import { checkbox, dateOnlySchema, idSchema, optionalText, text } from "@/lib/validation";
import { parseInput } from "../action";
import type { ServiceContext } from "../context";
import { ForbiddenError, NotFoundError, ValidationError } from "../errors";
import { assertFileStorageRoom, lockFileStorage, storageFullSentence } from "../files/storage";
import {
  checkUploadedFile,
  type CleanUpload,
  cleanFilename,
  fileError,
  readUpload,
  storedFileData,
  type UploadMessages,
} from "../files/upload";
import { canAdminister, canEditPoster } from "../permissions";
import { enforceRateLimit } from "../rate-limit";
import { fileExtension } from "../resources/serve";

type Tx = Prisma.TransactionClient;

export const POSTER_NOT_FOUND = "That poster no longer exists.";
export const POSTER_INACTIVE = "Your account isn't active, so you can't change posters.";
export const POSTER_CANT_EDIT =
  "Only the person who added this poster, or a leader, captain, mentor, or teacher, can change or remove it.";
/** A poster with neither a file nor a link: shown on the file picker (it comes first in the form). */
export const POSTER_NEEDS_FILE_OR_LINK = "Add a picture or PDF of the poster, or a link to it (or both).";
const LINK_MESSAGE = "Enter a web link, like https://www.canva.com/design/…";
const DATE_TOO_EARLY = "That date is more than 5 years ago. Check the year.";
const DATE_TOO_LATE = "That date is more than 2 years away. Check the year.";

const HOUR = 60 * 60 * 1000;
/** New posters (and edits that upload a new file) per person per hour; each can carry up to 4 MB. */
export const POSTER_RATE_LIMIT = { limit: 30, windowMs: HOUR } as const;

/**
 * Poster files one person can have (all their posters together; removing old ones frees it up again), so one
 * account can't fill the team's storage. Everyone with admin access isn't limited.
 */
export const POSTER_FILE_BYTES_PER_PERSON = 50 * 1024 * 1024;

/** How far back / ahead the event date may be (days from today in the team timezone). Catches typos like 2062. */
export const POSTER_DATE_MAX_PAST_DAYS = 5 * 365;
export const POSTER_DATE_MAX_FUTURE_DAYS = 2 * 365;

// ---------- files ----------

/** What a poster file really is, from its first bytes. */
type PosterFileKind = "png" | "jpg" | "gif" | "webp" | "pdf";

const KIND_INFO: Record<PosterFileKind, { contentType: string; extensions: string[] }> = {
  png: { contentType: "image/png", extensions: ["png"] },
  jpg: { contentType: "image/jpeg", extensions: ["jpg", "jpeg"] },
  gif: { contentType: "image/gif", extensions: ["gif"] },
  webp: { contentType: "image/webp", extensions: ["webp"] },
  pdf: { contentType: "application/pdf", extensions: ["pdf"] },
};

function startsWith(bytes: Uint8Array, prefix: number[], offset = 0): boolean {
  if (bytes.length < offset + prefix.length) return false;
  return prefix.every((b, i) => bytes[offset + i] === b);
}

const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0));

/** Bytes a scanner may put before a PDF's header: whitespace and NULs, nothing else. */
const PDF_LEADING_BLANKS: ReadonlySet<number> = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);

/**
 * A PDF starts with "%PDF-". Only blank bytes (PDF_LEADING_BLANKS) may come before it, so HTML (or anything else)
 * with "%PDF-" tucked into a comment isn't taken for a PDF.
 */
function hasPdfHeader(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length, 1024);
  for (let i = 0; i < limit; i++) {
    if (bytes[i] === 0x25) return startsWith(bytes, ascii("%PDF-"), i); // "%"
    if (!PDF_LEADING_BLANKS.has(bytes[i])) return false;
  }
  return false;
}

/** The file's real kind by its contents (magic bytes), or null for anything else (SVG, HTML, HEIC, Word…). */
export function sniffPosterFile(bytes: Uint8Array): PosterFileKind | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "jpg";
  if (startsWith(bytes, ascii("GIF87a")) || startsWith(bytes, ascii("GIF89a"))) return "gif";
  if (startsWith(bytes, ascii("RIFF")) && startsWith(bytes, ascii("WEBP"), 8)) return "webp";
  if (hasPdfHeader(bytes)) return "pdf";
  return null;
}

// ---------- picture size (pixels) ----------

export interface PixelSize {
  width: number;
  height: number;
}

const u16be = (b: Uint8Array, i: number) => (b[i] << 8) | b[i + 1];
const u16le = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8);
const u24le = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
const u32be = (b: Uint8Array, i: number) => ((b[i] << 24) >>> 0) + ((b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]);

/** PNG: the IHDR chunk, which must come first (bytes 12–15), holds the size. */
function pngSize(b: Uint8Array): PixelSize | null {
  if (b.length < 24 || !startsWith(b, ascii("IHDR"), 12)) return null;
  return { width: u32be(b, 16), height: u32be(b, 20) };
}

/** Start-of-frame markers (baseline, progressive, lossless, arithmetic…); not DHT (C4), JPG (C8), or DAC (CC). */
const JPEG_SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

/**
 * JPEG: walks the markers to the first start-of-frame, the way libjpeg (Chrome, Firefox) does: stray bytes between
 * segments are skipped, and segments (EXIF, with its own thumbnail inside) are jumped over by their length.
 */
function jpegSize(b: Uint8Array): PixelSize | null {
  let i = 2; // after SOI
  while (i < b.length) {
    while (i < b.length && b[i] !== 0xff) i++; // stray bytes
    while (i < b.length && b[i] === 0xff) i++; // fill bytes
    if (i >= b.length) return null;
    const marker = b[i++];
    if (marker === 0x00 || marker === 0x01 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) continue; // no length
    if (marker === 0xd9 || marker === 0xda) return null; // the image ended, or its data started, with no size
    if (i + 2 > b.length) return null;
    const length = u16be(b, i);
    if (length < 2) return null;
    if (JPEG_SOF.has(marker)) return i + 7 <= b.length ? { width: u16be(b, i + 5), height: u16be(b, i + 3) } : null;
    i += length;
  }
  return null;
}

/** Skips a GIF's data sub-blocks from `i`; the index after them, or -1 when the file ends first. */
function skipGifSubBlocks(b: Uint8Array, i: number): number {
  while (i < b.length) {
    const n = b[i++];
    if (n === 0) return i;
    i += n;
  }
  return -1;
}

/**
 * GIF: the screen size (bytes 6–9), grown to fit every frame, since browsers make the picture as big as a frame
 * that sticks out of it.
 */
function gifSize(b: Uint8Array): PixelSize | null {
  if (b.length < 13) return null;
  let width = u16le(b, 6);
  let height = u16le(b, 8);
  let i = 13;
  if (b[10] & 0x80) i += 3 * (1 << ((b[10] & 7) + 1)); // global color table
  while (i < b.length) {
    const block = b[i++];
    if (block === 0x21) {
      i = skipGifSubBlocks(b, i + 1); // extension: its label, then data
    } else if (block === 0x2c) {
      if (i + 9 > b.length) break;
      width = Math.max(width, u16le(b, i) + u16le(b, i + 4));
      height = Math.max(height, u16le(b, i + 2) + u16le(b, i + 6));
      const flags = b[i + 8];
      i += 9;
      if (flags & 0x80) i += 3 * (1 << ((flags & 7) + 1)); // local color table
      i = skipGifSubBlocks(b, i + 1); // LZW code size, then the image data
    } else {
      break; // trailer (0x3B) or something browsers don't read past either
    }
    if (i < 0) break;
  }
  return { width, height };
}

/** WebP: the first chunk after "WEBP" is VP8 (lossy), VP8L (lossless), or VP8X (extended, with the canvas size). */
function webpSize(b: Uint8Array): PixelSize | null {
  if (startsWith(b, ascii("VP8 "), 12)) {
    if (b.length < 30 || !startsWith(b, [0x9d, 0x01, 0x2a], 23)) return null;
    return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
  }
  if (startsWith(b, ascii("VP8L"), 12)) {
    if (b.length < 25 || b[20] !== 0x2f) return null;
    const bits = (b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24)) >>> 0;
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (startsWith(b, ascii("VP8X"), 12)) {
    if (b.length < 30) return null;
    return { width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
  }
  return null;
}

/** A picture's size in pixels from its header (null when it can't be read); null for PDFs. */
export function posterImageSize(bytes: Uint8Array, kind: PosterFileKind): PixelSize | null {
  switch (kind) {
    case "png":
      return pngSize(bytes);
    case "jpg":
      return jpegSize(bytes);
    case "gif":
      return gifSize(bytes);
    case "webp":
      return webpSize(bytes);
    case "pdf":
      return null;
  }
}

/** Pictures must be readable and small enough for a phone to draw (POSTER_IMAGE_MAX_SIDE / _PIXELS). */
function checkPictureSize(bytes: Uint8Array, kind: PosterFileKind): void {
  if (kind === "pdf") return;
  const size = posterImageSize(bytes, kind);
  if (!size || size.width < 1 || size.height < 1) throw fileError(POSTER_UNREADABLE_MESSAGE);
  if (
    size.width > POSTER_IMAGE_MAX_SIDE ||
    size.height > POSTER_IMAGE_MAX_SIDE ||
    size.width * size.height > POSTER_IMAGE_MAX_PIXELS
  ) {
    throw fileError(posterImageTooLargeMessage(size.width, size.height));
  }
}

/** HEIC/HEIF (iPhone photos) and AVIF: an ISO media file with an image brand. Browsers mostly can't show them. */
function isHeicLike(bytes: Uint8Array): boolean {
  if (!startsWith(bytes, ascii("ftyp"), 4)) return false;
  const brand = String.fromCharCode(...bytes.subarray(8, 12));
  return ["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1", "avif", "avis"].includes(brand);
}

/** "IMG_0001.HEIC" holding a JPEG → "IMG_0001.jpg"; "flyer" → "flyer.pdf". Keeps names like "v2.5" intact. */
function withKindExtension(filename: string, kind: PosterFileKind): string {
  const ext = fileExtension(filename);
  const { extensions } = KIND_INFO[kind];
  if (extensions.includes(ext)) return filename;
  const base = ext && /^[a-z][a-z0-9]{0,4}$/.test(ext) ? filename.slice(0, -(ext.length + 1)) : filename;
  return cleanFilename(`${base || "poster"}.${extensions[0]}`);
}

const UPLOAD_MESSAGES: UploadMessages = {
  tooBig: posterFileTooBigMessage,
  blocked: () => POSTER_FILE_TYPES_MESSAGE,
};

/**
 * Checks a picked poster file: not empty, up to 4 MB, really a PNG, JPG, GIF, WebP, or PDF (by its bytes), and a
 * picture a phone can draw (by the size in its header). The stored name gets the matching extension and the
 * stored type is the real one.
 */
function checkPosterFile(value: unknown): CleanUpload | null {
  const picked = readUpload(value);
  if (!picked) return null;
  const upload = checkUploadedFile(picked, UPLOAD_MESSAGES);
  const kind = sniffPosterFile(upload.bytes);
  if (!kind) throw fileError(isHeicLike(upload.bytes) ? POSTER_HEIC_MESSAGE : POSTER_FILE_TYPES_MESSAGE);
  checkPictureSize(upload.bytes, kind);
  return { ...upload, filename: withKindExtension(upload.filename, kind), contentType: KIND_INFO[kind].contentType };
}

// ---------- input ----------

/** "" = no link; otherwise an http(s) link (https:// added to a bare "canva.com/…"). */
const linkField = z.preprocess(
  (v) => (typeof v === "string" ? v : ""),
  z.string().transform((v, ctx) => {
    if (!v.trim()) return "";
    const url = parseHttpUrl(withHttps(v));
    if (!url) {
      ctx.addIssue({ code: "custom", message: LINK_MESSAGE });
      return z.NEVER;
    }
    return url;
  }),
);

const eventDateField = z.preprocess(
  (v) => (v === undefined || v === null || (typeof v === "string" && v.trim() === "") ? undefined : v),
  dateOnlySchema.optional(),
);

const posterFields = z.object({
  title: text("Title", LIMITS.posterTitleMax),
  description: optionalText("Description", LIMITS.posterDescriptionMax),
  event: optionalText("What it's for", LIMITS.posterEventMax),
  eventDate: eventDateField,
});
// Checked on its own, so a problem elsewhere doesn't hide whether there is a link.
const linkInput = z.object({ link: linkField });

interface ParsedPoster {
  data: { title: string; description: string; link: string; event: string; eventDate: Date | null };
  /** A newly picked file (null = none picked). */
  upload: CleanUpload | null;
}

function asRecord(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

function requireActive(ctx: ServiceContext) {
  if (ctx.actor.status !== "ACTIVE") throw new ForbiddenError(POSTER_INACTIVE);
}

/**
 * Checks the whole form at once (fields and file together), so every problem is shown in one go.
 * `keepsFile(upload)`: whether the poster will have a file after saving (a poster needs a file or a link).
 * `savedDate`: the event date the poster has now (editing). Kept as it is, it isn't range-checked again, so an
 * old poster's typo can still be fixed years later.
 */
function parsePosterForm(
  ctx: ServiceContext,
  rec: Record<string, unknown>,
  { keepsFile, savedDate = null }: { keepsFile: (upload: CleanUpload | null) => boolean; savedDate?: DateOnly | null },
): ParsedPoster {
  const errors: Record<string, string> = {};
  const failures: ValidationError[] = [];
  const add = (e: ValidationError) => {
    failures.push(e);
    const entries = Object.entries(e.fieldErrors);
    if (entries.length === 0) errors._form ??= e.userMessage;
    for (const [key, message] of entries) errors[key] ??= message;
  };
  const attempt = <T>(fn: () => T): T | undefined => {
    try {
      return fn();
    } catch (e) {
      if (!(e instanceof ValidationError)) throw e;
      add(e);
      return undefined;
    }
  };

  const fields = attempt(() => parseInput(posterFields, rec));
  const link = attempt(() => parseInput(linkInput, rec).link);
  const upload = attempt(() => checkPosterFile(rec.file)) ?? null;

  if (fields?.eventDate && fields.eventDate !== savedDate) {
    const today = todayInTimezone(ctx.config.teamTimezone, ctx.now);
    if (fields.eventDate < addDays(today, -POSTER_DATE_MAX_PAST_DAYS)) {
      add(new ValidationError(DATE_TOO_EARLY, { eventDate: DATE_TOO_EARLY }));
    } else if (fields.eventDate > addDays(today, POSTER_DATE_MAX_FUTURE_DAYS)) {
      add(new ValidationError(DATE_TOO_LATE, { eventDate: DATE_TOO_LATE }));
    }
  }
  // Something to show: a file (new or kept) or a link. Not said when the file or link has its own problem.
  if (!errors.file && link === "" && !keepsFile(upload)) {
    add(new ValidationError(POSTER_NEEDS_FILE_OR_LINK, { file: POSTER_NEEDS_FILE_OR_LINK }));
  }

  if (failures.length > 0 || !fields || link === undefined) {
    // One failing check keeps its own message; several get a general one.
    const message = failures.length === 1 ? failures[0].userMessage : "Please fix the highlighted fields.";
    throw new ValidationError(message, errors);
  }
  return {
    data: {
      title: fields.title,
      description: fields.description ?? "",
      link,
      event: fields.event ?? "",
      eventDate: fields.eventDate ? dateOnlyToDb(fields.eventDate) : null,
    },
    upload,
  };
}

/**
 * Room for a new poster file (under the storage lock): the person's own poster files stay under
 * POSTER_FILE_BYTES_PER_PERSON (unless they have admin access), and all files together under the team's cap.
 * `replacing` = the poster whose current file this one replaces (its bytes don't count).
 */
async function assertPosterRoom(
  tx: Tx,
  ctx: ServiceContext,
  change: { adding: number; freeing: number; replacing?: string },
): Promise<void> {
  await lockFileStorage(tx);
  if (!canAdminister(ctx.actor)) {
    const mine = await tx.posterFile.aggregate({
      _sum: { size: true },
      where: { poster: { createdById: ctx.actor.id, ...(change.replacing ? { id: { not: change.replacing } } : {}) } },
    });
    const used = mine._sum.size ?? 0;
    if (used + change.adding > POSTER_FILE_BYTES_PER_PERSON) {
      throw fileError(
        `Your posters use ${formatFileSize(used)}, and each person can have up to ${formatFileSize(POSTER_FILE_BYTES_PER_PERSON)}. Remove old posters you don't need, add a link instead, or ask a leader to add this one.`,
      );
    }
  }
  await assertFileStorageRoom(
    tx,
    { adding: change.adding, freeing: change.freeing },
    (usage) =>
      `${storageFullSentence(usage)} Add a link to the design instead, or remove old posters you don't need. Leaders, the captain, mentors, and teachers can clear out old posters and Resources files.`,
  );
}

// ---------- mutations ----------

/** Add a poster (a picture or PDF, a link, or both). Goes up for the whole team right away. */
export async function createPoster(ctx: ServiceContext, raw: unknown): Promise<{ id: string }> {
  requireActive(ctx);
  const rec = asRecord(raw);
  const { data, upload } = parsePosterForm(ctx, rec, { keepsFile: (u) => u !== null });
  await enforceRateLimit(ctx.db, `poster:${ctx.actor.id}`, POSTER_RATE_LIMIT.limit, POSTER_RATE_LIMIT.windowMs, ctx.now);

  return ctx.db.$transaction(async (tx) => {
    if (upload) await assertPosterRoom(tx, ctx, { adding: upload.bytes.byteLength, freeing: 0 });
    return tx.poster.create({
      data: {
        ...data,
        createdById: ctx.actor.id,
        createdAt: ctx.now,
        file: upload ? { create: { ...storedFileData(upload), createdAt: ctx.now } } : undefined,
      },
      select: { id: true },
    });
  });
}

const posterIdInput = z.object({ posterId: idSchema });
const removeFileInput = z.object({ removeFile: checkbox });

/** Loads a poster for a change and checks the actor may make it (missing → NotFound, not theirs → Forbidden). */
async function loadEditablePoster(ctx: ServiceContext, posterId: string) {
  const poster = await ctx.db.poster.findUnique({
    where: { id: posterId },
    select: { id: true, title: true, createdById: true, eventDate: true, file: { select: { size: true } } },
  });
  if (!poster) throw new NotFoundError(POSTER_NOT_FOUND);
  if (!canEditPoster(ctx.actor, poster)) throw new ForbiddenError(POSTER_CANT_EDIT);
  return poster;
}

/**
 * Change a poster. A newly picked file replaces the current one; `removeFile` removes it (a poster must still
 * have a file or a link). Saved without either, the current file stays. Last save wins.
 */
export async function updatePoster(ctx: ServiceContext, raw: unknown): Promise<{ id: string }> {
  requireActive(ctx);
  const rec = asRecord(raw);
  const { posterId } = parseInput(posterIdInput, rec);
  const existing = await loadEditablePoster(ctx, posterId);
  const { removeFile } = parseInput(removeFileInput, rec);
  const keepsFile = (upload: CleanUpload | null) => upload !== null || (!!existing.file && !removeFile);
  const savedDate = existing.eventDate ? dbToDateOnly(existing.eventDate) : null;
  const { data, upload } = parsePosterForm(ctx, rec, { keepsFile, savedDate });
  // A new file is an upload like a new poster: they share the allowance.
  if (upload) {
    await enforceRateLimit(ctx.db, `poster:${ctx.actor.id}`, POSTER_RATE_LIMIT.limit, POSTER_RATE_LIMIT.windowMs, ctx.now);
  }

  await ctx.db.$transaction(async (tx) => {
    // Holds the poster until this commits, so a removal (or another save) can't slip in between.
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Poster" WHERE id = ${posterId} FOR UPDATE`;
    if (locked.length === 0) throw new NotFoundError(POSTER_NOT_FOUND);
    const current = await tx.posterFile.findUnique({ where: { posterId }, select: { size: true } });
    if (!upload && !data.link && (!current || removeFile)) {
      throw new ValidationError(POSTER_NEEDS_FILE_OR_LINK, { file: POSTER_NEEDS_FILE_OR_LINK });
    }
    if (upload) {
      await assertPosterRoom(tx, ctx, { adding: upload.bytes.byteLength, freeing: current?.size ?? 0, replacing: posterId });
    }
    await tx.poster.update({ where: { id: posterId }, data });
    if (upload) {
      // A new row (and id), so the file's address changes and nobody sees the old picture from a cache.
      await tx.posterFile.deleteMany({ where: { posterId } });
      await tx.posterFile.create({ data: { posterId, ...storedFileData(upload), createdAt: ctx.now } });
    } else if (removeFile) {
      await tx.posterFile.deleteMany({ where: { posterId } });
    }
  });
  return { id: posterId };
}

/** Remove a poster and its file: whoever added it, and everyone with admin access. */
export async function deletePoster(ctx: ServiceContext, raw: unknown): Promise<{ title: string }> {
  requireActive(ctx);
  const { posterId } = parseInput(posterIdInput, asRecord(raw));
  const poster = await loadEditablePoster(ctx, posterId);
  const { count } = await ctx.db.poster.deleteMany({ where: { id: posterId } });
  if (count === 0) throw new NotFoundError(POSTER_NOT_FOUND);
  return { title: poster.title };
}
