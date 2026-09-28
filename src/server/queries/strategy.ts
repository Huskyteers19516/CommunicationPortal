import "server-only";
// Strategy page (/strategy): every ACTIVE person sees every strategy. Metadata only here; the bytes are only read
// by the file route (getStrategyFile), which sends them with strategyFileHeaders.
import type { Prisma } from "@/generated/prisma/client";
import type { StrategyKind } from "@/lib/constants";
import { isPedroPathFile } from "@/lib/strategy";
import { parseHttpUrl } from "@/lib/urls";
import type { Actor } from "../actor";
import { type Db, prisma } from "../db";
import { canAdminister, canEditStrategy } from "../permissions";
import { fileResponseHeaders, previewKind, type ServedFile } from "../resources/serve";

/** Strategies per page. */
export const STRATEGIES_PAGE_SIZE = 50;
/** The description preview on a card (the card clamps it to a few lines). */
const PREVIEW_CHARS = 300;

/** How a strategy file is shown: a .pp path (download + planner hint), a picture, a PDF, or any other file. */
export type StrategyFileKind = "path" | "image" | "pdf" | "file";

export function strategyFileHref(fileId: string, download = false): string {
  return `/strategy/files/${encodeURIComponent(fileId)}${download ? "?download=1" : ""}`;
}

/** The locked-down file headers (src/server/resources/serve.ts); a .pp path is always a download. */
export function strategyFileHeaders(file: ServedFile, options: { download?: boolean } = {}): Record<string, string> {
  return fileResponseHeaders(file, { download: options.download || isPedroPathFile(file.filename) });
}

function fileKind(file: { filename: string; contentType: string }): StrategyFileKind {
  if (isPedroPathFile(file.filename)) return "path";
  const kind = previewKind(file.filename, file.contentType);
  return kind === "image" ? "image" : kind === "pdf" ? "pdf" : "file";
}

function linkHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** The first few hundred characters, on one line (the card clamps it). */
function preview(description: string): string {
  const flat = description.replace(/\s+/g, " ").trim();
  return flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS).trimEnd()}…` : flat;
}

export interface StrategyCard {
  id: string;
  title: string;
  kind: StrategyKind;
  pinned: boolean;
  descriptionPreview: string;
  createdByName: string | null;
  /** The viewer added it. */
  mine: boolean;
  updatedAt: Date;
  /** Files of each kind (for the paperclip / path / picture indicators). */
  pathCount: number;
  imageCount: number;
  otherFileCount: number;
  /** The link's host ("youtube.com"), or "" when there's no link. */
  linkHost: string;
}

export interface StrategyList {
  items: StrategyCard[];
  /** Strategies matching the filters (all pages). */
  total: number;
  page: number;
  pageCount: number;
}

/**
 * One page of strategies, pinned first and then the most recently updated, optionally of one `kind` and/or only
 * the viewer's own (`mine`). Our own strategies, or with `teamId` the ones about that other team (never mixed).
 * Null for accounts that aren't active.
 */
export async function listStrategies(
  actor: Actor,
  opts: { kind?: StrategyKind; mine: boolean; page?: number; teamId?: string },
  db: Db = prisma,
): Promise<StrategyList | null> {
  if (actor.status !== "ACTIVE") return null;
  const where: Prisma.StrategyWhereInput = {
    teamId: opts.teamId ?? null,
    ...(opts.kind ? { kind: opts.kind } : {}),
    ...(opts.mine ? { createdById: actor.id } : {}),
  };
  const total = await db.strategy.count({ where });
  const pageCount = Math.max(1, Math.ceil(total / STRATEGIES_PAGE_SIZE));
  const page = Math.min(Math.max(1, opts.page ?? 1), pageCount);
  const rows = await db.strategy.findMany({
    where,
    orderBy: [{ pinned: "desc" }, { updatedAt: "desc" }, { id: "desc" }],
    skip: (page - 1) * STRATEGIES_PAGE_SIZE,
    take: STRATEGIES_PAGE_SIZE,
    select: {
      id: true,
      title: true,
      kind: true,
      pinned: true,
      description: true,
      link: true,
      createdById: true,
      updatedAt: true,
      createdBy: { select: { name: true } },
      // Never the bytes.
      files: { select: { filename: true, contentType: true } },
    },
  });
  const items = rows.map((r): StrategyCard => {
    const kinds = r.files.map(fileKind);
    const link = parseHttpUrl(r.link) ?? "";
    return {
      id: r.id,
      title: r.title,
      kind: r.kind,
      pinned: r.pinned,
      descriptionPreview: preview(r.description),
      createdByName: r.createdBy?.name ?? null,
      mine: r.createdById !== null && r.createdById === actor.id,
      updatedAt: r.updatedAt,
      pathCount: kinds.filter((k) => k === "path").length,
      imageCount: kinds.filter((k) => k === "image").length,
      otherFileCount: kinds.filter((k) => k === "pdf" || k === "file").length,
      linkHost: link ? linkHost(link) || "link" : "",
    };
  });
  return { items, total, page, pageCount };
}

export interface StrategyFileInfo {
  id: string;
  filename: string;
  size: number;
  kind: StrategyFileKind;
  /** Shows it in the browser (pictures and PDFs), else null. */
  viewHref: string | null;
  downloadHref: string;
}

export interface StrategyDetail {
  id: string;
  title: string;
  kind: StrategyKind;
  description: string;
  /** A safe http(s) link, or "". */
  link: string;
  linkHost: string;
  pinned: boolean;
  /** The other team it's about (Strategy → Other teams), or null for one of ours. */
  team: { number: number; name: string } | null;
  files: StrategyFileInfo[];
  createdByName: string | null;
  createdAt: Date;
  updatedAt: Date;
  /** Change or remove it (whoever added it, and everyone with admin access). */
  canEdit: boolean;
  /** Pin or unpin it (everyone with admin access). */
  canPin: boolean;
}

/** One strategy for its page, or null (missing, or an account that isn't active). */
export async function getStrategyDetail(actor: Actor, id: string, db: Db = prisma): Promise<StrategyDetail | null> {
  if (actor.status !== "ACTIVE" || !id || id.length > 64) return null;
  const s = await db.strategy.findUnique({
    where: { id },
    select: {
      id: true,
      title: true,
      kind: true,
      description: true,
      link: true,
      pinned: true,
      createdById: true,
      createdAt: true,
      updatedAt: true,
      createdBy: { select: { name: true } },
      team: { select: { number: true, name: true } },
      files: {
        select: { id: true, filename: true, contentType: true, size: true },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      },
    },
  });
  if (!s) return null;
  const link = parseHttpUrl(s.link) ?? "";
  return {
    id: s.id,
    title: s.title,
    kind: s.kind,
    description: s.description,
    link,
    linkHost: link ? linkHost(link) : "",
    pinned: s.pinned,
    team: s.team,
    files: s.files.map((f) => {
      const kind = fileKind(f);
      return {
        id: f.id,
        filename: f.filename,
        size: f.size,
        kind,
        viewHref: kind === "image" || kind === "pdf" ? strategyFileHref(f.id) : null,
        downloadHref: strategyFileHref(f.id, true),
      };
    }),
    createdByName: s.createdBy?.name ?? null,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    canEdit: canEditStrategy(actor, s),
    canPin: canAdminister(actor),
  };
}

/** A strategy for its edit form, or null when the viewer can't change it (or it doesn't exist). */
export async function getStrategyForEdit(actor: Actor, id: string, db: Db = prisma): Promise<StrategyDetail | null> {
  const s = await getStrategyDetail(actor, id, db);
  return s?.canEdit ? s : null;
}

/** A strategy file with its bytes, for the file route. Any ACTIVE person; null otherwise (or when it's gone). */
export async function getStrategyFile(actor: Actor, fileId: string, db: Db = prisma) {
  if (actor.status !== "ACTIVE" || !fileId || fileId.length > 64) return null;
  return db.strategyFile.findUnique({ where: { id: fileId }, select: { filename: true, contentType: true, data: true } });
}
