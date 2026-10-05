import "server-only";
// The Workshop (/workshop) for signed-in people. Approved projects (on the team website) are seen by everyone ACTIVE;
// drafts, ones waiting for approval, and ones sent back by the people who can change them (whoever added it, the
// people credited) and reviewers. Metadata only here; bytes are only read by the file routes
// (getWorkshopPhotoFile / getWorkshopDownloadFile). The public answer for the website is ../public-workshop.ts.
import type { Prisma } from "@/generated/prisma/client";
import { defaultCoverIndex, type WorkshopKindValue, type WorkshopStatusValue, workshopFileFormat } from "@/lib/workshop";
import type { Actor } from "../actor";
import { type Db, prisma } from "../db";
import { STORED_FILE_SELECT } from "../files/respond";
import { canDeleteWorkshopProject, canEditWorkshopProject, canReviewWorkshop } from "../permissions";

export function workshopPhotoHref(photoId: string): string {
  return `/workshop/photos/${encodeURIComponent(photoId)}`;
}

export function workshopFileHref(fileId: string): string {
  return `/workshop/files/${encodeURIComponent(fileId)}`;
}

/** Projects the actor can see: approved ones, plus (reviewers: every other one) the ones they can change. */
export function visibleWorkshopWhere(actor: Actor): Prisma.WorkshopProjectWhereInput {
  if (canReviewWorkshop(actor)) return {};
  return {
    OR: [{ status: "APPROVED" }, { createdById: actor.id }, { credits: { some: { userId: actor.id } } }],
  };
}

/** "website": on the team website. "drafts": everything else the actor can see. "review": waiting for approval (reviewers). */
export type WorkshopView = "website" | "drafts" | "review";

export interface WorkshopCard {
  id: string;
  title: string;
  kind: WorkshopKindValue;
  status: WorkshopStatusValue;
  featured: boolean;
  summary: string;
  material: string;
  /** The cover photo (the chosen one, else defaultCoverIndex: a part's newest version, others' first photo). */
  cover: { src: string; width: number; height: number } | null;
  photoCount: number;
  fileCount: number;
  /** Credited people (with accounts) then other people, as written. */
  designers: string[];
  updatedAt: Date;
}

export interface WorkshopList {
  items: WorkshopCard[];
  counts: Record<WorkshopView, number>;
  /** The actor approves projects (sees the "Waiting for approval" tab). */
  reviewer: boolean;
}

const ORDER: Prisma.WorkshopProjectOrderByWithRelationInput[] = [{ featured: "desc" }, { publishedAt: "desc" }, { updatedAt: "desc" }, { id: "asc" }];

/** "Ethan Chen, Sam Lee" + extra credits "Alex (2024 alum)" → ["Ethan Chen", "Sam Lee", "Alex (2024 alum)"]. */
export function splitExtraCredits(extra: string): string[] {
  return extra
    .split(/[,\n;]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const cardSelect = {
  id: true,
  title: true,
  kind: true,
  status: true,
  featured: true,
  summary: true,
  material: true,
  extraCredits: true,
  updatedAt: true,
  coverPhoto: { select: { id: true, width: true, height: true } },
  photos: { orderBy: [{ position: "asc" }, { createdAt: "asc" }, { id: "asc" }], select: { id: true, width: true, height: true } },
  credits: { orderBy: { position: "asc" }, select: { user: { select: { name: true } } } },
  _count: { select: { photos: true, files: true } },
} satisfies Prisma.WorkshopProjectSelect;

function toCard(p: Prisma.WorkshopProjectGetPayload<{ select: typeof cardSelect }>): WorkshopCard {
  const cover = p.coverPhoto ?? p.photos[defaultCoverIndex(p.kind, p.photos.length)] ?? null;
  return {
    id: p.id,
    title: p.title,
    kind: p.kind,
    status: p.status,
    featured: p.featured,
    summary: p.summary,
    material: p.material,
    cover: cover ? { src: workshopPhotoHref(cover.id), width: cover.width, height: cover.height } : null,
    photoCount: p._count.photos,
    fileCount: p._count.files,
    designers: [...p.credits.map((c) => c.user.name), ...splitExtraCredits(p.extraCredits)],
    updatedAt: p.updatedAt,
  };
}

/** At most this many projects per tab (the team adds a handful a season; no paging needed). */
export const WORKSHOP_LIST_MAX = 200;

export async function listWorkshopProjects(
  actor: Actor,
  filters: { view: WorkshopView; kind: WorkshopKindValue | null; mine: boolean },
  db: Db = prisma,
): Promise<WorkshopList> {
  const reviewer = canReviewWorkshop(actor);
  const visible = visibleWorkshopWhere(actor);
  const mine: Prisma.WorkshopProjectWhereInput = filters.mine
    ? { OR: [{ createdById: actor.id }, { credits: { some: { userId: actor.id } } }] }
    : {};
  const kind: Prisma.WorkshopProjectWhereInput = filters.kind ? { kind: filters.kind } : {};
  const viewWhere: Record<WorkshopView, Prisma.WorkshopProjectWhereInput> = {
    website: { status: "APPROVED" },
    drafts: { status: { not: "APPROVED" } },
    review: reviewer ? { status: "PENDING" } : { id: "" },
  };
  const where = (view: WorkshopView): Prisma.WorkshopProjectWhereInput => ({ AND: [visible, mine, kind, viewWhere[view]] });
  const view = filters.view === "review" && !reviewer ? "website" : filters.view;
  const [rows, website, drafts, review] = await Promise.all([
    db.workshopProject.findMany({ where: where(view), orderBy: ORDER, take: WORKSHOP_LIST_MAX, select: cardSelect }),
    db.workshopProject.count({ where: where("website") }),
    db.workshopProject.count({ where: where("drafts") }),
    reviewer ? db.workshopProject.count({ where: where("review") }) : 0,
  ]);
  return { items: rows.map(toCard), counts: { website, drafts, review }, reviewer };
}

export interface WorkshopPhotoView {
  id: string;
  src: string;
  width: number;
  height: number;
  label: string;
  note: string;
  isCover: boolean;
  filename: string;
  size: number;
}

export interface WorkshopFileView {
  id: string;
  href: string;
  filename: string;
  format: string;
  size: number;
  label: string;
}

export interface WorkshopProjectDetail {
  id: string;
  kind: WorkshopKindValue;
  title: string;
  summary: string;
  material: string;
  season: string;
  extraCredits: string;
  link: string;
  codeLink: string;
  status: WorkshopStatusValue;
  featured: boolean;
  reviewNote: string;
  reviewedByName: string | null;
  reviewedAt: Date | null;
  publishedAt: Date | null;
  createdByName: string | null;
  createdAt: Date;
  updatedAt: Date;
  credits: { id: string; name: string }[];
  /** Story order (first version first). */
  photos: WorkshopPhotoView[];
  files: WorkshopFileView[];
  canEdit: boolean;
  canDelete: boolean;
  canReview: boolean;
}

/** One project with its photos and files, or null when it doesn't exist or the actor can't see it. */
export async function getWorkshopProject(actor: Actor, projectId: string, db: Db = prisma): Promise<WorkshopProjectDetail | null> {
  if (actor.status !== "ACTIVE" || !projectId || projectId.length > 64) return null;
  const p = await db.workshopProject.findFirst({
    where: { AND: [{ id: projectId }, visibleWorkshopWhere(actor)] },
    select: {
      id: true,
      kind: true,
      title: true,
      summary: true,
      material: true,
      season: true,
      extraCredits: true,
      link: true,
      codeLink: true,
      status: true,
      featured: true,
      coverPhotoId: true,
      reviewNote: true,
      reviewedBy: { select: { name: true } },
      reviewedAt: true,
      publishedAt: true,
      createdById: true,
      createdBy: { select: { name: true } },
      createdAt: true,
      updatedAt: true,
      credits: { orderBy: { position: "asc" }, select: { user: { select: { id: true, name: true } } } },
      photos: {
        orderBy: [{ position: "asc" }, { createdAt: "asc" }, { id: "asc" }],
        select: { id: true, width: true, height: true, label: true, note: true, filename: true, size: true },
      },
      files: { orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { id: true, filename: true, size: true, label: true } },
    },
  });
  if (!p) return null;
  const credits = p.credits.map((c) => c.user);
  const access = { createdById: p.createdById, creditUserIds: credits.map((c) => c.id) };
  const coverId = p.coverPhotoId ?? p.photos[defaultCoverIndex(p.kind, p.photos.length)]?.id ?? null;
  return {
    id: p.id,
    kind: p.kind,
    title: p.title,
    summary: p.summary,
    material: p.material,
    season: p.season,
    extraCredits: p.extraCredits,
    link: p.link,
    codeLink: p.codeLink,
    status: p.status,
    featured: p.featured,
    reviewNote: p.reviewNote,
    reviewedByName: p.reviewedBy?.name ?? null,
    reviewedAt: p.reviewedAt,
    publishedAt: p.publishedAt,
    createdByName: p.createdBy?.name ?? null,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    credits,
    photos: p.photos.map((ph) => ({ ...ph, src: workshopPhotoHref(ph.id), isCover: ph.id === coverId })),
    files: p.files.map((f) => ({ ...f, href: workshopFileHref(f.id), format: workshopFileFormat(f.filename) })),
    canEdit: canEditWorkshopProject(actor, access),
    canDelete: canDeleteWorkshopProject(actor, p),
    canReview: canReviewWorkshop(actor),
  };
}

export interface WorkshopPerson {
  id: string;
  name: string;
}

/** Everyone who can be credited on a project (ACTIVE accounts), by name. */
export async function getWorkshopPeople(actor: Actor, db: Db = prisma): Promise<WorkshopPerson[]> {
  if (actor.status !== "ACTIVE") return [];
  return db.user.findMany({ where: { status: "ACTIVE" }, orderBy: [{ name: "asc" }, { id: "asc" }], select: { id: true, name: true } });
}

/** A photo's stored bytes for the signed-in file route, when the actor can see its project. */
export async function getWorkshopPhotoFile(actor: Actor, photoId: string, db: Db = prisma) {
  if (actor.status !== "ACTIVE" || !photoId || photoId.length > 64) return null;
  return db.workshopPhoto.findFirst({ where: { id: photoId, project: visibleWorkshopWhere(actor) }, select: STORED_FILE_SELECT });
}

/** A design file's stored bytes for the signed-in file route, when the actor can see its project. */
export async function getWorkshopDownloadFile(actor: Actor, fileId: string, db: Db = prisma) {
  if (actor.status !== "ACTIVE" || !fileId || fileId.length > 64) return null;
  return db.workshopFile.findFirst({ where: { id: fileId, project: visibleWorkshopWhere(actor) }, select: STORED_FILE_SELECT });
}

/** Reviewers: projects waiting for approval (the nav badge). */
export async function countPendingWorkshop(actor: Actor, db: Db = prisma): Promise<number> {
  if (!canReviewWorkshop(actor)) return 0;
  return db.workshopProject.count({ where: { status: "PENDING" } });
}
