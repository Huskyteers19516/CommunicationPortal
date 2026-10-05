// The Workshop (/workshop): what the team designs and builds — 3D-printed and CAD parts, software, other builds —
// with photos of each version and design files, shown on the team website's Workshop page once approved
// (GET /api/public/workshop: src/server/queries/public-workshop.ts, served by src/server/public-api.ts).
// - Everyone ACTIVE adds projects. A new project is a DRAFT: only the people who can change it (and reviewers) see it.
// - Who can change one: whoever added it, the people credited on it, and everyone with admin access (the reviewers,
//   canReviewWorkshop). Removing a whole project: whoever added it, and reviewers.
// - "Send for approval" (DRAFT / REJECTED → PENDING) needs at least one photo; reviewers approve it (→ APPROVED, on
//   the website) or send it back with a note (→ REJECTED). Reviewers' own "Publish" goes straight to APPROVED.
// - It's public, so when someone who isn't a reviewer adds or rewrites anything on an APPROVED project (details,
//   a photo or its caption, a design file), it goes back to PENDING (off the website until approved again).
//   Removing things, reordering photos, and picking the cover don't need approval.
// - "Take off the website" (APPROVED / PENDING → DRAFT): anyone who can change it.
//
// Photos and design files are stored like other uploads (Postgres, or Cloudflare R2: ../files/stored.ts) and count
// toward the team's storage cap; each person's uploads stay under WORKSHOP_FILE_BYTES_PER_PERSON (10× with R2) unless
// they have admin access. Photos are checked by their contents (PNG, JPG, or WebP, a size in pixels a phone can draw);
// design files by their extension (CAD, printing, PDF, ZIP) and, where it's cheap, their first bytes. Design files are
// always downloaded, never shown in a browser.
import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { formatFileSize } from "@/lib/files";
import { POSTER_IMAGE_MAX_PIXELS, POSTER_IMAGE_MAX_SIDE, posterImageTooLargeMessage } from "@/lib/posters";
import { withHttps } from "@/lib/sponsorships";
import { parseHttpUrl } from "@/lib/urls";
import { checkbox, idSchema, optionalText, stringArray, text } from "@/lib/validation";
import {
  WORKSHOP_FILE_EXTENSIONS,
  WORKSHOP_FILE_TYPES_MESSAGE,
  WORKSHOP_KINDS,
  WORKSHOP_LIMITS,
  WORKSHOP_PHOTO_HEIC_MESSAGE,
  WORKSHOP_PHOTO_TYPES_MESSAGE,
  WORKSHOP_PHOTO_UNREADABLE_MESSAGE,
  workshopExtension,
  workshopFileTooBigMessage,
  workshopPhotoTooBigMessage,
} from "@/lib/workshop";
import { parseInput } from "../action";
import type { ServiceContext } from "../context";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../errors";
import { assertFileStorageRoom, checkFileStorageRoom, lockFileStorage, perPersonFileCap, storageFullSentence } from "../files/storage";
import { usesObjectStorage, withStoredFiles } from "../files/stored";
import { checkUploadedFile, type CleanUpload, cleanFilename, fileError, readUpload, type UploadMessages } from "../files/upload";
import { canAdminister, canDeleteWorkshopProject, canEditWorkshopProject, canReviewWorkshop } from "../permissions";
import { enforceRateLimit } from "../rate-limit";
import { imageOrientation, stripImageMetadata } from "../files/image-metadata";
import { posterImageSize, sniffPosterFile } from "./posters";

type Tx = Prisma.TransactionClient;

export const WORKSHOP_NOT_FOUND = "That project no longer exists.";
export const WORKSHOP_PHOTO_NOT_FOUND = "That photo no longer exists.";
export const WORKSHOP_FILE_NOT_FOUND = "That file no longer exists.";
export const WORKSHOP_INACTIVE = "Your account isn't active, so you can't change Workshop projects.";
export const WORKSHOP_CANT_EDIT =
  "Only the person who added this project, the people credited on it, or a leader, captain, mentor, or teacher can change it.";
export const WORKSHOP_CANT_DELETE =
  "Only the person who added this project, or a leader, captain, mentor, or teacher, can remove it.";
export const WORKSHOP_CANT_REVIEW = "Only leaders, the captain, mentors, and teachers can approve projects for the team website.";
export const WORKSHOP_NEEDS_PHOTO = "Add at least one photo first: the team website shows it on the project's card.";
export const WORKSHOP_NOT_PENDING = "This project isn't waiting for approval any more. Refresh the page to see the latest.";
/** The page refreshes itself after this one (actions.ts), so it only asks for another look. */
export const WORKSHOP_CHANGED = "This project changed since you opened it. Look over the latest, then decide.";
export const WORKSHOP_LAST_PHOTO =
  "A project on the team website (or waiting for approval) needs a photo. Add another one first, or take the project off the website.";
const LINK_MESSAGE = "Enter a web link, like https://cad.onshape.com/documents/…";
const CODE_LINK_MESSAGE = "Enter a web link, like https://github.com/…";

const HOUR = 60 * 60 * 1000;
/** Photos and design files one person can upload per hour (each up to 4 MB). */
export const WORKSHOP_UPLOAD_RATE_LIMIT = { limit: 60, windowMs: HOUR } as const;
/** New projects one person can add per hour. */
export const WORKSHOP_CREATE_RATE_LIMIT = { limit: 30, windowMs: HOUR } as const;

/**
 * Workshop photos and design files one person can have uploaded (all projects together; removing old ones frees it
 * up again), so one account can't fill the team's storage (10× with Cloudflare R2: perPersonFileCap). Everyone with
 * admin access isn't limited.
 */
export const WORKSHOP_FILE_BYTES_PER_PERSON = 60 * 1024 * 1024;

// ---------- small helpers ----------

function asRecord(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

function requireActive(ctx: ServiceContext) {
  if (ctx.actor.status !== "ACTIVE") throw new ForbiddenError(WORKSHOP_INACTIVE);
}

/** "" = no link; otherwise an http(s) link (https:// added to a bare "cad.onshape.com/…"). */
function linkField(message: string) {
  return z.preprocess(
    (v) => (typeof v === "string" ? v : ""),
    z.string().transform((v, ctx) => {
      if (!v.trim()) return "";
      const url = parseHttpUrl(withHttps(v));
      if (!url) {
        ctx.addIssue({ code: "custom", message });
        return z.NEVER;
      }
      return url;
    }),
  );
}

// ---------- projects ----------

const projectFields = z.object({
  kind: z.enum(WORKSHOP_KINDS, { error: "Pick what kind of project it is." }),
  title: text("Name", WORKSHOP_LIMITS.titleMax),
  summary: text("What it does", WORKSHOP_LIMITS.summaryMax),
  material: optionalText("Material", WORKSHOP_LIMITS.materialMax),
  season: optionalText("Season", WORKSHOP_LIMITS.seasonMax),
  extraCredits: optionalText("Other people", WORKSHOP_LIMITS.extraCreditsMax),
  link: linkField(LINK_MESSAGE),
  codeLink: linkField(CODE_LINK_MESSAGE),
  creditIds: stringArray,
});

interface ProjectData {
  kind: (typeof WORKSHOP_KINDS)[number];
  title: string;
  summary: string;
  material: string;
  season: string;
  extraCredits: string;
  link: string;
  codeLink: string;
}

function parseProject(rec: Record<string, unknown>): { data: ProjectData; creditIds: string[] } {
  const f = parseInput(projectFields, rec);
  // Each person once, in the order picked.
  const creditIds = [...new Set(f.creditIds)];
  if (creditIds.length > WORKSHOP_LIMITS.creditsMax) {
    const message = `Credit up to ${WORKSHOP_LIMITS.creditsMax} people. Add anyone else under "Other people".`;
    throw new ValidationError(message, { creditIds: message });
  }
  return {
    data: {
      kind: f.kind,
      title: f.title,
      summary: f.summary,
      material: f.material ?? "",
      season: f.season ?? "",
      extraCredits: f.extraCredits ?? "",
      link: f.link,
      // Parts have no source code: the form doesn't offer it, and an old value never stays behind.
      codeLink: f.kind === "PART" ? "" : f.codeLink,
    },
    creditIds,
  };
}

/**
 * The people credited must be ACTIVE accounts — except people already credited (`keep`), who stay even after they've
 * left the team (they still designed it).
 */
async function assertCreditable(tx: Tx, creditIds: string[], keep: ReadonlySet<string> = new Set()): Promise<void> {
  const check = creditIds.filter((id) => !keep.has(id));
  if (check.length === 0) return;
  const found = await tx.user.count({ where: { id: { in: check }, status: "ACTIVE" } });
  if (found !== check.length) {
    const message = "Someone you picked isn't on the team any more. Refresh the page and pick again.";
    throw new ValidationError(message, { creditIds: message });
  }
}

/** A project and who can change it, for a change (missing → NotFound, not theirs → Forbidden). */
async function loadEditableProject(db: Tx, ctx: ServiceContext, projectId: string) {
  const project = await db.workshopProject.findUnique({
    where: { id: projectId },
    select: { id: true, title: true, status: true, createdById: true, coverPhotoId: true, credits: { select: { userId: true } } },
  });
  if (!project) throw new NotFoundError(WORKSHOP_NOT_FOUND);
  const creditUserIds = project.credits.map((c) => c.userId);
  if (!canEditWorkshopProject(ctx.actor, { createdById: project.createdById, creditUserIds })) throw new ForbiddenError(WORKSHOP_CANT_EDIT);
  return { ...project, creditUserIds };
}

/** Locks the project row until the transaction ends (counting photos, moving them, changing its status). */
async function lockProject(tx: Tx, projectId: string): Promise<void> {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "WorkshopProject" WHERE id = ${projectId} FOR UPDATE`;
  if (rows.length === 0) throw new NotFoundError(WORKSHOP_NOT_FOUND);
}

/**
 * After someone who isn't a reviewer added or rewrote something: an APPROVED project goes back to PENDING (off the
 * website until it's approved again). Also marks the project changed.
 */
async function touchProject(tx: Tx, ctx: ServiceContext, projectId: string, { needsApproval }: { needsApproval: boolean }): Promise<void> {
  const resubmit = needsApproval && !canReviewWorkshop(ctx.actor);
  await tx.workshopProject.update({ where: { id: projectId }, data: { updatedAt: ctx.now } });
  if (resubmit) {
    await tx.workshopProject.updateMany({ where: { id: projectId, status: "APPROVED" }, data: { status: "PENDING" } });
  }
}

export interface WorkshopChangeResult {
  id: string;
  /** The change took an approved project off the website until it's approved again. */
  sentForApproval: boolean;
}

export interface WorkshopProjectUpdate extends WorkshopChangeResult {
  /** The actor can still see the project (false after someone only credited on a draft takes their name off). */
  stillVisible: boolean;
}

async function statusOf(db: Tx, projectId: string) {
  return (await db.workshopProject.findUnique({ where: { id: projectId }, select: { status: true } }))?.status ?? null;
}

/** Add a project (a DRAFT; the person adding it is credited unless they unpick themselves). */
export async function createWorkshopProject(ctx: ServiceContext, raw: unknown): Promise<{ id: string }> {
  requireActive(ctx);
  const { data, creditIds } = parseProject(asRecord(raw));
  await enforceRateLimit(ctx.db, `workshop-create:${ctx.actor.id}`, WORKSHOP_CREATE_RATE_LIMIT.limit, WORKSHOP_CREATE_RATE_LIMIT.windowMs, ctx.now);
  await assertCreditable(ctx.db, creditIds);
  // One statement (the project and its credits together).
  return ctx.db.workshopProject.create({
    data: {
      ...data,
      status: "DRAFT",
      createdById: ctx.actor.id,
      createdAt: ctx.now,
      updatedAt: ctx.now,
      credits: { create: creditIds.map((userId, position) => ({ userId, position })) },
    },
    select: { id: true },
  });
}

const projectIdInput = z.object({ projectId: idSchema });

/**
 * The project as the reviewer saw it (its `updatedAt`, ISO), sent with Approve and Publish: if it changed since (a new
 * photo or file, new words), the decision is refused, so nothing goes public that a reviewer hasn't seen.
 */
const versionField = z.preprocess((v) => (v === "" || v === null ? undefined : v), z.iso.datetime({ error: "Refresh the page and try again." }).optional());
const decisionInput = z.object({ projectId: idSchema, version: versionField });

function assertVersion(version: string | undefined, updatedAt: Date): void {
  if (version !== undefined && new Date(version).getTime() !== updatedAt.getTime()) throw new ConflictError(WORKSHOP_CHANGED);
}

/** Change a project's details and credits. By someone who isn't a reviewer, an approved one goes back for approval. */
export async function updateWorkshopProject(ctx: ServiceContext, raw: unknown): Promise<WorkshopProjectUpdate> {
  requireActive(ctx);
  const rec = asRecord(raw);
  const { projectId } = parseInput(projectIdInput, rec);
  const existing = await loadEditableProject(ctx.db, ctx, projectId);
  const { data, creditIds } = parseProject(rec);

  await ctx.db.$transaction(async (tx) => {
    await lockProject(tx, projectId);
    await assertCreditable(tx, creditIds, new Set(existing.creditUserIds));
    const before = await tx.workshopProject.findUniqueOrThrow({
      where: { id: projectId },
      select: {
        kind: true,
        title: true,
        summary: true,
        material: true,
        season: true,
        extraCredits: true,
        link: true,
        codeLink: true,
        credits: { orderBy: { position: "asc" }, select: { userId: true } },
      },
    });
    const { credits, ...fields } = before;
    // Saved as it was: nothing to approve again.
    const changed =
      (Object.keys(data) as (keyof ProjectData)[]).some((k) => data[k] !== fields[k]) ||
      credits.map((c) => c.userId).join(",") !== creditIds.join(",");
    if (!changed) return;
    await tx.workshopProject.update({ where: { id: projectId }, data });
    await tx.workshopCredit.deleteMany({ where: { projectId } });
    if (creditIds.length > 0) {
      await tx.workshopCredit.createMany({ data: creditIds.map((userId, position) => ({ projectId, userId, position })) });
    }
    await touchProject(tx, ctx, projectId, { needsApproval: true });
  });
  const status = await statusOf(ctx.db, projectId);
  return {
    id: projectId,
    sentForApproval: existing.status === "APPROVED" && status === "PENDING",
    stillVisible:
      status === "APPROVED" ||
      canReviewWorkshop(ctx.actor) ||
      existing.createdById === ctx.actor.id ||
      creditIds.includes(ctx.actor.id),
  };
}

/** Remove a project with its photos and files: whoever added it, and reviewers. */
export async function deleteWorkshopProject(ctx: ServiceContext, raw: unknown): Promise<{ title: string }> {
  requireActive(ctx);
  const { projectId } = parseInput(projectIdInput, asRecord(raw));
  const project = await ctx.db.workshopProject.findUnique({ where: { id: projectId }, select: { title: true, createdById: true } });
  if (!project) throw new NotFoundError(WORKSHOP_NOT_FOUND);
  if (!canDeleteWorkshopProject(ctx.actor, project)) throw new ForbiddenError(WORKSHOP_CANT_DELETE);
  const { count } = await ctx.db.workshopProject.deleteMany({ where: { id: projectId } });
  if (count === 0) throw new NotFoundError(WORKSHOP_NOT_FOUND);
  return { title: project.title };
}

/**
 * Send a project for approval (DRAFT / REJECTED → PENDING), or, for reviewers, publish it straight to the website
 * (→ APPROVED). Needs at least one photo.
 */
export async function submitWorkshopProject(ctx: ServiceContext, raw: unknown): Promise<{ status: "PENDING" | "APPROVED" }> {
  requireActive(ctx);
  const { projectId, version } = parseInput(decisionInput, asRecord(raw));
  await loadEditableProject(ctx.db, ctx, projectId);
  const publish = canReviewWorkshop(ctx.actor);

  return ctx.db.$transaction(async (tx) => {
    await lockProject(tx, projectId);
    const project = await tx.workshopProject.findUniqueOrThrow({
      where: { id: projectId },
      select: { status: true, publishedAt: true, updatedAt: true, _count: { select: { photos: true } } },
    });
    if (project.status === "APPROVED") throw new ConflictError("This project is already on the team website.");
    if (publish) assertVersion(version, project.updatedAt);
    if (project.status === "PENDING" && !publish) throw new ConflictError("This project is already waiting for approval.");
    if (project._count.photos === 0) throw new ConflictError(WORKSHOP_NEEDS_PHOTO);
    if (publish) {
      await tx.workshopProject.update({
        where: { id: projectId },
        data: {
          status: "APPROVED",
          reviewNote: "",
          reviewedById: ctx.actor.id,
          reviewedAt: ctx.now,
          publishedAt: project.publishedAt ?? ctx.now,
          updatedAt: ctx.now,
        },
      });
      return { status: "APPROVED" as const };
    }
    await tx.workshopProject.update({ where: { id: projectId }, data: { status: "PENDING", updatedAt: ctx.now } });
    return { status: "PENDING" as const };
  });
}

const reviewInput = z.object({
  projectId: idSchema,
  version: versionField,
  decision: z.enum(["approve", "reject"], { error: "Choose approve or send back." }),
  note: optionalText("Note", WORKSHOP_LIMITS.reviewNoteMax),
});

/** Approve a project waiting for approval (→ on the website), or send it back with a note saying what to change. */
export async function reviewWorkshopProject(ctx: ServiceContext, raw: unknown): Promise<{ status: "APPROVED" | "REJECTED"; title: string }> {
  requireActive(ctx);
  if (!canReviewWorkshop(ctx.actor)) throw new ForbiddenError(WORKSHOP_CANT_REVIEW);
  const { projectId, decision, note, version } = parseInput(reviewInput, asRecord(raw));
  if (decision === "reject" && !note) {
    const message = "Say what needs to change, so they can fix it.";
    throw new ValidationError(message, { note: message });
  }
  return ctx.db.$transaction(async (tx) => {
    await lockProject(tx, projectId);
    const project = await tx.workshopProject.findUniqueOrThrow({
      where: { id: projectId },
      select: { status: true, title: true, publishedAt: true, updatedAt: true, _count: { select: { photos: true } } },
    });
    if (project.status !== "PENDING") throw new ConflictError(WORKSHOP_NOT_PENDING);
    assertVersion(version, project.updatedAt);
    if (decision === "approve") {
      if (project._count.photos === 0) throw new ConflictError(WORKSHOP_NEEDS_PHOTO);
      await tx.workshopProject.update({
        where: { id: projectId },
        data: {
          status: "APPROVED",
          reviewNote: "",
          reviewedById: ctx.actor.id,
          reviewedAt: ctx.now,
          publishedAt: project.publishedAt ?? ctx.now,
          updatedAt: ctx.now,
        },
      });
      return { status: "APPROVED" as const, title: project.title };
    }
    await tx.workshopProject.update({
      where: { id: projectId },
      data: { status: "REJECTED", reviewNote: note ?? "", reviewedById: ctx.actor.id, reviewedAt: ctx.now, updatedAt: ctx.now },
    });
    return { status: "REJECTED" as const, title: project.title };
  });
}

/** Take a project off the website, or back from waiting for approval (APPROVED / PENDING → DRAFT). */
export async function unpublishWorkshopProject(ctx: ServiceContext, raw: unknown): Promise<{ id: string }> {
  requireActive(ctx);
  const { projectId } = parseInput(projectIdInput, asRecord(raw));
  await loadEditableProject(ctx.db, ctx, projectId);
  const { count } = await ctx.db.workshopProject.updateMany({
    where: { id: projectId, status: { in: ["APPROVED", "PENDING"] } },
    data: { status: "DRAFT", updatedAt: ctx.now },
  });
  if (count === 0) throw new ConflictError("This project isn't on the website or waiting for approval. Refresh the page to see the latest.");
  return { id: projectId };
}

const featuredInput = z.object({ projectId: idSchema, featured: checkbox });

/** Show a project first in its section on the website (reviewers). */
export async function setWorkshopFeatured(ctx: ServiceContext, raw: unknown): Promise<{ featured: boolean }> {
  requireActive(ctx);
  if (!canReviewWorkshop(ctx.actor)) throw new ForbiddenError(WORKSHOP_CANT_REVIEW);
  const { projectId, featured } = parseInput(featuredInput, asRecord(raw));
  const { count } = await ctx.db.workshopProject.updateMany({ where: { id: projectId }, data: { featured, updatedAt: ctx.now } });
  if (count === 0) throw new NotFoundError(WORKSHOP_NOT_FOUND);
  return { featured };
}

// ---------- uploads (photos and design files) ----------

const PHOTO_KINDS = {
  png: { contentType: "image/png", extensions: ["png"] },
  jpg: { contentType: "image/jpeg", extensions: ["jpg", "jpeg"] },
  webp: { contentType: "image/webp", extensions: ["webp"] },
} as const;
type PhotoKind = keyof typeof PHOTO_KINDS;

/** HEIC/HEIF (iPhone photos) and AVIF: an ISO media file with an image brand. Browsers mostly can't show them. */
function isHeicLike(bytes: Uint8Array): boolean {
  if (bytes.length < 12 || String.fromCharCode(...bytes.subarray(4, 8)) !== "ftyp") return false;
  const brand = String.fromCharCode(...bytes.subarray(8, 12));
  return ["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1", "avif", "avis"].includes(brand);
}

/** "IMG_0001.HEIC" holding a JPEG → "IMG_0001.jpg". */
function withPhotoExtension(filename: string, kind: PhotoKind): string {
  const ext = workshopExtension(filename);
  const { extensions } = PHOTO_KINDS[kind];
  if ((extensions as readonly string[]).includes(ext)) return filename;
  const base = ext && /^[a-z][a-z0-9]{0,4}$/.test(ext) ? filename.slice(0, -(ext.length + 1)) : filename;
  return cleanFilename(`${base || "photo"}.${extensions[0]}`);
}

const PHOTO_UPLOAD_MESSAGES: UploadMessages = { tooBig: workshopPhotoTooBigMessage, blocked: () => WORKSHOP_PHOTO_TYPES_MESSAGE };
const FILE_UPLOAD_MESSAGES: UploadMessages = { tooBig: workshopFileTooBigMessage, blocked: () => WORKSHOP_FILE_TYPES_MESSAGE };

export interface CheckedPhoto {
  upload: CleanUpload;
  width: number;
  height: number;
}

/**
 * A picked photo: up to 4 MB, really a PNG, JPG, or WebP (by its bytes), with a readable size in pixels a phone can
 * draw. The stored name gets the matching extension and the stored type is the real one. Its metadata (EXIF with the
 * GPS position, XMP, comments…) is taken out — it's going on the public website — keeping only a JPEG's or PNG's orientation
 * (stripImageMetadata, ../files/image-metadata.ts); a sideways-stored photo (orientation 5–8) gets its width and height
 * swapped, as it's shown.
 */
export function checkWorkshopPhoto(value: unknown): CheckedPhoto | null {
  const picked = readUpload(value);
  if (!picked) return null;
  const upload = checkUploadedFile(picked, PHOTO_UPLOAD_MESSAGES);
  const sniffed = sniffPosterFile(upload.bytes);
  if (sniffed !== "png" && sniffed !== "jpg" && sniffed !== "webp") {
    throw fileError(isHeicLike(upload.bytes) ? WORKSHOP_PHOTO_HEIC_MESSAGE : WORKSHOP_PHOTO_TYPES_MESSAGE);
  }
  const size = posterImageSize(upload.bytes, sniffed);
  if (!size || size.width < 1 || size.height < 1) throw fileError(WORKSHOP_PHOTO_UNREADABLE_MESSAGE);
  if (size.width > POSTER_IMAGE_MAX_SIDE || size.height > POSTER_IMAGE_MAX_SIDE || size.width * size.height > POSTER_IMAGE_MAX_PIXELS) {
    throw fileError(posterImageTooLargeMessage(size.width, size.height));
  }
  const bytes = stripImageMetadata(upload.bytes, sniffed);
  const turned = imageOrientation(bytes, sniffed) >= 5;
  return {
    upload: {
      filename: withPhotoExtension(upload.filename, sniffed),
      contentType: PHOTO_KINDS[sniffed].contentType,
      bytes,
    },
    width: turned ? size.height : size.width,
    height: turned ? size.width : size.height,
  };
}

function startsWithAscii(bytes: Uint8Array, s: string): boolean {
  return bytes.length >= s.length && Array.from(s).every((c, i) => bytes[i] === c.charCodeAt(0));
}

/**
 * A picked design file: up to 4 MB, a CAD / printing / PDF / ZIP extension (WORKSHOP_FILE_EXTENSIONS), and for PDFs
 * and ZIP-based formats (ZIP, 3MF) the right first bytes. Stored as a download (application/octet-stream; PDFs as
 * application/pdf), whatever the browser said.
 */
export function checkWorkshopFile(value: unknown): CleanUpload | null {
  const picked = readUpload(value);
  if (!picked) return null;
  const upload = checkUploadedFile(picked, FILE_UPLOAD_MESSAGES);
  const ext = workshopExtension(upload.filename);
  if (!WORKSHOP_FILE_EXTENSIONS.has(ext)) throw fileError(WORKSHOP_FILE_TYPES_MESSAGE);
  if (ext === "pdf" && sniffPosterFile(upload.bytes) !== "pdf") {
    throw fileError("That file isn't a real PDF. Save it again as a PDF, or zip it.");
  }
  if ((ext === "zip" || ext === "3mf") && !startsWithAscii(upload.bytes, "PK")) {
    throw fileError(`That file isn't a real .${ext} file. Export it again, or add a link instead.`);
  }
  return { ...upload, contentType: ext === "pdf" ? "application/pdf" : "application/octet-stream" };
}

/**
 * Room for new uploads (under the storage lock): the person's own Workshop uploads stay under
 * WORKSHOP_FILE_BYTES_PER_PERSON (unless they have admin access), and all files together under the team's cap.
 * `locked: false`: the same checks without the lock (withStoredFiles' precheck before uploading to R2).
 */
async function assertWorkshopRoom(tx: Tx, ctx: ServiceContext, adding: number, locked = true): Promise<void> {
  if (locked) await lockFileStorage(tx);
  const objectStorage = usesObjectStorage(ctx);
  if (!canAdminister(ctx.actor)) {
    const photos = await tx.workshopPhoto.aggregate({ _sum: { size: true }, where: { uploadedById: ctx.actor.id } });
    const files = await tx.workshopFile.aggregate({ _sum: { size: true }, where: { uploadedById: ctx.actor.id } });
    const used = (photos._sum.size ?? 0) + (files._sum.size ?? 0);
    const allowance = perPersonFileCap(WORKSHOP_FILE_BYTES_PER_PERSON, objectStorage);
    if (used + adding > allowance) {
      throw fileError(
        `Your Workshop photos and files use ${formatFileSize(used)}, and each person can have up to ${formatFileSize(allowance)}. Remove ones you don't need, share big files with a link, or ask a leader to add this one.`,
      );
    }
  }
  await (locked ? assertFileStorageRoom : checkFileStorageRoom)(
    tx,
    { adding },
    (usage) =>
      `${storageFullSentence(usage)} Share the design with a link instead (Onshape, Printables, Google Drive), or ask a leader, the captain, a mentor, or a teacher to clear out old files.`,
    objectStorage,
  );
}

/**
 * A project has room for another photo / design file (WORKSHOP_LIMITS). Checked under the project's lock when saving,
 * and before uploading to Cloudflare R2 (withStoredFiles' precheck), so a refused upload is never sent there.
 */
async function assertPhotoPlace(db: Tx, projectId: string): Promise<void> {
  if ((await db.workshopPhoto.count({ where: { projectId } })) >= WORKSHOP_LIMITS.photosPerProject) {
    throw fileError(`A project can have up to ${WORKSHOP_LIMITS.photosPerProject} photos. Remove one first.`);
  }
}

async function assertFilePlace(db: Tx, projectId: string): Promise<void> {
  if ((await db.workshopFile.count({ where: { projectId } })) >= WORKSHOP_LIMITS.filesPerProject) {
    throw fileError(`A project can have up to ${WORKSHOP_LIMITS.filesPerProject} files. Zip some together, or remove one first.`);
  }
}

async function enforceUploadRate(ctx: ServiceContext): Promise<void> {
  await enforceRateLimit(ctx.db, `workshop-upload:${ctx.actor.id}`, WORKSHOP_UPLOAD_RATE_LIMIT.limit, WORKSHOP_UPLOAD_RATE_LIMIT.windowMs, ctx.now);
}

// ---------- photos ----------

const photoFields = z.object({
  label: optionalText("Label", WORKSHOP_LIMITS.photoLabelMax),
  note: optionalText("Note", WORKSHOP_LIMITS.photoNoteMax),
});

const addPhotoInput = photoFields.extend({ projectId: idSchema });

/** Add a photo at the end (the newest version last). By someone who isn't a reviewer, an approved project goes back for approval. */
export async function addWorkshopPhoto(ctx: ServiceContext, raw: unknown): Promise<WorkshopChangeResult & { photoId: string }> {
  requireActive(ctx);
  const rec = asRecord(raw);
  const { projectId, label, note } = parseInput(addPhotoInput, rec);
  const existing = await loadEditableProject(ctx.db, ctx, projectId);
  const photo = checkWorkshopPhoto(rec.file);
  if (!photo) throw fileError("Choose a photo to add.");
  await enforceUploadRate(ctx);

  const adding = photo.upload.bytes.byteLength;
  const photoId = await withStoredFiles(
    ctx,
    "workshop-photos",
    [photo.upload],
    ([file]) =>
      ctx.db.$transaction(async (tx) => {
        await lockProject(tx, projectId);
        await assertPhotoPlace(tx, projectId);
        const agg = await tx.workshopPhoto.aggregate({ where: { projectId }, _max: { position: true } });
        await assertWorkshopRoom(tx, ctx, adding);
        const created = await tx.workshopPhoto.create({
          data: {
            projectId,
            ...file,
            label: label ?? "",
            note: note ?? "",
            position: (agg._max.position ?? -1) + 1,
            width: photo.width,
            height: photo.height,
            uploadedById: ctx.actor.id,
            createdAt: ctx.now,
          },
          select: { id: true },
        });
        await touchProject(tx, ctx, projectId, { needsApproval: true });
        return created.id;
      }),
    {
      precheck: async () => {
        await assertPhotoPlace(ctx.db, projectId);
        await assertWorkshopRoom(ctx.db, ctx, adding, false);
      },
    },
  );
  return {
    id: projectId,
    photoId,
    sentForApproval: existing.status === "APPROVED" && (await statusOf(ctx.db, projectId)) === "PENDING",
  };
}

const photoIdInput = z.object({ photoId: idSchema });

/** Loads a photo with its project for a change (missing → NotFound, not theirs → Forbidden). */
async function loadEditablePhoto(ctx: ServiceContext, photoId: string) {
  const photo = await ctx.db.workshopPhoto.findUnique({ where: { id: photoId }, select: { id: true, projectId: true, label: true, note: true } });
  if (!photo) throw new NotFoundError(WORKSHOP_PHOTO_NOT_FOUND);
  const project = await loadEditableProject(ctx.db, ctx, photo.projectId);
  return { photo, project };
}

const updatePhotoInput = photoFields.extend({ photoId: idSchema });

/** Change a photo's label and note. A real change by someone who isn't a reviewer sends an approved project back for approval. */
export async function updateWorkshopPhoto(ctx: ServiceContext, raw: unknown): Promise<WorkshopChangeResult> {
  requireActive(ctx);
  const { photoId, label, note } = parseInput(updatePhotoInput, asRecord(raw));
  const { photo, project } = await loadEditablePhoto(ctx, photoId);
  const next = { label: label ?? "", note: note ?? "" };
  const changed = next.label !== photo.label || next.note !== photo.note;
  await ctx.db.$transaction(async (tx) => {
    await lockProject(tx, photo.projectId); // the project first, then its rows (like every other change)
    const { count } = await tx.workshopPhoto.updateMany({ where: { id: photoId, projectId: photo.projectId }, data: next });
    if (count === 0) throw new NotFoundError(WORKSHOP_PHOTO_NOT_FOUND);
    if (changed) await touchProject(tx, ctx, photo.projectId, { needsApproval: true });
  });
  return {
    id: photo.projectId,
    sentForApproval: changed && project.status === "APPROVED" && (await statusOf(ctx.db, photo.projectId)) === "PENDING",
  };
}

const movePhotoInput = z.object({ photoId: idSchema, direction: z.enum(["up", "down"], { error: "Choose up or down." }) });

/** Move a photo one place earlier ("up") or later ("down") in the story. Doesn't need approval. */
export async function moveWorkshopPhoto(ctx: ServiceContext, raw: unknown): Promise<{ id: string }> {
  requireActive(ctx);
  const { photoId, direction } = parseInput(movePhotoInput, asRecord(raw));
  const { photo } = await loadEditablePhoto(ctx, photoId);
  await ctx.db.$transaction(async (tx) => {
    await lockProject(tx, photo.projectId);
    const photos = await tx.workshopPhoto.findMany({
      where: { projectId: photo.projectId },
      orderBy: [{ position: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      select: { id: true },
    });
    const from = photos.findIndex((p) => p.id === photoId);
    if (from < 0) throw new NotFoundError(WORKSHOP_PHOTO_NOT_FOUND);
    const to = direction === "up" ? from - 1 : from + 1;
    if (to < 0 || to >= photos.length) return; // already first / last
    const order = photos.map((p) => p.id);
    [order[from], order[to]] = [order[to], order[from]];
    // Renumber 0..n-1, so positions stay simple however photos were added and removed.
    for (const [position, id] of order.entries()) {
      await tx.workshopPhoto.update({ where: { id }, data: { position } });
    }
    await touchProject(tx, ctx, photo.projectId, { needsApproval: false });
  });
  return { id: photo.projectId };
}

/** Make a photo the cover (the one the website shows first). Doesn't need approval. */
export async function setWorkshopCover(ctx: ServiceContext, raw: unknown): Promise<{ id: string }> {
  requireActive(ctx);
  const { photoId } = parseInput(photoIdInput, asRecord(raw));
  const { photo } = await loadEditablePhoto(ctx, photoId);
  await ctx.db.$transaction(async (tx) => {
    await lockProject(tx, photo.projectId);
    // Still this project's photo (it can't have moved, but it can have been removed meanwhile).
    const still = await tx.workshopPhoto.count({ where: { id: photoId, projectId: photo.projectId } });
    if (still === 0) throw new NotFoundError(WORKSHOP_PHOTO_NOT_FOUND);
    await tx.workshopProject.update({ where: { id: photo.projectId }, data: { coverPhotoId: photoId } });
    await touchProject(tx, ctx, photo.projectId, { needsApproval: false });
  });
  return { id: photo.projectId };
}

/**
 * Remove a photo. Doesn't need approval, but a project on the website (or waiting for approval) keeps at least one.
 * Removing the cover goes back to the default cover (defaultCoverIndex: a part's newest version, others' first photo).
 */
export async function removeWorkshopPhoto(ctx: ServiceContext, raw: unknown): Promise<{ id: string }> {
  requireActive(ctx);
  const { photoId } = parseInput(photoIdInput, asRecord(raw));
  const { photo } = await loadEditablePhoto(ctx, photoId);
  await ctx.db.$transaction(async (tx) => {
    await lockProject(tx, photo.projectId);
    const project = await tx.workshopProject.findUniqueOrThrow({
      where: { id: photo.projectId },
      select: { status: true, _count: { select: { photos: true } } },
    });
    if ((project.status === "APPROVED" || project.status === "PENDING") && project._count.photos <= 1) {
      throw new ConflictError(WORKSHOP_LAST_PHOTO);
    }
    const { count } = await tx.workshopPhoto.deleteMany({ where: { id: photoId, projectId: photo.projectId } });
    if (count === 0) throw new NotFoundError(WORKSHOP_PHOTO_NOT_FOUND);
    await touchProject(tx, ctx, photo.projectId, { needsApproval: false });
  });
  return { id: photo.projectId };
}

// ---------- design files ----------

const addFileInput = z.object({ projectId: idSchema, label: optionalText("Label", WORKSHOP_LIMITS.fileLabelMax) });

/** Add a design file anyone can download from the website. By someone who isn't a reviewer, an approved project goes back for approval. */
export async function addWorkshopFile(ctx: ServiceContext, raw: unknown): Promise<WorkshopChangeResult & { fileId: string }> {
  requireActive(ctx);
  const rec = asRecord(raw);
  const { projectId, label } = parseInput(addFileInput, rec);
  const existing = await loadEditableProject(ctx.db, ctx, projectId);
  const upload = checkWorkshopFile(rec.file);
  if (!upload) throw fileError("Choose a file to add.");
  await enforceUploadRate(ctx);

  const adding = upload.bytes.byteLength;
  const fileId = await withStoredFiles(
    ctx,
    "workshop-files",
    [upload],
    ([file]) =>
      ctx.db.$transaction(async (tx) => {
        await lockProject(tx, projectId);
        await assertFilePlace(tx, projectId);
        await assertWorkshopRoom(tx, ctx, adding);
        const created = await tx.workshopFile.create({
          data: { projectId, ...file, label: label ?? "", uploadedById: ctx.actor.id, createdAt: ctx.now },
          select: { id: true },
        });
        await touchProject(tx, ctx, projectId, { needsApproval: true });
        return created.id;
      }),
    {
      precheck: async () => {
        await assertFilePlace(ctx.db, projectId);
        await assertWorkshopRoom(ctx.db, ctx, adding, false);
      },
    },
  );
  return {
    id: projectId,
    fileId,
    sentForApproval: existing.status === "APPROVED" && (await statusOf(ctx.db, projectId)) === "PENDING",
  };
}

const fileIdInput = z.object({ fileId: idSchema });

/** Remove a design file. Doesn't need approval. */
export async function removeWorkshopFile(ctx: ServiceContext, raw: unknown): Promise<{ id: string }> {
  requireActive(ctx);
  const { fileId } = parseInput(fileIdInput, asRecord(raw));
  const file = await ctx.db.workshopFile.findUnique({ where: { id: fileId }, select: { projectId: true } });
  if (!file) throw new NotFoundError(WORKSHOP_FILE_NOT_FOUND);
  await loadEditableProject(ctx.db, ctx, file.projectId);
  await ctx.db.$transaction(async (tx) => {
    await lockProject(tx, file.projectId); // the project first, then its rows (like every other change)
    const { count } = await tx.workshopFile.deleteMany({ where: { id: fileId, projectId: file.projectId } });
    if (count === 0) throw new NotFoundError(WORKSHOP_FILE_NOT_FOUND);
    await touchProject(tx, ctx, file.projectId, { needsApproval: false });
  });
  return { id: file.projectId };
}
