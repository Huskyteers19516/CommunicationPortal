// Team notebook (/notebook): the team's engineering notebooks (Hardware → Intake, Outtake; Software → …), split
// into pages, each page a list of dated entries.
// - The captain and other all-scope staff add, change, reorder, and delete notebooks (canManageNotebooks), and can
//   set up the standard ones in one click when there are none (createStandardNotebooks).
// - A notebook's pages are managed by all-scope staff plus the leaders of the notebook's subteam (canManageNotebookPages).
// - Everyone ACTIVE writes entries. The date/time and the author are stamped by the server, never taken from the form.
//   Whoever wrote an entry, and the people who manage its notebook's pages, change or remove it (canEditNotebookEntry;
//   subteam leaders not entries by the captain, mentors, teachers, or owners).
//   Every change to the text is logged (NotebookEntryEdit: who, when, and what it said before) and shown as "Edited by".
//   The same people can take an old version's text out of the history (clearNotebookEntryVersion), e.g. a phone
//   number pasted by mistake; who changed it and when stay.
// - Entries can have pictures (NotebookImage): PNG, JPG, GIF, or WebP only, checked by their contents like posters,
//   up to 4 MB and LIMITS.notebookImagesPerEntry each, stored like every upload (Postgres, or Cloudflare R2 when it's
//   set up: ../files/stored.ts), counted toward the team's shared file storage (under its lock), and each person's
//   pictures stay under NOTEBOOK_IMAGE_BYTES_PER_PERSON (10× with R2) unless they manage that notebook's pages.
//   Adding or taking off a picture marks the entry "Edited by" and logs a history row with the text unchanged
//   ("changed the pictures"), except while its author is still writing it (NOTEBOOK_WRITING_WINDOW_MS after posting
//   it, before anyone edits it: the editor uploads pictures right after the text).
//
// Order changes (notebooks, and each notebook's pages) take a transaction-scoped advisory lock and renumber 0..n-1.
import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { Subteam } from "@/generated/prisma/enums";
import { LIMITS } from "@/lib/constants";
import { formatFileSize } from "@/lib/files";
import {
  NOTEBOOK_DESCRIPTION_MAX,
  NOTEBOOK_EMOJI_MAX,
  NOTEBOOK_PICTURE_HEIC_MESSAGE,
  NOTEBOOK_PICTURE_TYPES_MESSAGE,
  NOTEBOOK_PICTURE_UNREADABLE_MESSAGE,
  notebookPicturesFullMessage,
  notebookPictureTooBigMessage,
  STANDARD_NOTEBOOKS,
} from "@/lib/notebook";
import { POSTER_IMAGE_MAX_PIXELS, POSTER_IMAGE_MAX_SIDE, posterImageTooLargeMessage } from "@/lib/posters";
import { idSchema, normalizeLineBreaks, optionalText, text } from "@/lib/validation";
import { parseInput } from "../action";
import type { ServiceContext } from "../context";
import { ConflictError, ForbiddenError, NotFoundError } from "../errors";
import {
  assertFileStorageRoom,
  checkFileStorageRoom,
  lockFileStorage,
  perPersonFileCap,
  posterCleanupSentence,
  storageFullSentence,
} from "../files/storage";
import { usesObjectStorage, withStoredFiles } from "../files/stored";
import { checkUploadedFile, cleanFilename, type CleanUpload, fileError, readUpload, type UploadMessages } from "../files/upload";
import { canEditNotebookEntry, canManageNotebookPages, canManageNotebooks } from "../permissions";
import { enforceRateLimit } from "../rate-limit";
import { fileExtension } from "../resources/serve";
import { posterImageSize, sniffPosterFile } from "./posters";

type Tx = Prisma.TransactionClient;

export const NOTEBOOK_INACTIVE = "Your account isn't active, so you can't change the notebook.";
export const NOTEBOOK_MANAGERS_ONLY = "Only the captain, mentors, and teachers can add, change, or remove notebooks.";
export const NOTEBOOK_PAGES_MANAGERS_ONLY =
  "Only this notebook's subteam leaders, the captain, mentors, and teachers can add, change, or remove its pages.";
export const NOTEBOOK_ENTRY_CANT_EDIT =
  "Only the person who wrote this entry, or this notebook's leaders, the captain, mentors, and teachers, can change it.";
export const NOTEBOOK_NOT_FOUND = "That notebook no longer exists.";
export const NOTEBOOK_PAGE_NOT_FOUND = "That page no longer exists.";
export const NOTEBOOK_ENTRY_NOT_FOUND = "That entry no longer exists.";
export const NOTEBOOK_IMAGE_NOT_FOUND = "That picture was already taken off.";
export const NOTEBOOK_VERSION_NOT_FOUND = "That version is no longer in the history.";
export const NOTEBOOK_STANDARD_EXISTS = "The notebooks are already set up. Add more with “New notebook”.";
export const NOTEBOOK_ENTRY_EMPTY = "Write something for the entry.";

/** Most notebooks, and most pages in one notebook (plenty for a season; keeps the outline readable). */
export const NOTEBOOKS_MAX = 30;
export const NOTEBOOK_PAGES_MAX = 60;

const HOUR = 60 * 60 * 1000;
/** New entries and edits per person per hour. */
export const NOTEBOOK_WRITE_RATE_LIMIT = { limit: 120, windowMs: HOUR } as const;
/** Pictures added per person per hour (each can be up to 4 MB). */
export const NOTEBOOK_IMAGE_RATE_LIMIT = { limit: 60, windowMs: HOUR } as const;
/**
 * Notebook pictures one person can have (on the entries they wrote), so one account can't fill the team's storage
 * (10× with Cloudflare R2: perPersonFileCap). People who manage a notebook's pages aren't limited there.
 */
export const NOTEBOOK_IMAGE_BYTES_PER_PERSON = 25 * 1024 * 1024;
/** Pictures the author adds or takes off this soon after posting (before anyone edits it) don't mark it edited. */
export const NOTEBOOK_WRITING_WINDOW_MS = 15 * 60 * 1000;
/** Picture changes by the same person this close together make one "changed the pictures" line in the history. */
export const NOTEBOOK_PICTURE_EDIT_MERGE_MS = 10 * 60 * 1000;

// ---------- helpers ----------

function asRecord(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

function requireActive(ctx: ServiceContext) {
  if (ctx.actor.status !== "ACTIVE") throw new ForbiddenError(NOTEBOOK_INACTIVE);
}

function requireNotebookManager(ctx: ServiceContext) {
  requireActive(ctx);
  if (!canManageNotebooks(ctx.actor)) throw new ForbiddenError(NOTEBOOK_MANAGERS_ONLY);
}

/** Serializes changes to the order of the notebooks until the transaction ends. */
async function lockNotebookOrder(tx: Tx): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('notebook-order'))`;
}

/** Serializes changes to the order of one notebook's pages until the transaction ends. */
async function lockPageOrder(tx: Tx, notebookId: string): Promise<void> {
  const key = `notebook-pages:${notebookId}`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
}

/** Moves `id` one step in `ids` (already in order); the new order, or null when it's already at that end (or missing). */
function moved(ids: string[], id: string, direction: "up" | "down"): string[] | null {
  const from = ids.indexOf(id);
  if (from === -1) return null;
  const to = direction === "up" ? from - 1 : from + 1;
  if (to < 0 || to >= ids.length) return null;
  const order = [...ids];
  order.splice(from, 1);
  order.splice(to, 0, id);
  return order;
}

const directionInput = z.enum(["up", "down"], { error: "Pick up or down." });

// ---------- notebooks ----------

/** "" / missing = the whole team's notebook. */
const subteamField = z.preprocess(
  (v) => (v === undefined || v === null || v === "" ? null : v),
  z.enum(Subteam, { error: "Pick whose notebook it is." }).nullable(),
);

const notebookFields = z.object({
  title: text("Title", LIMITS.notebookTitleMax),
  emoji: optionalText("Emoji", NOTEBOOK_EMOJI_MAX),
  description: optionalText("Description", NOTEBOOK_DESCRIPTION_MAX),
  subteam: subteamField,
});
const notebookIdInput = z.object({ notebookId: idSchema });
const moveNotebookInput = z.object({ notebookId: idSchema, direction: directionInput });

function notebookColumns(data: z.infer<typeof notebookFields>) {
  return { title: data.title, emoji: data.emoji ?? "", description: data.description ?? "", subteam: data.subteam };
}

/** Add a notebook at the end of the list (captain, mentors, teachers, owners). */
export async function createNotebook(ctx: ServiceContext, raw: unknown): Promise<{ id: string }> {
  requireNotebookManager(ctx);
  const data = parseInput(notebookFields, asRecord(raw));
  return ctx.db.$transaction(async (tx) => {
    await lockNotebookOrder(tx);
    const count = await tx.notebook.count();
    if (count >= NOTEBOOKS_MAX) {
      throw new ConflictError(`There are already ${NOTEBOOKS_MAX} notebooks, the most there can be. Remove one you don't use first.`);
    }
    const last = await tx.notebook.aggregate({ _max: { position: true } });
    return tx.notebook.create({
      data: { ...notebookColumns(data), position: (last._max.position ?? -1) + 1, createdById: ctx.actor.id, createdAt: ctx.now },
      select: { id: true },
    });
  });
}

/** Change a notebook's title, emoji, description, or whose it is. */
export async function updateNotebook(ctx: ServiceContext, raw: unknown): Promise<{ id: string }> {
  requireNotebookManager(ctx);
  const rec = asRecord(raw);
  const { notebookId } = parseInput(notebookIdInput, rec);
  const data = parseInput(notebookFields, rec);
  const { count } = await ctx.db.notebook.updateMany({ where: { id: notebookId }, data: notebookColumns(data) });
  if (count === 0) throw new NotFoundError(NOTEBOOK_NOT_FOUND);
  return { id: notebookId };
}

/** Delete a notebook with all its pages, entries, and pictures. Returns what went, for the confirmation. */
export async function deleteNotebook(
  ctx: ServiceContext,
  raw: unknown,
): Promise<{ title: string; pages: number; entries: number }> {
  requireNotebookManager(ctx);
  const { notebookId } = parseInput(notebookIdInput, asRecord(raw));
  return ctx.db.$transaction(async (tx) => {
    await lockNotebookOrder(tx);
    const notebook = await tx.notebook.findUnique({ where: { id: notebookId }, select: { title: true, _count: { select: { pages: true } } } });
    if (!notebook) throw new NotFoundError(NOTEBOOK_NOT_FOUND);
    const entries = await tx.notebookEntry.count({ where: { page: { notebookId } } });
    await tx.notebook.delete({ where: { id: notebookId } }); // pages, entries, edits, and pictures cascade
    return { title: notebook.title, pages: notebook._count.pages, entries };
  });
}

/** Move a notebook one place up or down the list. Already at that end: nothing changes. */
export async function moveNotebook(ctx: ServiceContext, raw: unknown): Promise<void> {
  requireNotebookManager(ctx);
  const { notebookId, direction } = parseInput(moveNotebookInput, asRecord(raw));
  await ctx.db.$transaction(async (tx) => {
    await lockNotebookOrder(tx);
    const rows = await tx.notebook.findMany({ orderBy: [{ position: "asc" }, { createdAt: "asc" }, { id: "asc" }], select: { id: true } });
    const ids = rows.map((r) => r.id);
    if (!ids.includes(notebookId)) throw new NotFoundError(NOTEBOOK_NOT_FOUND);
    const order = moved(ids, notebookId, direction);
    if (!order) return;
    const positions = order.map((_, i) => i);
    await tx.$executeRaw`
      UPDATE "Notebook" AS n SET "position" = v.position
      FROM unnest(${order}::text[], ${positions}::int[]) AS v(id, position)
      WHERE n.id = v.id AND n."position" <> v.position`;
  });
}

/**
 * One click for a new season: the team's usual notebooks and pages (STANDARD_NOTEBOOKS), only while there are
 * no notebooks at all (a second click, or two managers at once, is a ConflictError).
 */
export async function createStandardNotebooks(ctx: ServiceContext): Promise<{ count: number }> {
  requireNotebookManager(ctx);
  return ctx.db.$transaction(async (tx) => {
    await lockNotebookOrder(tx);
    if ((await tx.notebook.count()) > 0) throw new ConflictError(NOTEBOOK_STANDARD_EXISTS);
    for (const [position, nb] of STANDARD_NOTEBOOKS.entries()) {
      await tx.notebook.create({
        data: {
          title: nb.title,
          emoji: nb.emoji,
          description: nb.description,
          subteam: nb.subteam,
          position,
          createdById: ctx.actor.id,
          createdAt: ctx.now,
          pages: {
            create: nb.pages.map((title, i) => ({ title, position: i, createdById: ctx.actor.id, createdAt: ctx.now })),
          },
        },
        select: { id: true },
      });
    }
    return { count: STANDARD_NOTEBOOKS.length };
  });
}

// ---------- pages ----------

const pageTitle = text("Page name", LIMITS.notebookPageTitleMax);
const createPageInput = z.object({ notebookId: idSchema, title: pageTitle });
const renamePageInput = z.object({ pageId: idSchema, title: pageTitle });
const pageIdInput = z.object({ pageId: idSchema });
const movePageInput = z.object({ pageId: idSchema, direction: directionInput });

async function loadNotebookForPages(ctx: ServiceContext, notebookId: string) {
  const notebook = await ctx.db.notebook.findUnique({ where: { id: notebookId }, select: { id: true, subteam: true } });
  if (!notebook) throw new NotFoundError(NOTEBOOK_NOT_FOUND);
  if (!canManageNotebookPages(ctx.actor, notebook)) throw new ForbiddenError(NOTEBOOK_PAGES_MANAGERS_ONLY);
  return notebook;
}

async function loadPageForManaging(ctx: ServiceContext, pageId: string) {
  const page = await ctx.db.notebookPage.findUnique({
    where: { id: pageId },
    select: { id: true, title: true, notebookId: true, notebook: { select: { subteam: true } } },
  });
  if (!page) throw new NotFoundError(NOTEBOOK_PAGE_NOT_FOUND);
  if (!canManageNotebookPages(ctx.actor, page.notebook)) throw new ForbiddenError(NOTEBOOK_PAGES_MANAGERS_ONLY);
  return page;
}

/** Add a page at the end of a notebook (its subteam's leaders, and all-scope staff). */
export async function createNotebookPage(ctx: ServiceContext, raw: unknown): Promise<{ id: string }> {
  requireActive(ctx);
  const { notebookId, title } = parseInput(createPageInput, asRecord(raw));
  await loadNotebookForPages(ctx, notebookId);
  return ctx.db.$transaction(async (tx) => {
    await lockPageOrder(tx, notebookId);
    // Holds the notebook until this commits, so it can't be deleted between the check and the insert.
    const held = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Notebook" WHERE id = ${notebookId} FOR KEY SHARE`;
    if (held.length === 0) throw new NotFoundError(NOTEBOOK_NOT_FOUND);
    const count = await tx.notebookPage.count({ where: { notebookId } });
    if (count >= NOTEBOOK_PAGES_MAX) {
      throw new ConflictError(`This notebook already has ${NOTEBOOK_PAGES_MAX} pages, the most it can have.`);
    }
    const last = await tx.notebookPage.aggregate({ where: { notebookId }, _max: { position: true } });
    return tx.notebookPage.create({
      data: { notebookId, title, position: (last._max.position ?? -1) + 1, createdById: ctx.actor.id, createdAt: ctx.now },
      select: { id: true },
    });
  });
}

/** Rename a page. */
export async function renameNotebookPage(ctx: ServiceContext, raw: unknown): Promise<{ id: string }> {
  requireActive(ctx);
  const { pageId, title } = parseInput(renamePageInput, asRecord(raw));
  await loadPageForManaging(ctx, pageId);
  const { count } = await ctx.db.notebookPage.updateMany({ where: { id: pageId }, data: { title } });
  if (count === 0) throw new NotFoundError(NOTEBOOK_PAGE_NOT_FOUND);
  return { id: pageId };
}

/** Delete a page with all its entries and pictures. Returns what went, for the confirmation. */
export async function deleteNotebookPage(
  ctx: ServiceContext,
  raw: unknown,
): Promise<{ title: string; notebookId: string; entries: number }> {
  requireActive(ctx);
  const { pageId } = parseInput(pageIdInput, asRecord(raw));
  const page = await loadPageForManaging(ctx, pageId);
  return ctx.db.$transaction(async (tx) => {
    await lockPageOrder(tx, page.notebookId);
    const entries = await tx.notebookEntry.count({ where: { pageId } });
    const { count } = await tx.notebookPage.deleteMany({ where: { id: pageId } });
    if (count === 0) throw new NotFoundError(NOTEBOOK_PAGE_NOT_FOUND);
    return { title: page.title, notebookId: page.notebookId, entries };
  });
}

/** Move a page one place up or down in its notebook. */
export async function moveNotebookPage(ctx: ServiceContext, raw: unknown): Promise<void> {
  requireActive(ctx);
  const { pageId, direction } = parseInput(movePageInput, asRecord(raw));
  const page = await loadPageForManaging(ctx, pageId);
  await ctx.db.$transaction(async (tx) => {
    await lockPageOrder(tx, page.notebookId);
    const rows = await tx.notebookPage.findMany({
      where: { notebookId: page.notebookId },
      orderBy: [{ position: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      select: { id: true },
    });
    const ids = rows.map((r) => r.id);
    if (!ids.includes(pageId)) throw new NotFoundError(NOTEBOOK_PAGE_NOT_FOUND);
    const order = moved(ids, pageId, direction);
    if (!order) return;
    const positions = order.map((_, i) => i);
    await tx.$executeRaw`
      UPDATE "NotebookPage" AS p SET "position" = v.position
      FROM unnest(${order}::text[], ${positions}::int[]) AS v(id, position)
      WHERE p.id = v.id AND p."position" <> v.position`;
  });
}

// ---------- entries ----------

const entryBody = z
  .string({ error: NOTEBOOK_ENTRY_EMPTY })
  .overwrite(normalizeLineBreaks)
  .trim()
  .min(1, NOTEBOOK_ENTRY_EMPTY)
  .max(LIMITS.notebookEntryBodyMax, `Keep the entry under ${LIMITS.notebookEntryBodyMax.toLocaleString("en-US")} characters, or split it into two entries.`);
const entryFields = {
  title: optionalText("Title", LIMITS.notebookEntryTitleMax),
  body: entryBody,
};
const createEntryInput = z.object({ pageId: idSchema, ...entryFields });
const updateEntryInput = z.object({ entryId: idSchema, ...entryFields });
const entryIdInput = z.object({ entryId: idSchema });

/** An entry with what's needed to check who may change it. */
async function loadEditableEntry(ctx: ServiceContext, entryId: string) {
  const entry = await ctx.db.notebookEntry.findUnique({
    where: { id: entryId },
    select: {
      id: true,
      pageId: true,
      title: true,
      body: true,
      authorId: true,
      createdAt: true,
      lastEditedAt: true,
      author: { select: { role: true, isAdmin: true } },
      page: { select: { notebook: { select: { subteam: true } } } },
    },
  });
  if (!entry) throw new NotFoundError(NOTEBOOK_ENTRY_NOT_FOUND);
  if (!canEditNotebookEntry(ctx.actor, entry, entry.page.notebook)) throw new ForbiddenError(NOTEBOOK_ENTRY_CANT_EDIT);
  return entry;
}

/** The author is still writing it (see NOTEBOOK_WRITING_WINDOW_MS): picture changes are part of posting it. */
function stillWriting(ctx: ServiceContext, entry: { authorId: string | null; createdAt: Date; lastEditedAt: Date | null }): boolean {
  const age = ctx.now.getTime() - entry.createdAt.getTime();
  return entry.authorId === ctx.actor.id && entry.lastEditedAt === null && age >= 0 && age < NOTEBOOK_WRITING_WINDOW_MS;
}

async function limitWrites(ctx: ServiceContext) {
  const { limit, windowMs } = NOTEBOOK_WRITE_RATE_LIMIT;
  await enforceRateLimit(ctx.db, `notebook-write:${ctx.actor.id}`, limit, windowMs, ctx.now);
}

/** Locks an entry's row until the transaction ends; its title and text (NotFoundError when it's gone). */
async function lockEntry(tx: Tx, entryId: string): Promise<{ title: string; body: string }> {
  const rows = await tx.$queryRaw<{ title: string; body: string }[]>`
    SELECT title, body FROM "NotebookEntry" WHERE id = ${entryId} FOR UPDATE`;
  if (!rows[0]) throw new NotFoundError(NOTEBOOK_ENTRY_NOT_FOUND);
  return rows[0];
}

/** Write an entry on a page (anyone ACTIVE). The date/time and author are stamped here, not taken from the form. */
export async function createNotebookEntry(ctx: ServiceContext, raw: unknown): Promise<{ id: string; pageId: string }> {
  requireActive(ctx);
  const data = parseInput(createEntryInput, asRecord(raw));
  const page = await ctx.db.notebookPage.findUnique({ where: { id: data.pageId }, select: { id: true } });
  if (!page) throw new NotFoundError(NOTEBOOK_PAGE_NOT_FOUND);
  await limitWrites(ctx);
  return ctx.db.$transaction(async (tx) => {
    // Holds the page until this commits, so it can't be deleted between the check and the insert.
    const held = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "NotebookPage" WHERE id = ${data.pageId} FOR KEY SHARE`;
    if (held.length === 0) throw new NotFoundError(NOTEBOOK_PAGE_NOT_FOUND);
    return tx.notebookEntry.create({
      data: { pageId: data.pageId, title: data.title ?? "", body: data.body, authorId: ctx.actor.id, createdAt: ctx.now },
      select: { id: true, pageId: true },
    });
  });
}

/**
 * Change an entry's title or text. What it said before goes into its history (who changed it, when), and it's
 * marked "Edited by" them. Saving it unchanged changes nothing (`changed: false`). Last save wins; nothing is lost,
 * since every earlier version is in the history.
 */
export async function updateNotebookEntry(
  ctx: ServiceContext,
  raw: unknown,
): Promise<{ id: string; pageId: string; changed: boolean }> {
  requireActive(ctx);
  const data = parseInput(updateEntryInput, asRecord(raw));
  const entry = await loadEditableEntry(ctx, data.entryId);
  const title = data.title ?? "";
  const unchanged = { id: entry.id, pageId: entry.pageId, changed: false };
  // Saving it unchanged (or "Save again" to retry pictures) doesn't use up one of the hourly writes. Older entries
  // may still have the CRLF line breaks forms send; the same text with "\n" is unchanged too.
  const same = (saved: { title: string; body: string }) => saved.title === title && normalizeLineBreaks(saved.body) === data.body;
  if (same(entry)) return unchanged;
  await limitWrites(ctx);
  return ctx.db.$transaction(async (tx) => {
    // Locks the row, so the history records exactly what this save replaced (even with two saves at once).
    const current = await lockEntry(tx, entry.id);
    if (same(current)) return unchanged;
    await tx.notebookEntryEdit.create({
      data: { entryId: entry.id, editorId: ctx.actor.id, editedAt: ctx.now, previousTitle: current.title, previousBody: current.body },
    });
    await tx.notebookEntry.update({
      where: { id: entry.id },
      data: { title, body: data.body, lastEditedById: ctx.actor.id, lastEditedAt: ctx.now },
    });
    return { id: entry.id, pageId: entry.pageId, changed: true };
  });
}

/** Remove an entry with its pictures and history. */
export async function deleteNotebookEntry(ctx: ServiceContext, raw: unknown): Promise<{ pageId: string }> {
  requireActive(ctx);
  const { entryId } = parseInput(entryIdInput, asRecord(raw));
  const entry = await loadEditableEntry(ctx, entryId);
  const { count } = await ctx.db.notebookEntry.deleteMany({ where: { id: entryId } });
  if (count === 0) throw new NotFoundError(NOTEBOOK_ENTRY_NOT_FOUND);
  return { pageId: entry.pageId };
}

const editIdInput = z.object({ editId: idSchema });

/**
 * Take an old version's title and text out of an entry's history (a phone number or password pasted by mistake):
 * whoever can change the entry. The line saying who changed it and when stays; the page says the text was taken out
 * (isClearedNotebookVersion).
 */
export async function clearNotebookEntryVersion(ctx: ServiceContext, raw: unknown): Promise<{ entryId: string; pageId: string }> {
  requireActive(ctx);
  const { editId } = parseInput(editIdInput, asRecord(raw));
  const edit = await ctx.db.notebookEntryEdit.findUnique({ where: { id: editId }, select: { entryId: true } });
  if (!edit) throw new NotFoundError(NOTEBOOK_VERSION_NOT_FOUND);
  const entry = await loadEditableEntry(ctx, edit.entryId);
  await limitWrites(ctx);
  const { count } = await ctx.db.notebookEntryEdit.updateMany({ where: { id: editId }, data: { previousTitle: "", previousBody: "" } });
  if (count === 0) throw new NotFoundError(NOTEBOOK_VERSION_NOT_FOUND);
  return { entryId: entry.id, pageId: entry.pageId };
}

// ---------- pictures ----------

type PictureKind = "png" | "jpg" | "gif" | "webp";

const PICTURE_INFO: Record<PictureKind, { contentType: string; extensions: string[] }> = {
  png: { contentType: "image/png", extensions: ["png"] },
  jpg: { contentType: "image/jpeg", extensions: ["jpg", "jpeg"] },
  gif: { contentType: "image/gif", extensions: ["gif"] },
  webp: { contentType: "image/webp", extensions: ["webp"] },
};

const PICTURE_UPLOAD_MESSAGES: UploadMessages = {
  tooBig: notebookPictureTooBigMessage,
  blocked: () => NOTEBOOK_PICTURE_TYPES_MESSAGE,
};

/** HEIC/HEIF (iPhone photos) and AVIF: an ISO media file with an image brand. Browsers mostly can't show them. */
function isHeicLike(bytes: Uint8Array): boolean {
  if (bytes.length < 12 || String.fromCharCode(...bytes.subarray(4, 8)) !== "ftyp") return false;
  const brand = String.fromCharCode(...bytes.subarray(8, 12));
  return ["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1", "avif", "avis"].includes(brand);
}

/** "IMG_0001.HEIC" holding a JPEG → "IMG_0001.jpg"; "screenshot" → "screenshot.png". */
function withPictureExtension(filename: string, kind: PictureKind): string {
  const ext = fileExtension(filename);
  const { extensions } = PICTURE_INFO[kind];
  if (extensions.includes(ext)) return filename;
  const base = ext && /^[a-z][a-z0-9]{0,4}$/.test(ext) ? filename.slice(0, -(ext.length + 1)) : filename;
  return cleanFilename(`${base || "picture"}.${extensions[0]}`);
}

export interface CheckedPicture extends CleanUpload {
  width: number;
  height: number;
}

/**
 * Checks a picked picture: not empty, up to 4 MB, really a PNG, JPG, GIF, or WebP (by its bytes, never SVG, HTML,
 * or PDF), and small enough in pixels for a phone to draw. Stored with the matching extension and real type.
 */
export function checkNotebookPicture(value: unknown): CheckedPicture {
  const picked = readUpload(value);
  if (!picked) throw fileError("Choose a picture to add.");
  const upload = checkUploadedFile(picked, PICTURE_UPLOAD_MESSAGES);
  const sniffed = sniffPosterFile(upload.bytes);
  if (!sniffed || sniffed === "pdf") {
    throw fileError(isHeicLike(upload.bytes) ? NOTEBOOK_PICTURE_HEIC_MESSAGE : NOTEBOOK_PICTURE_TYPES_MESSAGE);
  }
  const kind: PictureKind = sniffed;
  const size = posterImageSize(upload.bytes, kind);
  if (!size || size.width < 1 || size.height < 1) throw fileError(NOTEBOOK_PICTURE_UNREADABLE_MESSAGE);
  if (size.width > POSTER_IMAGE_MAX_SIDE || size.height > POSTER_IMAGE_MAX_SIDE || size.width * size.height > POSTER_IMAGE_MAX_PIXELS) {
    throw fileError(posterImageTooLargeMessage(size.width, size.height));
  }
  return {
    ...upload,
    filename: withPictureExtension(upload.filename, kind),
    contentType: PICTURE_INFO[kind].contentType,
    width: size.width,
    height: size.height,
  };
}

/**
 * A picture was added or taken off by someone other than its author while they're still writing it: the entry is
 * marked "Edited by" them, and the history gets a row with the text as it is (so it reads "changed the pictures").
 * Several picture changes by the same person close together (one save in the editor) share one row.
 * Call with the entry's row locked (FOR UPDATE), holding its current title and text.
 */
async function recordPictureChange(tx: Tx, ctx: ServiceContext, entryId: string, current: { title: string; body: string }) {
  const last = await tx.notebookEntryEdit.findFirst({
    where: { entryId },
    orderBy: [{ editedAt: "desc" }, { id: "desc" }],
    select: { id: true, editorId: true, editedAt: true, previousTitle: true, previousBody: true },
  });
  const sameRun =
    last !== null &&
    last.editorId === ctx.actor.id &&
    ctx.now.getTime() - last.editedAt.getTime() < NOTEBOOK_PICTURE_EDIT_MERGE_MS &&
    last.previousTitle === current.title &&
    last.previousBody === current.body;
  if (sameRun) {
    await tx.notebookEntryEdit.update({ where: { id: last.id }, data: { editedAt: ctx.now } });
  } else {
    await tx.notebookEntryEdit.create({
      data: { entryId, editorId: ctx.actor.id, editedAt: ctx.now, previousTitle: current.title, previousBody: current.body },
    });
  }
  await tx.notebookEntry.update({ where: { id: entryId }, data: { lastEditedById: ctx.actor.id, lastEditedAt: ctx.now } });
}

const addImageInput = z.object({ entryId: idSchema });
const imageIdInput = z.object({ imageId: idSchema });

/**
 * Room for one more picture on an entry: at most LIMITS.notebookImagesPerEntry, the person's pictures under their
 * allowance (unless they manage this notebook's pages), and every file under the team's cap. `locked`: in the upload's
 * transaction, after lockFileStorage (the real check); otherwise the quick look before uploading to Cloudflare R2.
 */
async function checkNotebookPictureRoom(
  db: Tx,
  ctx: ServiceContext,
  entry: { id: string; page: { notebook: { subteam: Subteam | null } } },
  adding: number,
  locked: boolean,
): Promise<void> {
  const objectStorage = usesObjectStorage(ctx);
  const count = await db.notebookImage.count({ where: { entryId: entry.id } });
  if (count >= LIMITS.notebookImagesPerEntry) throw fileError(notebookPicturesFullMessage());
  if (!canManageNotebookPages(ctx.actor, entry.page.notebook)) {
    const mine = await db.notebookImage.aggregate({ _sum: { size: true }, where: { entry: { authorId: ctx.actor.id } } });
    const used = mine._sum.size ?? 0;
    const allowance = perPersonFileCap(NOTEBOOK_IMAGE_BYTES_PER_PERSON, objectStorage);
    if (used + adding > allowance) {
      throw fileError(
        `Your notebook pictures use ${formatFileSize(used)}, and each person can have up to ${formatFileSize(allowance)}. Take off pictures you don't need, or ask a leader to add this one.`,
      );
    }
  }
  await (locked ? assertFileStorageRoom : checkFileStorageRoom)(
    db,
    { adding },
    (usage) =>
      `${storageFullSentence(usage)} Take off notebook pictures you don't need, or ask a leader to clear out old files.${posterCleanupSentence(usage)}`,
    objectStorage,
  );
}

/**
 * Add a picture to an entry (`file` is an UploadedFile read from the form by the Server Action): whoever can change
 * the entry. At most LIMITS.notebookImagesPerEntry per entry, each person's pictures under
 * NOTEBOOK_IMAGE_BYTES_PER_PERSON (unless they manage this notebook's pages), and all files together under the
 * team's storage cap — all checked under the storage lock, so uploads at the same moment can't go over.
 */
export async function addNotebookImage(ctx: ServiceContext, raw: unknown): Promise<{ id: string; filename: string }> {
  requireActive(ctx);
  const rec = asRecord(raw);
  const { entryId } = parseInput(addImageInput, rec);
  const entry = await loadEditableEntry(ctx, entryId);
  const picture = checkNotebookPicture(rec.file);
  const { limit, windowMs } = NOTEBOOK_IMAGE_RATE_LIMIT;
  await enforceRateLimit(ctx.db, `notebook-image:${ctx.actor.id}`, limit, windowMs, ctx.now);
  const adding = picture.bytes.byteLength;

  return withStoredFiles(
    ctx,
    "notebook",
    [picture],
    ([file]) =>
      ctx.db.$transaction(async (tx) => {
        await lockFileStorage(tx);
        const current = await lockEntry(tx, entryId);
        await checkNotebookPictureRoom(tx, ctx, entry, adding, true);
        const last = await tx.notebookImage.aggregate({ where: { entryId }, _max: { position: true } });
        const image = await tx.notebookImage.create({
          data: {
            entryId,
            ...file,
            width: picture.width,
            height: picture.height,
            position: (last._max.position ?? -1) + 1,
            createdAt: ctx.now,
          },
          select: { id: true, filename: true },
        });
        if (!stillWriting(ctx, entry)) await recordPictureChange(tx, ctx, entryId, current);
        return image;
      }),
    { precheck: () => checkNotebookPictureRoom(ctx.db, ctx, entry, adding, false) },
  );
}

/** Take a picture off an entry: whoever can change the entry. */
export async function removeNotebookImage(ctx: ServiceContext, raw: unknown): Promise<{ entryId: string; filename: string }> {
  requireActive(ctx);
  const { imageId } = parseInput(imageIdInput, asRecord(raw));
  const image = await ctx.db.notebookImage.findUnique({ where: { id: imageId }, select: { entryId: true, filename: true } });
  if (!image) throw new NotFoundError(NOTEBOOK_IMAGE_NOT_FOUND);
  const entry = await loadEditableEntry(ctx, image.entryId);
  await ctx.db.$transaction(async (tx) => {
    const current = await lockEntry(tx, entry.id);
    const { count } = await tx.notebookImage.deleteMany({ where: { id: imageId } });
    if (count === 0) throw new NotFoundError(NOTEBOOK_IMAGE_NOT_FOUND);
    if (!stillWriting(ctx, entry)) await recordPictureChange(tx, ctx, entry.id, current);
  });
  return { entryId: image.entryId, filename: image.filename };
}
