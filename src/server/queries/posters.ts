import "server-only";
// Posters page (/posters): every ACTIVE person sees every poster. Metadata only here; the bytes are only
// read by the file route (getPosterFile).
import type { Prisma } from "@/generated/prisma/client";
import { type DateOnly, dateOnlyToDb, dbToDateOnly } from "@/lib/dates";
import { parseHttpUrl } from "@/lib/urls";
import type { Actor } from "../actor";
import { type Db, prisma } from "../db";
import { canEditPoster } from "../permissions";
import { previewKind } from "../resources/serve";

/**
 * "upcoming": posters for today or later, and ones without a date (always current, e.g. recruiting);
 * "past": posters whose event date has gone by.
 */
export type PosterView = "upcoming" | "past";
export const POSTER_VIEWS: readonly PosterView[] = ["upcoming", "past"];

/** Posters per page: fills whole rows of 2, 3, or 4 columns. */
export const POSTERS_PAGE_SIZE = 48;

/** How a poster looks in the grid: its picture, a PDF tile, or a link tile (no file). */
export type PosterTileKind = "image" | "pdf" | "file" | "link";

export interface PosterTile {
  id: string;
  title: string;
  /** What it's for ("Library demo"), or "". */
  event: string;
  eventDate: DateOnly | null;
  kind: PosterTileKind;
  /** The picture for "image" posters (the inline file route), else null. */
  imageSrc: string | null;
  /** The link's host ("canva.com") for link-only posters, else "". */
  linkHost: string;
  createdByName: string | null;
  /** The viewer added it. */
  mine: boolean;
}

export interface PosterList {
  items: PosterTile[];
  /** Posters in each tab (with the "Added by me" filter applied when it's on). */
  counts: Record<PosterView, number>;
  page: number;
  pageCount: number;
}

export function posterFileHref(fileId: string, download = false): string {
  return `/posters/files/${encodeURIComponent(fileId)}${download ? "?download=1" : ""}`;
}

function linkHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function viewWhere(view: PosterView, today: DateOnly): Prisma.PosterWhereInput {
  const day = dateOnlyToDb(today);
  return view === "past" ? { eventDate: { lt: day } } : { OR: [{ eventDate: null }, { eventDate: { gte: day } }] };
}

/** Upcoming: newest first. Past: the most recent event first. */
function viewOrder(view: PosterView): Prisma.PosterOrderByWithRelationInput[] {
  return view === "past"
    ? [{ eventDate: "desc" }, { createdAt: "desc" }, { id: "desc" }]
    : [{ createdAt: "desc" }, { id: "desc" }];
}

const tileSelect = {
  id: true,
  title: true,
  event: true,
  eventDate: true,
  link: true,
  createdById: true,
  createdBy: { select: { name: true } },
  // Never the bytes.
  file: { select: { id: true, filename: true, contentType: true } },
} as const satisfies Prisma.PosterSelect;

type TileRow = Prisma.PosterGetPayload<{ select: typeof tileSelect }>;

function fileKind(file: { filename: string; contentType: string }): "image" | "pdf" | "file" {
  const kind = previewKind(file.filename, file.contentType);
  return kind === "image" ? "image" : kind === "pdf" ? "pdf" : "file";
}

function toTile(row: TileRow, actor: Actor): PosterTile {
  const kind: PosterTileKind = row.file ? fileKind(row.file) : "link";
  const link = parseHttpUrl(row.link) ?? "";
  return {
    id: row.id,
    title: row.title,
    event: row.event,
    eventDate: row.eventDate ? dbToDateOnly(row.eventDate) : null,
    kind,
    imageSrc: row.file && kind === "image" ? posterFileHref(row.file.id) : null,
    linkHost: kind === "link" ? linkHost(link) : "",
    createdByName: row.createdBy?.name ?? null,
    mine: row.createdById !== null && row.createdById === actor.id,
  };
}

/**
 * One page of posters for a tab (`view`), newest first, optionally only the viewer's own (`mine`).
 * Null for accounts that aren't active.
 */
export async function listPosters(
  actor: Actor,
  opts: { view: PosterView; mine: boolean; today: DateOnly; page?: number },
  db: Db = prisma,
): Promise<PosterList | null> {
  if (actor.status !== "ACTIVE") return null;
  const who: Prisma.PosterWhereInput = opts.mine ? { createdById: actor.id } : {};
  const [upcoming, past] = await Promise.all(
    POSTER_VIEWS.map((v) => db.poster.count({ where: { AND: [who, viewWhere(v, opts.today)] } })),
  );
  const counts = { upcoming, past };
  const pageCount = Math.max(1, Math.ceil(counts[opts.view] / POSTERS_PAGE_SIZE));
  const page = Math.min(Math.max(1, opts.page ?? 1), pageCount);
  const rows = await db.poster.findMany({
    where: { AND: [who, viewWhere(opts.view, opts.today)] },
    orderBy: viewOrder(opts.view),
    skip: (page - 1) * POSTERS_PAGE_SIZE,
    take: POSTERS_PAGE_SIZE,
    select: tileSelect,
  });
  return { items: rows.map((r) => toTile(r, actor)), counts, page, pageCount };
}

export interface PosterFileInfo {
  id: string;
  filename: string;
  size: number;
  kind: "image" | "pdf" | "file";
  /** Shows it in the browser (images and PDFs). */
  viewHref: string;
  downloadHref: string;
}

export interface PosterDetail {
  id: string;
  title: string;
  description: string;
  /** A safe http(s) link to the design, or "". */
  link: string;
  linkHost: string;
  event: string;
  eventDate: DateOnly | null;
  file: PosterFileInfo | null;
  createdByName: string | null;
  createdAt: Date;
  updatedAt: Date;
  /** Change or remove it (whoever added it, and everyone with admin access). */
  canEdit: boolean;
}

/** One poster for its page, or null (missing, or an account that isn't active). */
export async function getPosterDetail(actor: Actor, id: string, db: Db = prisma): Promise<PosterDetail | null> {
  if (actor.status !== "ACTIVE" || !id || id.length > 64) return null;
  const p = await db.poster.findUnique({
    where: { id },
    select: {
      id: true,
      title: true,
      description: true,
      link: true,
      event: true,
      eventDate: true,
      createdById: true,
      createdAt: true,
      updatedAt: true,
      createdBy: { select: { name: true } },
      file: { select: { id: true, filename: true, contentType: true, size: true } },
    },
  });
  if (!p) return null;
  const link = parseHttpUrl(p.link) ?? "";
  return {
    id: p.id,
    title: p.title,
    description: p.description,
    link,
    linkHost: link ? linkHost(link) : "",
    event: p.event,
    eventDate: p.eventDate ? dbToDateOnly(p.eventDate) : null,
    file: p.file
      ? {
          id: p.file.id,
          filename: p.file.filename,
          size: p.file.size,
          kind: fileKind(p.file),
          viewHref: posterFileHref(p.file.id),
          downloadHref: posterFileHref(p.file.id, true),
        }
      : null,
    createdByName: p.createdBy?.name ?? null,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    canEdit: canEditPoster(actor, p),
  };
}

/** A poster for its edit form, or null when the viewer can't change it (or it doesn't exist). */
export async function getPosterForEdit(actor: Actor, id: string, db: Db = prisma): Promise<PosterDetail | null> {
  const p = await getPosterDetail(actor, id, db);
  return p?.canEdit ? p : null;
}

/** A poster's file with its bytes, for the file route. Any ACTIVE person; null otherwise (or when it's gone). */
export async function getPosterFile(actor: Actor, fileId: string, db: Db = prisma) {
  if (actor.status !== "ACTIVE" || !fileId || fileId.length > 64) return null;
  return db.posterFile.findUnique({ where: { id: fileId }, select: { filename: true, contentType: true, data: true } });
}
