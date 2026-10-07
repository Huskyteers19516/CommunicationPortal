import "server-only";
// Website Coding: what Admin → Website Coding shows (the saved values with their pictures, and the recent changes with
// who made them), the public JSON for the team website (GET /api/public/site-content), and the pictures' files — the
// public route only serves a picture some slot shows right now. Writes: src/server/services/site-content.ts.
import type { SiteContentKind } from "@/generated/prisma/enums";
import {
  type PublicSiteContent,
  type PublicSiteImage,
  publicSiteImagePath,
  SITE_EDITS_SHOWN,
  SITE_KIND_FROM_DB,
  type SiteSlotKind,
} from "@/lib/public-site-content";
import type { Actor } from "../actor";
import { type Db, prisma } from "../db";
import { STORED_FILE_SELECT, type StoredFileRow } from "../files/respond";
import { canEditWebsite } from "../permissions";

/** A saved picture as the editor shows it. */
export interface SiteImageInfo {
  id: string;
  alt: string;
  width: number | null;
  height: number | null;
}

/** One saved value (a slot changed from the website's own content). */
export interface SiteContentEntry {
  key: string;
  kind: SiteSlotKind;
  /** Text, address, or (pictures) the SiteImage id. */
  value: string;
  /** Pictures: the one shown (null if it's missing — the website then keeps its own). */
  image: SiteImageInfo | null;
  updatedAt: string;
  updatedByName: string | null;
}

/** One change in "Recent changes". `before` / `after` null = the website's own content. */
export interface SiteContentEditRow {
  id: string;
  key: string;
  kind: SiteSlotKind;
  before: string | null;
  after: string | null;
  /** Pictures: whether `before` still exists (else Undo can't bring it back). */
  beforeAvailable: boolean;
  createdAt: string;
  editorName: string | null;
}

export interface SiteContentAdminView {
  entries: SiteContentEntry[];
  edits: SiteContentEditRow[];
}

/** Admin → Website Coding: every saved value and the last SITE_EDITS_SHOWN changes. Null for anyone else. */
export async function getSiteContentAdminView(actor: Actor, db: Db = prisma): Promise<SiteContentAdminView | null> {
  if (actor.status !== "ACTIVE" || !canEditWebsite(actor)) return null;
  const rows = await db.siteContent.findMany({
    orderBy: { key: "asc" },
    select: { key: true, kind: true, value: true, updatedAt: true, updatedBy: { select: { name: true } } },
  });
  const edits = await db.siteContentEdit.findMany({
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: SITE_EDITS_SHOWN,
    select: { id: true, key: true, kind: true, before: true, after: true, createdAt: true, editedBy: { select: { name: true } } },
  });
  const imageIds = new Set<string>();
  for (const r of rows) if (r.kind === "IMAGE") imageIds.add(r.value);
  for (const e of edits) if (e.kind === "IMAGE" && e.before) imageIds.add(e.before);
  const images = await db.siteImage.findMany({
    where: { id: { in: [...imageIds] } },
    select: { id: true, key: true, alt: true, width: true, height: true },
  });
  const byId = new Map(images.map((i) => [i.id, i]));

  return {
    entries: rows.map((r) => {
      const image = r.kind === "IMAGE" ? byId.get(r.value) : undefined;
      return {
        key: r.key,
        kind: SITE_KIND_FROM_DB[r.kind],
        value: r.value,
        image: image && image.key === r.key ? { id: image.id, alt: image.alt, width: image.width, height: image.height } : null,
        updatedAt: r.updatedAt.toISOString(),
        updatedByName: r.updatedBy?.name ?? null,
      };
    }),
    edits: edits.map((e) => ({
      id: e.id,
      key: e.key,
      kind: SITE_KIND_FROM_DB[e.kind],
      before: e.before,
      after: e.after,
      beforeAvailable: e.kind !== "IMAGE" || e.before === null || byId.get(e.before)?.key === e.key,
      createdAt: e.createdAt.toISOString(),
      editorName: e.editedBy?.name ?? null,
    })),
  };
}

const dimension = (v: number | null): number | undefined => (v !== null && Number.isInteger(v) && v > 0 && v <= 20000 ? v : undefined);

/**
 * The public JSON: every saved value by kind. Texts and links as saved; a picture as its relative public address, its
 * description, and its size (both or neither). A picture slot whose picture is missing is left out (the website keeps
 * its own). Never who changed what, when, or anything about the history.
 */
export async function getPublicSiteContent(db: Db, options: { now: Date }): Promise<PublicSiteContent> {
  const rows = await db.siteContent.findMany({ orderBy: { key: "asc" }, select: { key: true, kind: true, value: true } });
  const imageIds = rows.filter((r) => r.kind === "IMAGE").map((r) => r.value);
  const images =
    imageIds.length === 0
      ? []
      : await db.siteImage.findMany({ where: { id: { in: imageIds } }, select: { id: true, key: true, alt: true, width: true, height: true } });
  const byId = new Map(images.map((i) => [i.id, i]));
  const answer: PublicSiteContent = { enabled: true, updatedAt: options.now.toISOString(), texts: {}, links: {}, images: {} };
  for (const r of rows) {
    const kind: SiteContentKind = r.kind;
    if (kind === "TEXT") answer.texts[r.key] = r.value;
    else if (kind === "LINK") answer.links[r.key] = r.value;
    else {
      const image = byId.get(r.value);
      if (!image || image.key !== r.key) continue;
      const out: PublicSiteImage = { src: publicSiteImagePath(image.id), alt: image.alt };
      const width = dimension(image.width);
      const height = dimension(image.height);
      if (width && height) {
        out.width = width;
        out.height = height;
      }
      answer.images[r.key] = out;
    }
  }
  return answer;
}

/**
 * A picture's bytes for GET /api/public/site-images/[id]: only while a slot shows it (the check is in the one query's
 * WHERE), else null.
 */
export async function getPublicSiteImage(db: Db, id: string): Promise<StoredFileRow | null> {
  if (!id || id.length > 64) return null;
  const rows = await db.$queryRaw<{ filename: string; contentType: string; size: number; data: Uint8Array | null; storageKey: string | null }[]>`
    SELECT i."filename", i."contentType", i."size", i."data", i."storageKey"
    FROM "SiteImage" i
    WHERE i."id" = ${id}
      AND EXISTS (SELECT 1 FROM "SiteContent" c WHERE c."key" = i."key" AND c."kind" = 'IMAGE' AND c."value" = i."id")
    LIMIT 1`;
  const row = rows[0];
  if (!row) return null;
  return { ...row, data: row.data ? new Uint8Array(row.data) : null };
}

/** The neutral name a public picture is served under ("website-picture.jpg"), never the uploaded one. */
export function publicSiteImageFilename(row: { contentType: string }): string {
  const ext = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" }[row.contentType.toLowerCase()] ?? "png";
  return `website-picture.${ext}`;
}

/** Any Website Coding picture (also earlier ones, kept for Undo) for the signed-in route: people who can edit the website. */
export async function getSiteImageFile(actor: Actor, id: string, db: Db = prisma) {
  if (actor.status !== "ACTIVE" || !canEditWebsite(actor) || !id || id.length > 64) return null;
  return db.siteImage.findUnique({ where: { id }, select: STORED_FILE_SELECT });
}
