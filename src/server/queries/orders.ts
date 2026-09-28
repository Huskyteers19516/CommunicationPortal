import "server-only";
// Order list (/orders): everything the team needs to buy. Every ACTIVE person sees every item; what they may
// change (canEdit, statusOptions) comes from the same rules the services enforce (permissions.ts).

import type { Prisma } from "@/generated/prisma/client";
import type { PurchaseStatus, Subteam } from "@/generated/prisma/enums";
import { PURCHASE_STATUSES } from "@/lib/constants";
import {
  filterCounts,
  isOpenPurchaseStatus,
  linkHost,
  ORDER_FILTERS,
  type OrderFilter,
  type OrderQuery,
  type OrderStatusGroup,
  type OrderSummary,
  summarizeOrders,
} from "@/lib/orders";
import { parseHttpUrl } from "@/lib/urls";
import type { Actor } from "../actor";
import { type Db, prisma } from "../db";
import { canEditPurchase, canManageOrders, hasAllScope, purchaseStatusTargets } from "../permissions";

type ActorLike = Pick<Actor, "id" | "role" | "subteam" | "isAdmin" | "status">;

/** Most items the page lists at once (a season has dozens to a few hundred). */
export const ORDER_LIST_LIMIT = 500;
/** Most rows in one spreadsheet export. */
export const ORDER_EXPORT_LIMIT = 5000;

export interface OrderPerson {
  id: string;
  name: string;
}

export interface OrderItem {
  id: string;
  description: string;
  notes: string;
  /** A safe http(s) link to the product, or "". */
  link: string;
  /** "andymark.com" for the link, or "". */
  linkHost: string;
  vendor: string;
  quantity: number | null;
  /** Price for the whole line, in cents. Null = not known yet. */
  costCents: number | null;
  /** Null = whole team. */
  subteam: Subteam | null;
  status: PurchaseStatus;
  orderer: OrderPerson | null;
  createdBy: OrderPerson | null;
  /** ISO timestamps. */
  createdAt: string;
  statusChangedAt: string | null;
  /** Last change of any kind (ISO): the status menu and the edit form send it back, so a change made from an out-of-date page is refused. */
  updatedAt: string;
  /** Who made the last status change. */
  statusChangedBy: string | null;
  /** Edit / remove. */
  canEdit: boolean;
  /**
   * The statuses the viewer can pick in the status menu, in order, including the current one. Just the
   * current one = they can't change it (the page shows a badge instead).
   */
  statusOptions: PurchaseStatus[];
  /** The viewer added it or is ordering it. */
  isMine: boolean;
}

export interface OrderList {
  items: OrderItem[];
  /** For the "for" / "mine" filters, whatever the status filter. */
  summary: OrderSummary;
  /** How many items each status tab would show (same "for" / "mine" filters). */
  counts: Record<OrderFilter, number>;
  /** The viewer approves items and changes anyone's (everyone with admin access). */
  canManage: boolean;
  /** More matched than ORDER_LIST_LIMIT. */
  truncated: boolean;
  limit: number;
}

const itemSelect = {
  id: true,
  description: true,
  notes: true,
  link: true,
  vendor: true,
  quantity: true,
  costCents: true,
  subteam: true,
  status: true,
  ordererId: true,
  createdById: true,
  createdAt: true,
  statusChangedAt: true,
  updatedAt: true,
  orderer: { select: { id: true, name: true } },
  createdBy: { select: { id: true, name: true } },
  statusChangedBy: { select: { name: true } },
} as const satisfies Prisma.PurchaseItemSelect;

type ItemRow = Prisma.PurchaseItemGetPayload<{ select: typeof itemSelect }>;

function toItem(actor: ActorLike, r: ItemRow): OrderItem {
  // Rows can be written outside the app: only ever link to http(s).
  const link = r.link ? (parseHttpUrl(r.link) ?? "") : "";
  const targets = purchaseStatusTargets(actor, r);
  return {
    id: r.id,
    description: r.description,
    notes: r.notes,
    link,
    linkHost: linkHost(link),
    vendor: r.vendor,
    quantity: r.quantity,
    costCents: r.costCents,
    subteam: r.subteam,
    status: r.status,
    orderer: r.orderer,
    createdBy: r.createdBy,
    createdAt: r.createdAt.toISOString(),
    statusChangedAt: r.statusChangedAt?.toISOString() ?? null,
    updatedAt: r.updatedAt.toISOString(),
    statusChangedBy: r.statusChangedBy?.name ?? null,
    canEdit: canEditPurchase(actor, r),
    statusOptions: PURCHASE_STATUSES.filter((s) => s === r.status || targets.includes(s)),
    isMine: r.createdById === actor.id || r.ordererId === actor.id,
  };
}

/**
 * List order: status (Requested → Approved → Ordered → Done → N/A). Open items oldest first (the longest
 * waiting on top, like rows added to the bottom of the sheet); done and N/A items most recently changed first.
 */
export function compareOrders(a: OrderItem, b: OrderItem): number {
  const status = PURCHASE_STATUSES.indexOf(a.status) - PURCHASE_STATUSES.indexOf(b.status);
  if (status !== 0) return status;
  if (!isOpenPurchaseStatus(a.status)) {
    const changed = (b.statusChangedAt ?? "").localeCompare(a.statusChangedAt ?? "");
    if (changed !== 0) return changed;
    return b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id);
  }
  return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
}

/** "for" + "mine" (the scope the summary and tab counts follow). */
function scopeWhere(actor: ActorLike, q: Omit<OrderQuery, "filter">): Prisma.PurchaseItemWhereInput {
  return {
    ...(q.for === "team" ? { subteam: null } : q.for ? { subteam: q.for } : {}),
    ...(q.mine ? { OR: [{ ordererId: actor.id }, { createdById: actor.id }] } : {}),
  };
}

function listWhere(actor: ActorLike, q: OrderQuery): Prisma.PurchaseItemWhereInput {
  const statuses = ORDER_FILTERS[q.filter].statuses;
  return { ...scopeWhere(actor, q), ...(statuses ? { status: { in: [...statuses] } } : {}) };
}

/** Database order close to compareOrders, so the ORDER_LIST_LIMIT cut keeps the rows that sort first. */
function dbOrder(filter: OrderFilter): Prisma.PurchaseItemOrderByWithRelationInput[] {
  if (filter === "done" || filter === "na") {
    return [{ statusChangedAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }, { id: "asc" }];
  }
  if (filter === "all") {
    // Open items first; after them, the latest Done / N/A changes (so a cut drops the oldest finished rows).
    return [{ status: "asc" }, { statusChangedAt: { sort: "desc", nulls: "last" } }, { createdAt: "asc" }, { id: "asc" }];
  }
  return [{ status: "asc" }, { createdAt: "asc" }, { id: "asc" }];
}

function allowed(actor: ActorLike): boolean {
  return actor.status === "ACTIVE";
}

const EMPTY_SUMMARY = summarizeOrders([]);

/**
 * The order list page: items matching the status filter (Open = Requested / Approved / Ordered; Done; N/A;
 * All), for one subteam or the whole team, and/or only the viewer's own (added by them or they're ordering it);
 * plus the summary (open items, what the priced open items add up to) and tab counts for the same scope.
 */
export async function listOrders(actor: ActorLike, q: OrderQuery, db: Db = prisma): Promise<OrderList> {
  if (!allowed(actor)) {
    return { items: [], summary: EMPTY_SUMMARY, counts: filterCounts(EMPTY_SUMMARY.counts), canManage: false, truncated: false, limit: ORDER_LIST_LIMIT };
  }
  const [rows, groups] = await Promise.all([
    db.purchaseItem.findMany({ where: listWhere(actor, q), select: itemSelect, orderBy: dbOrder(q.filter), take: ORDER_LIST_LIMIT + 1 }),
    db.purchaseItem.groupBy({
      by: ["status"],
      where: scopeWhere(actor, q),
      _count: { _all: true, costCents: true },
      _sum: { costCents: true },
    }),
  ]);
  const summary = summarizeOrders(
    groups.map((g): OrderStatusGroup => ({
      status: g.status,
      count: g._count._all,
      priced: g._count.costCents,
      sumCents: g._sum.costCents ?? 0,
    })),
  );
  return {
    items: rows
      .slice(0, ORDER_LIST_LIMIT)
      .map((r) => toItem(actor, r))
      .sort(compareOrders),
    summary,
    counts: filterCounts(summary.counts),
    canManage: canManageOrders(actor),
    truncated: rows.length > ORDER_LIST_LIMIT,
    limit: ORDER_LIST_LIMIT,
  };
}

/** Everything matching the filters, for the spreadsheet export (same order as the page). */
export async function listOrdersForExport(actor: ActorLike, q: OrderQuery, db: Db = prisma): Promise<OrderItem[]> {
  if (!allowed(actor)) return [];
  const rows = await db.purchaseItem.findMany({ where: listWhere(actor, q), select: itemSelect, orderBy: dbOrder(q.filter), take: ORDER_EXPORT_LIMIT });
  return rows.map((r) => toItem(actor, r)).sort(compareOrders);
}

export type OrderDetail = OrderItem;

/** One item for its page (anyone ACTIVE may look), or null when it doesn't exist. */
export async function getOrder(actor: ActorLike, id: string, db: Db = prisma): Promise<OrderDetail | null> {
  if (!allowed(actor) || !id || id.length > 64) return null;
  const row = await db.purchaseItem.findUnique({ where: { id }, select: itemSelect });
  if (!row) return null;
  return toItem(actor, row);
}

/** People a manager can pick as the orderer (ACTIVE, by name). Everyone else can't pick, so: none. */
export async function getOrdererOptions(actor: ActorLike, db: Db = prisma): Promise<OrderPerson[]> {
  if (!allowed(actor) || !canManageOrders(actor)) return [];
  return db.user.findMany({ where: { status: "ACTIVE" }, select: { id: true, name: true }, orderBy: [{ name: "asc" }, { id: "asc" }], take: 500 });
}

/** Approved items the viewer is ordering (the Today page's "to order" shortcut). */
export async function countOrdersToOrder(actor: ActorLike, db: Db = prisma): Promise<number> {
  if (!allowed(actor)) return 0;
  return db.purchaseItem.count({ where: { ordererId: actor.id, status: "APPROVED" } });
}

/**
 * Requested items the viewer may approve (the Today page's "to approve" shortcut): none unless they manage the
 * order list; not the ones they added themselves unless they're all-scope (see purchaseStatusTargets).
 */
export async function countOrdersToApprove(actor: ActorLike, db: Db = prisma): Promise<number> {
  if (!allowed(actor) || !canManageOrders(actor)) return 0;
  return db.purchaseItem.count({
    where: {
      status: "REQUESTED",
      ...(hasAllScope(actor) ? {} : { OR: [{ createdById: null }, { createdById: { not: actor.id } }] }),
    },
  });
}
