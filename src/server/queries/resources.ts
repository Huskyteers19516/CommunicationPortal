import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import type { ResourceStatus, ResourceType } from "@/generated/prisma/enums";
import type { Actor } from "../actor";
import { type Db, prisma } from "../db";
import { getObjectStore, type ObjectStore } from "../files/object-store";
import { readStoredBytes, STORED_FILE_SELECT } from "../files/respond";
import {
  canDeleteResource,
  canEditResource,
  canManageResources,
  canReviewResources,
  canViewResource,
} from "../permissions";
import { decodeTextPreview, type FilePreviewKind, previewKind, TEXT_PREVIEW_MAX_BYTES } from "../resources/serve";
import { resourceReviewQueueWhere } from "../scopes";
import { type ResourceKind, type ResourceLink, parseHttpUrl, readLinks } from "../services/resources";

export interface ResourceFileInfo {
  filename: string;
  size: number;
  contentType: string;
}

export interface ResourceItem {
  id: string;
  title: string;
  kind: ResourceKind;
  /** The link (link resources); "" for files. */
  url: string;
  /** Where the title goes: the link itself, or `/resources/files/<id>` for an uploaded file. */
  href: string;
  /** The link's host ("docs.example.com"); "" for files. */
  host: string;
  file: ResourceFileInfo | null;
  description: string;
  type: ResourceType;
  group: string;
  pinned: boolean;
  links: ResourceLink[];
  status: ResourceStatus;
  createdByName: string | null;
  createdAt: Date;
  /**
   * When it last changed (ISO). Review buttons send it back, so an approval never applies to
   * something the member changed after the reviewer looked at it.
   */
  version: string;
  /** Why it was sent back. Only filled in for the person who shared it (the "mine" list) and on the detail page. */
  reviewNote: string | null;
}

export interface ResourceGroup {
  name: string;
  items: ResourceItem[];
}

const OTHER_GROUP = "Other";

function host(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function resourceFileHref(id: string, download = false): string {
  return `/resources/files/${encodeURIComponent(id)}${download ? "?download=1" : ""}`;
}

const itemSelect = {
  id: true,
  title: true,
  url: true,
  description: true,
  type: true,
  group: true,
  pinned: true,
  links: true,
  status: true,
  reviewNote: true,
  createdAt: true,
  updatedAt: true,
  createdBy: { select: { name: true } },
  // Never the bytes.
  file: { select: { filename: true, size: true, contentType: true } },
} as const satisfies Prisma.ResourceSelect;

type ItemRow = Prisma.ResourceGetPayload<{ select: typeof itemSelect }>;

/** Row → item, or null when a link resource's link isn't http(s) (rows can be written outside the app). */
function toItem(r: ItemRow, opts: { withNote: boolean }): ResourceItem | null {
  const kind: ResourceKind = r.file ? "file" : "link";
  const url = kind === "link" ? parseHttpUrl(r.url) : "";
  if (url === null) return null;
  return {
    id: r.id,
    title: r.title,
    kind,
    url,
    href: kind === "file" ? resourceFileHref(r.id) : url,
    host: kind === "link" ? host(url) : "",
    file: r.file,
    description: r.description,
    type: r.type,
    group: r.group.trim() || OTHER_GROUP,
    pinned: r.pinned,
    links: readLinks(r.links),
    status: r.status,
    createdByName: r.createdBy?.name ?? null,
    createdAt: r.createdAt,
    version: r.updatedAt.toISOString(),
    reviewNote: opts.withNote ? r.reviewNote : null,
  };
}

/** Lines as an editor numbers them: a final newline doesn't start another line. */
function countLines(text: string): number {
  if (text === "") return 0;
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

function compact<T>(items: Array<T | null>): T[] {
  return items.filter((i): i is T => i !== null);
}

export interface ResourcesPage {
  /** Approved resources by section. Sections holding pinned items first, then A→Z, "Other" last. */
  groups: ResourceGroup[];
  /** Number of approved resources shown in `groups`. */
  total: number;
  /** Reviewers: members' resources waiting for approval, oldest first. Empty for everyone else. */
  pending: ResourceItem[];
  /** What the viewer shared that is waiting or was sent back (with the reviewer's note). */
  mine: ResourceItem[];
  /** Adds resources that go live right away; edits / removes / pins anyone's. */
  canManage: boolean;
  /** Approves or sends back members' resources. */
  canReview: boolean;
}

/**
 * The Resources page. Everyone sees approved resources grouped by section (inside a section: pinned
 * first, then by title); reviewers also get the approval queue, and everyone gets their own
 * submissions that aren't approved yet.
 */
export async function listResources(actor: Actor, db: Db = prisma): Promise<ResourcesPage> {
  const canReview = canReviewResources(actor);
  const [approvedRows, pendingRows, mineRows] = await Promise.all([
    db.resource.findMany({
      where: { status: "APPROVED" },
      orderBy: [{ pinned: "desc" }, { title: "asc" }],
      take: 500,
      select: itemSelect,
    }),
    canReview
      ? db.resource.findMany({ where: resourceReviewQueueWhere(actor), orderBy: { createdAt: "asc" }, take: 100, select: itemSelect })
      : Promise.resolve([]),
    db.resource.findMany({
      where: { createdById: actor.id, status: { in: ["PENDING", "REJECTED"] } },
      orderBy: { updatedAt: "desc" },
      take: 50,
      select: itemSelect,
    }),
  ]);

  const byGroup = new Map<string, ResourceItem[]>();
  let total = 0;
  for (const row of approvedRows) {
    const item = toItem(row, { withNote: false });
    if (!item) continue;
    const list = byGroup.get(item.group) ?? [];
    list.push(item);
    byGroup.set(item.group, list);
    total++;
  }
  const groups = [...byGroup.entries()]
    .map(([name, items]) => ({ name, items }))
    .sort((a, b) => {
      const pa = a.items.some((i) => i.pinned) ? 0 : 1;
      const pb = b.items.some((i) => i.pinned) ? 0 : 1;
      if (pa !== pb) return pa - pb;
      if (a.name === OTHER_GROUP) return 1;
      if (b.name === OTHER_GROUP) return -1;
      return a.name.localeCompare(b.name);
    });

  return {
    groups,
    total,
    pending: compact(pendingRows.map((r) => toItem(r, { withNote: false }))),
    mine: compact(mineRows.map((r) => toItem(r, { withNote: true }))),
    canManage: canManageResources(actor),
    canReview,
  };
}

/** How many members' resources wait for this reviewer (0 for everyone else). */
export async function countPendingResources(actor: Actor, db: Db = prisma): Promise<number> {
  if (!canReviewResources(actor)) return 0;
  return db.resource.count({ where: resourceReviewQueueWhere(actor) });
}

/** One resource for the edit form, or null when the actor can't edit it (or it doesn't exist). */
export async function getResourceForEdit(actor: Actor, id: string, db: Db = prisma) {
  const r = await db.resource.findUnique({
    where: { id },
    select: {
      id: true,
      title: true,
      url: true,
      description: true,
      type: true,
      group: true,
      pinned: true,
      links: true,
      status: true,
      createdById: true,
      reviewNote: true,
      file: { select: { filename: true, size: true } },
    },
  });
  if (!r || !canViewResource(actor, r) || !canEditResource(actor, r)) return null;
  return {
    id: r.id,
    kind: (r.file ? "file" : "link") as ResourceKind,
    title: r.title,
    url: r.url,
    description: r.description,
    type: r.type,
    group: r.group,
    pinned: r.pinned,
    status: r.status,
    reviewNote: r.reviewNote,
    file: r.file,
    linksText: readLinks(r.links).map((l) => `${l.label} | ${l.url}`).join("\n"),
    canDelete: canDeleteResource(actor, r),
  };
}

export type ResourcePreview =
  | { kind: "text"; text: string; lineCount: number }
  | { kind: "image" }
  | { kind: "pdf" }
  /** No preview: "type" = not a previewable kind, "too-big" = text over the limit, "binary" = not clean UTF-8. */
  | { kind: "none"; reason: "type" | "too-big" | "binary" | "unavailable" };

export interface ResourceDetail extends ResourceItem {
  reviewedByName: string | null;
  reviewedAt: Date | null;
  /** Filled in for file resources only. */
  preview: ResourcePreview | null;
  /** Inline route for the file (images, PDFs, text), when the browser may show it. */
  fileViewHref: string | null;
  fileDownloadHref: string | null;
  isMine: boolean;
  canEdit: boolean;
  canDelete: boolean;
  /** Approves or sends back members' resources (the page keeps its review card mounted for them). */
  isReviewer: boolean;
  /** Can approve / send it back right now (a reviewer, and it isn't approved yet). */
  canReview: boolean;
}

/**
 * The /resources/[id] page, or null when the actor may not see it (someone else's pending or
 * turned-down resource) or it doesn't exist. Small text files come with their text for the preview.
 */
export async function getResourceDetail(
  actor: Actor,
  id: string,
  db: Db = prisma,
  store: ObjectStore | null = getObjectStore(),
): Promise<ResourceDetail | null> {
  const r = await db.resource.findUnique({
    where: { id },
    select: {
      ...itemSelect,
      createdById: true,
      reviewedAt: true,
      reviewedBy: { select: { name: true } },
    },
  });
  if (!r || !canViewResource(actor, r)) return null;
  const isMine = r.createdById !== null && r.createdById === actor.id;
  const reviewer = canReviewResources(actor);
  // The review note is for the person who shared it and the reviewers.
  const item = toItem(r, { withNote: isMine || reviewer });
  if (!item) return null;

  let preview: ResourcePreview | null = null;
  let fileViewHref: string | null = null;
  if (item.file) {
    const kind: FilePreviewKind = previewKind(item.file.filename, item.file.contentType);
    if (kind !== "other") fileViewHref = resourceFileHref(r.id);
    if (kind === "image" || kind === "pdf") preview = { kind };
    else if (kind === "other") preview = { kind: "none", reason: "type" };
    else if (item.file.size > TEXT_PREVIEW_MAX_BYTES) preview = { kind: "none", reason: "too-big" };
    else {
      const row = await db.resourceFile.findUnique({ where: { resourceId: r.id }, select: { data: true, storageKey: true } });
      const bytes = row ? await readStoredBytes(row, store) : null;
      const text = bytes ? decodeTextPreview(bytes) : null;
      if (row && !bytes) preview = { kind: "none", reason: "unavailable" };
      else preview = text === null ? { kind: "none", reason: "binary" } : { kind: "text", text, lineCount: countLines(text) };
    }
  }

  return {
    ...item,
    reviewedByName: r.reviewedBy?.name ?? null,
    reviewedAt: r.reviewedAt,
    preview,
    fileViewHref,
    fileDownloadHref: item.file ? resourceFileHref(r.id, true) : null,
    isMine,
    canEdit: canEditResource(actor, r),
    canDelete: canDeleteResource(actor, r),
    isReviewer: reviewer,
    canReview: reviewer && r.status !== "APPROVED",
  };
}

/** An uploaded file for the download route, or null when the actor may not see it (or there is none). */
export async function getResourceFile(actor: Actor, id: string, db: Db = prisma) {
  const r = await db.resource.findUnique({
    where: { id },
    select: {
      status: true,
      createdById: true,
      file: { select: STORED_FILE_SELECT },
    },
  });
  if (!r || !r.file || !canViewResource(actor, r)) return null;
  return r.file;
}

/** Existing section names, for the form's suggestions (approved resources only). */
export async function listResourceGroups(db: Db = prisma): Promise<string[]> {
  const rows = await db.resource.findMany({
    where: { group: { not: "" }, status: "APPROVED" },
    distinct: ["group"],
    select: { group: true },
    take: 50,
  });
  return rows.map((r) => r.group).sort((a, b) => a.localeCompare(b));
}
