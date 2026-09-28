import "server-only";
// Team notebook (/notebook): every ACTIVE person reads every notebook. Who may change what is decided per item with
// the same rules the services use (canManageNotebooks / canManageNotebookPages / canEditNotebookEntry). Picture bytes
// are only read by the picture route (getNotebookImage) and the Word export (loadNotebookImageBytes).
import type { Subteam } from "@/generated/prisma/enums";
import type { Actor } from "../actor";
import { type Db, prisma } from "../db";
import { canEditNotebookEntry, canManageNotebookPages, canManageNotebooks } from "../permissions";

/** Entries per screen on a page. */
export const NOTEBOOK_ENTRIES_PAGE_SIZE = 30;
/** Earlier versions listed under "History" (the count shows them all). Loaded only when History is opened. */
export const NOTEBOOK_HISTORY_SHOWN = 20;

export function notebookImageHref(imageId: string): string {
  return `/notebook/images/${encodeURIComponent(imageId)}`;
}

export function notebookPageHref(pageId: string): string {
  return `/notebook/p/${encodeURIComponent(pageId)}`;
}

const validId = (id: string) => !!id && id.length <= 64;

// ---------- outline ----------

export interface NotebookOutlinePage {
  id: string;
  title: string;
  entryCount: number;
  /** When the newest entry was written. */
  lastEntryAt: Date | null;
}

export interface NotebookOutlineItem {
  id: string;
  title: string;
  /** "" = none (the page shows a plain notebook). */
  emoji: string;
  description: string;
  subteam: Subteam | null;
  pages: NotebookOutlinePage[];
  entryCount: number;
  /** Add, rename, reorder, and delete this notebook's pages. */
  canManagePages: boolean;
}

export interface NotebookOutline {
  notebooks: NotebookOutlineItem[];
  /** Add, change, reorder, and delete notebooks (and set up the standard ones). */
  canManageNotebooks: boolean;
}

/** Every notebook with its pages, in order. Null for accounts that aren't active. */
export async function getNotebookOutline(actor: Actor, db: Db = prisma): Promise<NotebookOutline | null> {
  if (actor.status !== "ACTIVE") return null;
  const [notebooks, stats] = await Promise.all([
    db.notebook.findMany({
      orderBy: [{ position: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      select: {
        id: true,
        title: true,
        emoji: true,
        description: true,
        subteam: true,
        pages: { orderBy: [{ position: "asc" }, { createdAt: "asc" }, { id: "asc" }], select: { id: true, title: true } },
      },
    }),
    db.notebookEntry.groupBy({ by: ["pageId"], _count: { _all: true }, _max: { createdAt: true } }),
  ]);
  const byPage = new Map(stats.map((s) => [s.pageId, { count: s._count._all, last: s._max.createdAt }]));
  return {
    canManageNotebooks: canManageNotebooks(actor),
    notebooks: notebooks.map((n) => {
      const pages = n.pages.map((p) => ({
        id: p.id,
        title: p.title,
        entryCount: byPage.get(p.id)?.count ?? 0,
        lastEntryAt: byPage.get(p.id)?.last ?? null,
      }));
      return {
        id: n.id,
        title: n.title,
        emoji: n.emoji,
        description: n.description,
        subteam: n.subteam,
        pages,
        entryCount: pages.reduce((sum, p) => sum + p.entryCount, 0),
        canManagePages: canManageNotebookPages(actor, n),
      };
    }),
  };
}

// ---------- latest entries ----------

export interface LatestNotebookEntry {
  id: string;
  pageId: string;
  pageTitle: string;
  notebookTitle: string;
  notebookEmoji: string;
  title: string;
  /** The start of the text, on one line. */
  snippet: string;
  authorName: string | null;
  createdAt: Date;
}

function snippetOf(body: string, max = 140): string {
  const flat = body.replace(/\s+/g, " ").trim();
  const chars = Array.from(flat);
  return chars.length <= max ? flat : `${chars.slice(0, max - 1).join("").trimEnd()}…`;
}

/** The newest entries across every notebook (for the notebook home). */
export async function getLatestNotebookEntries(actor: Actor, take = 6, db: Db = prisma): Promise<LatestNotebookEntry[]> {
  if (actor.status !== "ACTIVE") return [];
  const rows = await db.notebookEntry.findMany({
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take,
    select: {
      id: true,
      title: true,
      body: true,
      createdAt: true,
      author: { select: { name: true } },
      page: { select: { id: true, title: true, notebook: { select: { title: true, emoji: true } } } },
    },
  });
  return rows.map((r) => ({
    id: r.id,
    pageId: r.page.id,
    pageTitle: r.page.title,
    notebookTitle: r.page.notebook.title,
    notebookEmoji: r.page.notebook.emoji,
    title: r.title,
    snippet: snippetOf(r.body),
    authorName: r.author?.name ?? null,
    createdAt: r.createdAt,
  }));
}

// ---------- one page ----------

export type NotebookEntryOrder = "newest" | "oldest";

export interface NotebookImageView {
  id: string;
  src: string;
  filename: string;
  width: number | null;
  height: number | null;
}

export interface NotebookEntryView {
  id: string;
  title: string;
  body: string;
  authorName: string | null;
  /** The viewer wrote it. */
  mine: boolean;
  createdAt: Date;
  lastEditedByName: string | null;
  lastEditedAt: Date | null;
  images: NotebookImageView[];
  /** How many earlier versions it has (the versions themselves load when History is opened: getNotebookEntryHistory). */
  historyCount: number;
  /** Change or remove it (and its pictures). */
  canEdit: boolean;
}

export interface NotebookPageView {
  page: { id: string; title: string };
  notebook: { id: string; title: string; emoji: string; subteam: Subteam | null };
  entries: NotebookEntryView[];
  entryCount: number;
  order: NotebookEntryOrder;
  /** 1-based screen of entries, and how many there are. */
  screen: number;
  screenCount: number;
  canManagePages: boolean;
}

/** A page with one screen of its entries (newest first unless `order` is "oldest"). Null when it's gone (or the account isn't active). */
export async function getNotebookPageView(
  actor: Actor,
  pageId: string,
  opts: { order: NotebookEntryOrder; screen?: number },
  db: Db = prisma,
): Promise<NotebookPageView | null> {
  if (actor.status !== "ACTIVE" || !validId(pageId)) return null;
  const page = await db.notebookPage.findUnique({
    where: { id: pageId },
    select: {
      id: true,
      title: true,
      notebook: { select: { id: true, title: true, emoji: true, subteam: true } },
      _count: { select: { entries: true } },
    },
  });
  if (!page) return null;
  const entryCount = page._count.entries;
  const screenCount = Math.max(1, Math.ceil(entryCount / NOTEBOOK_ENTRIES_PAGE_SIZE));
  const screen = Math.min(Math.max(1, opts.screen ?? 1), screenCount);
  const dir = opts.order === "oldest" ? "asc" : "desc";
  const rows = await db.notebookEntry.findMany({
    where: { pageId },
    orderBy: [{ createdAt: dir }, { id: dir }],
    skip: (screen - 1) * NOTEBOOK_ENTRIES_PAGE_SIZE,
    take: NOTEBOOK_ENTRIES_PAGE_SIZE,
    select: {
      id: true,
      title: true,
      body: true,
      authorId: true,
      createdAt: true,
      lastEditedAt: true,
      author: { select: { name: true, role: true, isAdmin: true } },
      lastEditedBy: { select: { name: true } },
      // Never the bytes.
      images: {
        orderBy: [{ position: "asc" }, { createdAt: "asc" }, { id: "asc" }],
        select: { id: true, filename: true, width: true, height: true },
      },
      // Only the count: old versions can be long (20 × 20,000 characters), so History loads them when it's opened.
      _count: { select: { edits: true } },
    },
  });
  return {
    page: { id: page.id, title: page.title },
    notebook: page.notebook,
    entryCount,
    order: opts.order,
    screen,
    screenCount,
    canManagePages: canManageNotebookPages(actor, page.notebook),
    entries: rows.map((e) => ({
      id: e.id,
      title: e.title,
      body: e.body,
      authorName: e.author?.name ?? null,
      mine: e.authorId !== null && e.authorId === actor.id,
      createdAt: e.createdAt,
      lastEditedByName: e.lastEditedAt ? (e.lastEditedBy?.name ?? null) : null,
      lastEditedAt: e.lastEditedAt,
      images: e.images.map((i) => ({ id: i.id, src: notebookImageHref(i.id), filename: i.filename, width: i.width, height: i.height })),
      historyCount: e._count.edits,
      canEdit: canEditNotebookEntry(actor, e, page.notebook),
    })),
  };
}

// ---------- an entry's history ----------

export interface NotebookVersionView {
  id: string;
  editorName: string | null;
  editedAt: Date;
  /** What it said before this change ("" and "" when it was taken out: isClearedNotebookVersion). */
  previousTitle: string;
  previousBody: string;
}

export interface NotebookEntryHistory {
  entryId: string;
  /** The entry as it is now (to tell what each change did). */
  title: string;
  body: string;
  /** Newest first, at most NOTEBOOK_HISTORY_SHOWN. */
  versions: NotebookVersionView[];
  /** Every earlier version. */
  historyCount: number;
  /** Take an old version's text out (whoever can change the entry). */
  canClear: boolean;
}

/** An entry's earlier versions, for its History (any ACTIVE person). Null when it's gone (or the account isn't active). */
export async function getNotebookEntryHistory(actor: Actor, entryId: string, db: Db = prisma): Promise<NotebookEntryHistory | null> {
  if (actor.status !== "ACTIVE" || !validId(entryId)) return null;
  const e = await db.notebookEntry.findUnique({
    where: { id: entryId },
    select: {
      id: true,
      title: true,
      body: true,
      authorId: true,
      author: { select: { role: true, isAdmin: true } },
      page: { select: { notebook: { select: { subteam: true } } } },
      edits: {
        orderBy: [{ editedAt: "desc" }, { id: "desc" }],
        take: NOTEBOOK_HISTORY_SHOWN,
        select: { id: true, editedAt: true, previousTitle: true, previousBody: true, editor: { select: { name: true } } },
      },
      _count: { select: { edits: true } },
    },
  });
  if (!e) return null;
  return {
    entryId: e.id,
    title: e.title,
    body: e.body,
    versions: e.edits.map((h) => ({
      id: h.id,
      editorName: h.editor?.name ?? null,
      editedAt: h.editedAt,
      previousTitle: h.previousTitle,
      previousBody: h.previousBody,
    })),
    historyCount: e._count.edits,
    canClear: canEditNotebookEntry(actor, e, e.page.notebook),
  };
}

// ---------- editing a notebook ----------

export interface NotebookForEdit {
  id: string;
  title: string;
  emoji: string;
  description: string;
  subteam: Subteam | null;
  pageCount: number;
  entryCount: number;
}

/** A notebook for its edit form, or null when the viewer can't change notebooks (or it doesn't exist). */
export async function getNotebookForEdit(actor: Actor, notebookId: string, db: Db = prisma): Promise<NotebookForEdit | null> {
  if (actor.status !== "ACTIVE" || !canManageNotebooks(actor) || !validId(notebookId)) return null;
  const n = await db.notebook.findUnique({
    where: { id: notebookId },
    select: { id: true, title: true, emoji: true, description: true, subteam: true, _count: { select: { pages: true } } },
  });
  if (!n) return null;
  const entryCount = await db.notebookEntry.count({ where: { page: { notebookId } } });
  return { id: n.id, title: n.title, emoji: n.emoji, description: n.description, subteam: n.subteam, pageCount: n._count.pages, entryCount };
}

// ---------- pictures ----------

/** A picture with its bytes, for the picture route. Any ACTIVE person; null otherwise (or when it's gone). */
export async function getNotebookImage(actor: Actor, imageId: string, db: Db = prisma) {
  if (actor.status !== "ACTIVE" || !validId(imageId)) return null;
  return db.notebookImage.findUnique({ where: { id: imageId }, select: { filename: true, contentType: true, data: true } });
}

// ---------- export (Word and print) ----------

export interface NotebookExportImage {
  id: string;
  src: string;
  filename: string;
  contentType: string;
  size: number;
  width: number | null;
  height: number | null;
}

export interface NotebookExportEntry {
  id: string;
  title: string;
  body: string;
  authorName: string | null;
  createdAt: Date;
  lastEditedByName: string | null;
  lastEditedAt: Date | null;
  images: NotebookExportImage[];
}

export interface NotebookExport {
  /** A whole notebook, or just one of its pages. */
  scope: "notebook" | "page";
  notebook: { id: string; title: string; emoji: string; description: string; subteam: Subteam | null };
  /** In notebook order; each page's entries oldest first, like a journal. */
  pages: { id: string; title: string; entries: NotebookExportEntry[] }[];
}

export type NotebookExportTarget = { notebookId: string } | { pageId: string };

const exportEntrySelect = {
  orderBy: [{ createdAt: "asc" as const }, { id: "asc" as const }],
  select: {
    id: true,
    title: true,
    body: true,
    createdAt: true,
    lastEditedAt: true,
    author: { select: { name: true } },
    lastEditedBy: { select: { name: true } },
    images: {
      orderBy: [{ position: "asc" as const }, { createdAt: "asc" as const }, { id: "asc" as const }],
      select: { id: true, filename: true, contentType: true, size: true, width: true, height: true },
    },
  },
};

/** Everything in a notebook (or one page) for the Word export and the print view, without picture bytes. */
export async function getNotebookExport(actor: Actor, target: NotebookExportTarget, db: Db = prisma): Promise<NotebookExport | null> {
  if (actor.status !== "ACTIVE") return null;
  const notebookSelect = { id: true, title: true, emoji: true, description: true, subteam: true } as const;
  let notebook: NotebookExport["notebook"] | null;
  let pageWhere: { notebookId: string } | { id: string };
  if ("pageId" in target) {
    if (!validId(target.pageId)) return null;
    const page = await db.notebookPage.findUnique({ where: { id: target.pageId }, select: { notebook: { select: notebookSelect } } });
    notebook = page?.notebook ?? null;
    pageWhere = { id: target.pageId };
  } else {
    if (!validId(target.notebookId)) return null;
    notebook = await db.notebook.findUnique({ where: { id: target.notebookId }, select: notebookSelect });
    pageWhere = { notebookId: target.notebookId };
  }
  if (!notebook) return null;
  const pages = await db.notebookPage.findMany({
    where: pageWhere,
    orderBy: [{ position: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    select: { id: true, title: true, entries: exportEntrySelect },
  });
  return {
    scope: "pageId" in target ? "page" : "notebook",
    notebook,
    pages: pages.map((p) => ({
      id: p.id,
      title: p.title,
      entries: p.entries.map((e) => ({
        id: e.id,
        title: e.title,
        body: e.body,
        authorName: e.author?.name ?? null,
        createdAt: e.createdAt,
        lastEditedByName: e.lastEditedAt ? (e.lastEditedBy?.name ?? null) : null,
        lastEditedAt: e.lastEditedAt,
        images: e.images.map((i) => ({ ...i, src: notebookImageHref(i.id) })),
      })),
    })),
  };
}

/** The bytes of these pictures (for the Word export), by id. */
export async function loadNotebookImageBytes(imageIds: string[], db: Db = prisma): Promise<Map<string, Uint8Array>> {
  if (imageIds.length === 0) return new Map();
  const rows = await db.notebookImage.findMany({ where: { id: { in: imageIds } }, select: { id: true, data: true } });
  return new Map(rows.map((r) => [r.id, r.data]));
}
