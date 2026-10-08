import "server-only";
// Sales (Resources → Sales): every ACTIVE person sees the register, the order queue, and the money book; the
// Business subteam and staff (canManageSales) also get the menu and money-book tools.

import type { Prisma } from "@/generated/prisma/client";
import type { LedgerKind, SalePayment, SaleStatus } from "@/generated/prisma/enums";
import { type DateOnly, dateOnlyToDb, dbToDateOnly } from "@/lib/dates";
import { LEDGER_KIND_LABELS, type MoneyBookRow, SALE_PAYMENT_LABELS, SALE_PAYMENTS, type SalesPeriod, periodStart } from "@/lib/sales";
import type { Actor } from "../actor";
import { type Db, prisma } from "../db";
import { canManageSales, canVoidSale } from "../permissions";

type ActorLike = Pick<Actor, "id" | "role" | "subteam" | "isAdmin">;

/** Orders on the queue the page shows at once (a stand rarely has more than a dozen waiting). */
export const SALES_QUEUE_LIMIT = 100;
/** Recently finished orders under the queue. */
export const SALES_RECENT_LIMIT = 30;
/** Rows in the money book's list. */
export const MONEY_BOOK_LIST_LIMIT = 100;
/** Rows in a spreadsheet export. */
export const MONEY_BOOK_EXPORT_LIMIT = 20_000;

export interface SaleMenuItem {
  id: string;
  name: string;
  category: string;
  priceCents: number;
  active: boolean;
}

export interface SalesEventOption {
  id: string;
  name: string;
}

export async function listSaleItems(opts: { includeHidden: boolean }, db: Db = prisma): Promise<SaleMenuItem[]> {
  return db.saleItem.findMany({
    where: opts.includeHidden ? {} : { active: true },
    orderBy: [{ category: "asc" }, { name: "asc" }],
    select: { id: true, name: true, category: true, priceCents: true, active: true },
    take: 500,
  });
}

/** Fundraisers an order or entry can belong to: the ones still being planned or run first, then recent ones. */
export async function listSalesEvents(opts: { openOnly: boolean }, db: Db = prisma): Promise<SalesEventOption[]> {
  return db.fundraiser.findMany({
    where: opts.openOnly ? { status: { in: ["PLANNING", "UPCOMING", "ACTIVE"] } } : { status: { not: "CANCELLED" } },
    orderBy: [{ status: "asc" }, { startsOn: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
    select: { id: true, name: true },
    take: 100,
  });
}

export async function getRegister(actor: ActorLike, db: Db = prisma) {
  const [items, events, openCount] = await Promise.all([
    listSaleItems({ includeHidden: false }, db),
    listSalesEvents({ openOnly: true }, db),
    db.sale.count({ where: { status: "OPEN" } }),
  ]);
  // The fundraiser happening right now is the likely one to sell for.
  const happening = await db.fundraiser.findFirst({
    where: { status: "ACTIVE" },
    orderBy: { startsOn: { sort: "desc", nulls: "last" } },
    select: { id: true },
  });
  return { items, events, defaultEventId: happening?.id ?? "", openCount, canManage: canManageSales(actor) };
}

// ── Order queue ──────────────────────────────────────────────────────────────

export interface SaleSummary {
  id: string;
  number: number;
  customer: string;
  note: string;
  payment: SalePayment;
  status: SaleStatus;
  totalCents: number;
  createdAt: Date;
  servedAt: Date | null;
  soldBy: string | null;
  event: string | null;
  lines: { name: string; quantity: number; priceCents: number }[];
  canVoid: boolean;
}

const saleSelect = {
  id: true,
  number: true,
  customer: true,
  note: true,
  payment: true,
  status: true,
  totalCents: true,
  createdAt: true,
  servedAt: true,
  soldById: true,
  soldBy: { select: { name: true } },
  fundraiser: { select: { name: true } },
  lines: { select: { name: true, quantity: true, priceCents: true }, orderBy: { id: "asc" } },
} satisfies Prisma.SaleSelect;

function toSummary(actor: ActorLike, s: Prisma.SaleGetPayload<{ select: typeof saleSelect }>): SaleSummary {
  return {
    id: s.id,
    number: s.number,
    customer: s.customer,
    note: s.note,
    payment: s.payment,
    status: s.status,
    totalCents: s.totalCents,
    createdAt: s.createdAt,
    servedAt: s.servedAt,
    soldBy: s.soldBy?.name ?? null,
    event: s.fundraiser?.name ?? null,
    lines: s.lines,
    canVoid: s.status !== "VOIDED" && canVoidSale(actor, s),
  };
}

export async function getOrderQueue(actor: ActorLike, db: Db = prisma) {
  const [open, recent] = await Promise.all([
    db.sale.findMany({ where: { status: "OPEN" }, orderBy: { number: "asc" }, select: saleSelect, take: SALES_QUEUE_LIMIT }),
    db.sale.findMany({ where: { status: { not: "OPEN" } }, orderBy: { updatedAt: "desc" }, select: saleSelect, take: SALES_RECENT_LIMIT }),
  ]);
  return { open: open.map((s) => toSummary(actor, s)), recent: recent.map((s) => toSummary(actor, s)) };
}

// ── Money book ───────────────────────────────────────────────────────────────

export interface MoneyBookQuery {
  period: SalesPeriod;
  /** A fundraiser id, "none" (not tied to one), or undefined (everything). */
  event?: string;
}

function dateFilter(q: MoneyBookQuery, today: DateOnly) {
  const start = periodStart(q.period, today);
  return start ? { gte: dateOnlyToDb(start) } : undefined;
}

function eventFilter(q: MoneyBookQuery) {
  if (q.event === undefined) return undefined;
  return q.event === "none" ? null : q.event;
}

function saleWhere(q: MoneyBookQuery, today: DateOnly): Prisma.SaleWhereInput {
  return { status: { not: "VOIDED" }, soldOn: dateFilter(q, today), fundraiserId: eventFilter(q) };
}

function entryWhere(q: MoneyBookQuery, today: DateOnly): Prisma.LedgerEntryWhereInput {
  return { occurredOn: dateFilter(q, today), fundraiserId: eventFilter(q) };
}

export type MoneyBookListRow =
  | {
      type: "sale";
      id: string;
      date: DateOnly;
      at: Date;
      number: number;
      description: string;
      payment: SalePayment;
      amountCents: number;
      event: string | null;
      by: string | null;
    }
  | {
      type: "entry";
      id: string;
      date: DateOnly;
      at: Date;
      kind: LedgerKind;
      description: string;
      payment: SalePayment | null;
      /** Positive for money in, negative for money out. */
      amountCents: number;
      event: string | null;
      by: string | null;
    };

function linesText(lines: { name: string; quantity: number }[]): string {
  return lines.map((l) => (l.quantity === 1 ? l.name : `${l.quantity}× ${l.name}`)).join(", ");
}

async function moneyBookRows(q: MoneyBookQuery, today: DateOnly, take: number, db: Db): Promise<MoneyBookListRow[]> {
  const [sales, entries] = await Promise.all([
    db.sale.findMany({
      where: saleWhere(q, today),
      orderBy: { createdAt: "desc" },
      take,
      select: {
        id: true,
        number: true,
        soldOn: true,
        createdAt: true,
        customer: true,
        payment: true,
        totalCents: true,
        fundraiser: { select: { name: true } },
        soldBy: { select: { name: true } },
        lines: { select: { name: true, quantity: true }, orderBy: { id: "asc" } },
      },
    }),
    db.ledgerEntry.findMany({
      where: entryWhere(q, today),
      orderBy: [{ occurredOn: "desc" }, { createdAt: "desc" }],
      take,
      select: {
        id: true,
        kind: true,
        description: true,
        amountCents: true,
        payment: true,
        occurredOn: true,
        createdAt: true,
        fundraiser: { select: { name: true } },
        createdBy: { select: { name: true } },
      },
    }),
  ]);
  const rows: MoneyBookListRow[] = [
    ...sales.map((s) => ({
      type: "sale" as const,
      id: s.id,
      date: dbToDateOnly(s.soldOn),
      at: s.createdAt,
      number: s.number,
      description: `${linesText(s.lines)}${s.customer ? ` (${s.customer})` : ""}`,
      payment: s.payment,
      amountCents: s.totalCents,
      event: s.fundraiser?.name ?? null,
      by: s.soldBy?.name ?? null,
    })),
    ...entries.map((e) => ({
      type: "entry" as const,
      id: e.id,
      date: dbToDateOnly(e.occurredOn),
      at: e.createdAt,
      kind: e.kind,
      description: e.description,
      payment: e.payment,
      amountCents: e.kind === "EXPENSE" ? -e.amountCents : e.amountCents,
      event: e.fundraiser?.name ?? null,
      by: e.createdBy?.name ?? null,
    })),
  ];
  // Newest day first; within a day, newest first.
  rows.sort((a, b) => (a.date === b.date ? b.at.getTime() - a.at.getTime() : a.date < b.date ? 1 : -1));
  return rows.slice(0, take);
}

export async function getMoneyBook(actor: ActorLike, q: MoneyBookQuery, today: DateOnly, db: Db = prisma) {
  const sWhere = saleWhere(q, today);
  const eWhere = entryWhere(q, today);
  const [salesAgg, byPayment, entryTotals, lineGroups, rows, events] = await Promise.all([
    db.sale.aggregate({ where: sWhere, _sum: { totalCents: true }, _count: true }),
    db.sale.groupBy({ by: ["payment"], where: sWhere, _sum: { totalCents: true } }),
    db.ledgerEntry.groupBy({ by: ["kind"], where: eWhere, _sum: { amountCents: true } }),
    db.saleLine.groupBy({ by: ["name", "priceCents"], where: { sale: sWhere }, _sum: { quantity: true } }),
    moneyBookRows(q, today, MONEY_BOOK_LIST_LIMIT, db),
    listSalesEvents({ openOnly: false }, db),
  ]);

  const salesCents = salesAgg._sum.totalCents ?? 0;
  const incomeCents = entryTotals.find((e) => e.kind === "INCOME")?._sum.amountCents ?? 0;
  const expenseCents = entryTotals.find((e) => e.kind === "EXPENSE")?._sum.amountCents ?? 0;

  const payments = SALE_PAYMENTS.map((p) => ({
    payment: p,
    cents: byPayment.find((b) => b.payment === p)?._sum.totalCents ?? 0,
  })).filter((p) => p.cents > 0);

  const itemMap = new Map<string, { name: string; quantity: number; cents: number }>();
  for (const g of lineGroups) {
    const qty = g._sum.quantity ?? 0;
    const cur = itemMap.get(g.name) ?? { name: g.name, quantity: 0, cents: 0 };
    cur.quantity += qty;
    cur.cents += qty * g.priceCents;
    itemMap.set(g.name, cur);
  }
  const items = [...itemMap.values()].sort((a, b) => b.cents - a.cents || b.quantity - a.quantity || a.name.localeCompare(b.name));

  return {
    totals: {
      salesCents,
      salesCount: salesAgg._count,
      incomeCents,
      expenseCents,
      netCents: salesCents + incomeCents - expenseCents,
    },
    payments,
    items,
    rows,
    events,
    canManage: canManageSales(actor),
  };
}

export async function getMoneyBookExport(q: MoneyBookQuery, today: DateOnly, db: Db = prisma): Promise<MoneyBookRow[]> {
  const rows = await moneyBookRows(q, today, MONEY_BOOK_EXPORT_LIMIT, db);
  return rows.map((r) => ({
    date: r.date,
    kind: r.type === "sale" ? "Sale" : (LEDGER_KIND_LABELS[r.kind] as MoneyBookRow["kind"]),
    description: r.type === "sale" ? `Order #${r.number}: ${r.description}` : r.description,
    payment: r.payment ? SALE_PAYMENT_LABELS[r.payment] : "",
    amountCents: r.amountCents,
    event: r.event ?? "",
    by: r.by ?? "",
  }));
}
