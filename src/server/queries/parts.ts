import "server-only";
// Parts queue (/parts): what needs to be printed, cut, or machined, most important first. Every ACTIVE
// person sees the whole queue and can grab a part; Build leaders (and all-scope staff) reorder it.

import type { Prisma } from "@/generated/prisma/client";
import type { PartProcess, PartStatus, Subteam } from "@/generated/prisma/enums";
import { SUBTEAM_LABELS, SUBTEAMS } from "@/lib/constants";
import { type DateOnly, dbToDateOnly } from "@/lib/dates";
import type { Actor } from "../actor";
import { type Db, prisma } from "../db";
import { canEditPart, canManageParts, canWorkOnPart } from "../permissions";
import { parseHttpUrl } from "../services/resources";

type ActorLike = Pick<Actor, "id" | "role" | "subteam" | "isAdmin">;

export type PartsView = "queue" | "done";
/** Only the parts the viewer is making (or made), or only the ones they asked for. */
export type PartsWho = "making" | "asked";
export const PARTS_WHO: readonly PartsWho[] = ["making", "asked"];

/** Most parts shown in the queue at once (the queue is normally far shorter). */
export const PARTS_QUEUE_LIMIT = 200;
/** The Done tab shows the most recently finished parts. */
export const PARTS_DONE_LIMIT = 50;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export interface PartPerson {
  id: string;
  name: string;
}

export interface PartItem {
  id: string;
  /** Place in the whole queue (1 = make it first), the same whatever the filters. Null for done parts. */
  rank: number | null;
  name: string;
  process: PartProcess;
  quantity: number;
  material: string;
  /** A safe http(s) link to the CAD / STL / drawing, or "". */
  fileUrl: string;
  notes: string;
  /** What it's for (a task category, e.g. Build → Intake). */
  category: { id: string; name: string; subteam: Subteam | null } | null;
  neededBy: DateOnly | null;
  /** Needed-by date has passed and it isn't done yet. */
  late: boolean;
  status: PartStatus;
  requestedBy: PartPerson | null;
  claimedBy: PartPerson | null;
  /** ISO timestamps. */
  claimedAt: string | null;
  doneAt: string | null;
  /** "I'll make it". */
  canClaim: boolean;
  /** "Drop it". */
  canUnclaim: boolean;
  /** "Mark done". */
  canFinish: boolean;
  /** Edit / remove. */
  canEdit: boolean;
  /** Move up / down / to the top. */
  canMove: boolean;
  /** "Put back in the queue". */
  canReopen: boolean;
  /** The viewer asked for it or is making it. */
  isMine: boolean;
  /** The viewer is making it. */
  isMaker: boolean;
  /** The viewer asked for it. */
  isRequester: boolean;
}

/** For the parts matching the filters (process, making / asked for), whatever the tab. */
export interface PartsCounts {
  upForGrabs: number;
  beingMade: number;
  /** Finished in the last 7 days. */
  doneThisWeek: number;
  doneTotal: number;
}

export interface PartsQueue {
  view: PartsView;
  items: PartItem[];
  counts: PartsCounts;
  /** Parts that aren't done (the last rank). */
  queueLength: number;
  /** The viewer can reorder the queue and change anyone's parts. */
  canManage: boolean;
  /** More matched than the limit. */
  truncated: boolean;
  limit: number;
}

export interface PartsFilters {
  view: PartsView;
  process?: PartProcess;
  who?: PartsWho;
  /** Today in the team timezone (for "late"). */
  today: DateOnly;
  /** Clock for "done this week" (default: now). */
  now?: Date;
}

const partItemSelect = {
  id: true,
  name: true,
  process: true,
  quantity: true,
  material: true,
  fileUrl: true,
  notes: true,
  neededBy: true,
  status: true,
  requestedById: true,
  claimedById: true,
  claimedAt: true,
  doneAt: true,
  category: { select: { id: true, name: true, subteam: true } },
  requestedBy: { select: { id: true, name: true } },
  claimedBy: { select: { id: true, name: true } },
} satisfies Prisma.PartSelect;

type PartRow = Prisma.PartGetPayload<{ select: typeof partItemSelect }>;

/** Queue order: position, then oldest first (ties only happen with hand-edited data). */
const QUEUE_ORDER: Prisma.PartOrderByWithRelationInput[] = [{ position: "asc" }, { createdAt: "asc" }, { id: "asc" }];

function toItem(actor: ActorLike, p: PartRow, rank: number | null, today: DateOnly): PartItem {
  const manager = canManageParts(actor);
  const neededBy = p.neededBy ? dbToDateOnly(p.neededBy) : null;
  const isMaker = p.claimedById !== null && p.claimedById === actor.id;
  const isRequester = p.requestedById !== null && p.requestedById === actor.id;
  return {
    id: p.id,
    rank,
    name: p.name,
    process: p.process,
    quantity: p.quantity,
    material: p.material,
    fileUrl: p.fileUrl ? (parseHttpUrl(p.fileUrl) ?? "") : "",
    notes: p.notes,
    category: p.category,
    neededBy,
    late: neededBy !== null && neededBy < today && p.status !== "DONE",
    status: p.status,
    requestedBy: p.requestedBy,
    claimedBy: p.claimedBy,
    claimedAt: p.claimedAt?.toISOString() ?? null,
    doneAt: p.doneAt?.toISOString() ?? null,
    canClaim: p.status === "NEEDED",
    canUnclaim: p.status === "CLAIMED" && canWorkOnPart(actor, p),
    canFinish: (p.status === "CLAIMED" && canWorkOnPart(actor, p)) || (p.status === "NEEDED" && manager),
    canEdit: canEditPart(actor, p),
    canMove: manager && p.status !== "DONE",
    canReopen: manager && p.status === "DONE",
    isMine: isMaker || isRequester,
    isMaker,
    isRequester,
  };
}

async function getCounts(db: Db, scope: Prisma.PartWhereInput, now: Date): Promise<PartsCounts> {
  const [groups, doneThisWeek] = await Promise.all([
    db.part.groupBy({ by: ["status"], where: scope, _count: { _all: true } }),
    db.part.count({ where: { ...scope, status: "DONE", doneAt: { gte: new Date(now.getTime() - WEEK_MS) } } }),
  ]);
  const by = (s: PartStatus) => groups.find((g) => g.status === s)?._count._all ?? 0;
  return { upForGrabs: by("NEEDED"), beingMade: by("CLAIMED"), doneThisWeek, doneTotal: by("DONE") };
}

/**
 * The parts queue (NEEDED + CLAIMED, in priority order, ranked across the whole queue) or the latest
 * finished parts, optionally filtered by process and to the parts the viewer is making or asked for.
 * Counts follow the same filters; ranks always come from the whole queue.
 */
export async function getPartsQueue(actor: ActorLike, filters: PartsFilters, db: Db = prisma): Promise<PartsQueue> {
  const scope: Prisma.PartWhereInput = {
    ...(filters.process ? { process: filters.process } : {}),
    ...(filters.who === "making" ? { claimedById: actor.id } : filters.who === "asked" ? { requestedById: actor.id } : {}),
  };
  const where: Prisma.PartWhereInput = { ...scope, status: filters.view === "done" ? "DONE" : { not: "DONE" } };
  const limit = filters.view === "done" ? PARTS_DONE_LIMIT : PARTS_QUEUE_LIMIT;

  const [queueIds, rows, counts] = await Promise.all([
    // Ranks come from the full queue, so filtering never renumbers anything.
    db.part.findMany({ where: { status: { not: "DONE" } }, orderBy: QUEUE_ORDER, select: { id: true } }),
    db.part.findMany({
      where,
      orderBy: filters.view === "done" ? [{ doneAt: "desc" }, { id: "desc" }] : QUEUE_ORDER,
      take: limit + 1,
      select: partItemSelect,
    }),
    getCounts(db, scope, filters.now ?? new Date()),
  ]);
  const rankOf = new Map(queueIds.map((p, i) => [p.id, i + 1]));
  const items = rows
    .slice(0, limit)
    .map((p) => toItem(actor, p, p.status === "DONE" ? null : (rankOf.get(p.id) ?? null), filters.today));

  return {
    view: filters.view,
    items,
    counts,
    queueLength: queueIds.length,
    canManage: canManageParts(actor),
    truncated: rows.length > limit,
    limit,
  };
}

export interface PartFormValues {
  id: string;
  name: string;
  process: PartProcess;
  quantity: number;
  material: string;
  fileUrl: string;
  notes: string;
  categoryId: string;
  neededBy: DateOnly | "";
  status: PartStatus;
  /** A manager is editing (not just the person who asked for it). */
  byManager: boolean;
}

/** A part the viewer may change (edit page), or null (missing, or not theirs to change). */
export async function getPartForEdit(actor: ActorLike, id: string, db: Db = prisma): Promise<PartFormValues | null> {
  const p = await db.part.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      process: true,
      quantity: true,
      material: true,
      fileUrl: true,
      notes: true,
      categoryId: true,
      neededBy: true,
      status: true,
      requestedById: true,
      claimedById: true,
    },
  });
  if (!p || !canEditPart(actor, p)) return null;
  return {
    id: p.id,
    name: p.name,
    process: p.process,
    quantity: p.quantity,
    material: p.material,
    fileUrl: p.fileUrl,
    notes: p.notes,
    categoryId: p.categoryId ?? "",
    neededBy: p.neededBy ? dbToDateOnly(p.neededBy) : "",
    status: p.status,
    byManager: canManageParts(actor),
  };
}

export interface CategoryGroup {
  label: string;
  options: { id: string; name: string }[];
}

/** "For" menu on the part form: Build's categories first, then the other subteams', then whole-team ones. */
export async function getPartCategoryGroups(db: Db = prisma): Promise<CategoryGroup[]> {
  const rows = await db.taskCategory.findMany({
    orderBy: [{ position: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    select: { id: true, name: true, subteam: true },
  });
  const lists: (Subteam | null)[] = ["BUILD", ...SUBTEAMS.filter((s) => s !== "BUILD"), null];
  return lists
    .map((subteam) => ({
      label: subteam ? SUBTEAM_LABELS[subteam] : "Whole team",
      options: rows.filter((r) => r.subteam === subteam).map((r) => ({ id: r.id, name: r.name })),
    }))
    .filter((g) => g.options.length > 0);
}

/** Parts the viewer is making right now (Today page). */
export async function countPartsImMaking(actor: Pick<Actor, "id">, db: Db = prisma): Promise<number> {
  return db.part.count({ where: { claimedById: actor.id, status: "CLAIMED" } });
}
