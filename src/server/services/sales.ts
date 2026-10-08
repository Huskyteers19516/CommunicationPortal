// Sales (Resources → Sales): the register at bake sales and food stands, the order queue, and the money book.
// - Everyone ACTIVE rings up orders (prices always come from the menu in the database, never the browser) and marks
//   them served. Orders that need making go on the queue (OPEN) first; others are SERVED right away.
// - Whoever rang an order up, plus the Business subteam and staff (canManageSales), void it: it stays on the
//   record but leaves every total.
// - canManageSales changes the menu and adds/removes money-book entries (supplies bought, cash donations…).
import { z } from "zod";
import { LedgerKind, SalePayment } from "@/generated/prisma/enums";
import { LIMITS } from "@/lib/constants";
import { dateOnlyToDb, todayInTimezone } from "@/lib/dates";
import { PURCHASE_COST_MAX_CENTS, parseCents } from "@/lib/orders";
import { cartTotalCents } from "@/lib/sales";
import { checkbox, dateOnlySchema, idSchema, optionalText, text } from "@/lib/validation";
import { parseInput } from "../action";
import type { ServiceContext } from "../context";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../errors";
import { canManageSales, canVoidSale } from "../permissions";
import { enforceRateLimit } from "../rate-limit";

const HOUR = 60 * 60 * 1000;
/** Register and money-book writes per person per hour: a busy stand rings up a few orders a minute. */
export const SALES_WRITES_PER_HOUR = 600;

const MANAGERS_ONLY = "Only the Business team and leaders can do that.";
export const SALE_ITEM_NOT_FOUND = "That item is no longer on the menu.";
export const SALE_NOT_FOUND = "That order no longer exists.";
const PRICE_MESSAGE = "Enter the price in dollars, like 2.50.";
const AMOUNT_MESSAGE = "Enter an amount above $0, like 24.99.";
const FUNDRAISER_MESSAGE = "That fundraiser no longer exists.";
const EMPTY_ORDER = "Add something to the order first.";

const blankToUndefined = (v: unknown) => (v === null || (typeof v === "string" && v.trim() === "") ? undefined : v);

/** "2.50" / "$2.50" → cents (required). `allowZero` for free items (samples). */
function centsField(message: string, allowZero: boolean) {
  return z
    .preprocess((v) => (v === undefined || v === null ? "" : typeof v === "number" ? String(v) : v), z.string({ error: message }))
    .transform((v, ctx): number => {
      const result = parseCents(v);
      if (!result.ok) {
        ctx.addIssue({ code: "custom", message: result.message });
        return z.NEVER;
      }
      if (result.value === null || (!allowZero && result.value === 0)) {
        ctx.addIssue({ code: "custom", message });
        return z.NEVER;
      }
      return result.value;
    });
}

const paymentField = z.preprocess((v) => blankToUndefined(v) ?? "CASH", z.enum(SalePayment, { error: "Pick how they paid." }));
const fundraiserField = z.preprocess(blankToUndefined, idSchema.optional());

async function guard(ctx: ServiceContext, { manager }: { manager: boolean }) {
  if (ctx.actor.status !== "ACTIVE") throw new ForbiddenError("Your account isn't active.");
  if (manager && !canManageSales(ctx.actor)) throw new ForbiddenError(MANAGERS_ONLY);
  await enforceRateLimit(ctx.db, `sales:${ctx.actor.id}`, SALES_WRITES_PER_HOUR, HOUR, ctx.now);
}

async function assertFundraiser(ctx: ServiceContext, fundraiserId: string | undefined) {
  if (!fundraiserId) return null;
  const f = await ctx.db.fundraiser.findUnique({ where: { id: fundraiserId }, select: { id: true } });
  if (!f) throw new ValidationError(FUNDRAISER_MESSAGE, { fundraiserId: FUNDRAISER_MESSAGE });
  return f.id;
}

// ── Menu ─────────────────────────────────────────────────────────────────────

const itemFields = z.object({
  name: text("Name", LIMITS.saleItemNameMax),
  category: optionalText("Category", LIMITS.saleItemCategoryMax),
  price: centsField(PRICE_MESSAGE, true),
});

export async function createSaleItem(ctx: ServiceContext, raw: unknown) {
  const data = parseInput(itemFields, raw as Record<string, unknown>);
  await guard(ctx, { manager: true });
  const item = await ctx.db.saleItem.create({
    data: { name: data.name, category: data.category ?? "", priceCents: data.price, createdById: ctx.actor.id },
    select: { id: true, name: true },
  });
  return item;
}

const updateItemInput = itemFields.extend({ itemId: idSchema, active: checkbox });

export async function updateSaleItem(ctx: ServiceContext, raw: unknown) {
  const data = parseInput(updateItemInput, raw as Record<string, unknown>);
  await guard(ctx, { manager: true });
  const { count } = await ctx.db.saleItem.updateMany({
    where: { id: data.itemId },
    data: { name: data.name, category: data.category ?? "", priceCents: data.price, active: data.active },
  });
  if (count === 0) throw new NotFoundError(SALE_ITEM_NOT_FOUND);
  return { id: data.itemId, name: data.name };
}

/** Removing keeps past orders as they were (their lines keep the name and price). */
export async function deleteSaleItem(ctx: ServiceContext, raw: unknown) {
  const { itemId } = parseInput(z.object({ itemId: idSchema }), raw as Record<string, unknown>);
  await guard(ctx, { manager: true });
  const removed = await ctx.db.saleItem.deleteMany({ where: { id: itemId } });
  if (removed.count === 0) throw new NotFoundError(SALE_ITEM_NOT_FOUND);
  return { id: itemId };
}

// ── Orders ───────────────────────────────────────────────────────────────────

const quantityField = z.coerce
  .number({ error: "Enter how many." })
  .int("Enter a whole number.")
  .min(1, "Enter how many.")
  .max(LIMITS.saleQuantityMax, `Up to ${LIMITS.saleQuantityMax} of one thing per order.`);

const lineSchema = z.union([
  z.object({ itemId: idSchema, quantity: quantityField }),
  z.object({
    name: text("The custom item's name", LIMITS.saleItemNameMax),
    priceCents: z.number().int().min(0, PRICE_MESSAGE).max(PURCHASE_COST_MAX_CENTS, PRICE_MESSAGE),
    quantity: quantityField,
  }),
]);

/** The register sends its lines as JSON in one form field. */
const linesField = z.preprocess(
  (v) => {
    if (typeof v !== "string") return v;
    try {
      return JSON.parse(v);
    } catch {
      return null;
    }
  },
  z
    .array(lineSchema, { error: EMPTY_ORDER })
    .min(1, EMPTY_ORDER)
    .max(LIMITS.saleLinesMax, `Up to ${LIMITS.saleLinesMax} different things per order — ring up the rest as a second order.`),
);

const saleInput = z.object({
  lines: linesField,
  customer: optionalText("Name", LIMITS.saleCustomerMax),
  note: optionalText("Note", LIMITS.saleNoteMax),
  payment: paymentField,
  /** Needs making: goes on the order queue first. */
  queue: checkbox,
  fundraiserId: fundraiserField,
});

export async function createSale(ctx: ServiceContext, raw: unknown) {
  const data = parseInput(saleInput, raw as Record<string, unknown>);
  await guard(ctx, { manager: false });
  const fundraiserId = await assertFundraiser(ctx, data.fundraiserId);

  const itemIds = [...new Set(data.lines.flatMap((l) => ("itemId" in l ? [l.itemId] : [])))];
  const items = await ctx.db.saleItem.findMany({
    where: { id: { in: itemIds }, active: true },
    select: { id: true, name: true, priceCents: true },
  });
  const byId = new Map(items.map((i) => [i.id, i]));
  const lines = data.lines.map((l) => {
    if (!("itemId" in l)) return { itemId: null, name: l.name, priceCents: l.priceCents, quantity: l.quantity };
    const item = byId.get(l.itemId);
    // Someone took it off the menu (or changed it) while the register was open.
    if (!item) throw new ConflictError("Something on this order was just taken off the menu. The menu has been refreshed — check the order and try again.");
    return { itemId: item.id, name: item.name, priceCents: item.priceCents, quantity: l.quantity };
  });
  const totalCents = cartTotalCents(lines);
  if (totalCents > PURCHASE_COST_MAX_CENTS) throw new ValidationError("That order is too big for one sale — split it up.");

  const sale = await ctx.db.sale.create({
    data: {
      customer: data.customer ?? "",
      note: data.note ?? "",
      payment: data.payment,
      status: data.queue ? "OPEN" : "SERVED",
      servedAt: data.queue ? null : ctx.now,
      servedById: data.queue ? null : ctx.actor.id,
      totalCents,
      soldOn: dateOnlyToDb(todayInTimezone(ctx.config.teamTimezone, ctx.now)),
      fundraiserId,
      soldById: ctx.actor.id,
      createdAt: ctx.now,
      lines: { create: lines },
    },
    select: { id: true, number: true, totalCents: true, status: true },
  });
  return sale;
}

const saleIdInput = z.object({ saleId: idSchema });

/** Off the queue: handed to the customer. */
export async function markSaleServed(ctx: ServiceContext, raw: unknown) {
  const { saleId } = parseInput(saleIdInput, raw as Record<string, unknown>);
  await guard(ctx, { manager: false });
  const { count } = await ctx.db.sale.updateMany({
    where: { id: saleId, status: "OPEN" },
    data: { status: "SERVED", servedAt: ctx.now, servedById: ctx.actor.id },
  });
  if (count === 1) return { id: saleId };
  const sale = await ctx.db.sale.findUnique({ where: { id: saleId }, select: { number: true, status: true } });
  if (!sale) throw new NotFoundError(SALE_NOT_FOUND);
  throw new ConflictError(sale.status === "VOIDED" ? `Order #${sale.number} was voided.` : `Order #${sale.number} was already served.`);
}

/** Back on the queue (marked served by mistake). */
export async function reopenSale(ctx: ServiceContext, raw: unknown) {
  const { saleId } = parseInput(saleIdInput, raw as Record<string, unknown>);
  await guard(ctx, { manager: false });
  const { count } = await ctx.db.sale.updateMany({
    where: { id: saleId, status: "SERVED" },
    data: { status: "OPEN", servedAt: null, servedById: null },
  });
  if (count === 1) return { id: saleId };
  const sale = await ctx.db.sale.findUnique({ where: { id: saleId }, select: { number: true, status: true } });
  if (!sale) throw new NotFoundError(SALE_NOT_FOUND);
  throw new ConflictError(sale.status === "VOIDED" ? `Order #${sale.number} was voided.` : `Order #${sale.number} is already on the queue.`);
}

/** Rung up by mistake or refunded: kept on the record, left out of every total. */
export async function voidSale(ctx: ServiceContext, raw: unknown) {
  const { saleId } = parseInput(saleIdInput, raw as Record<string, unknown>);
  if (ctx.actor.status !== "ACTIVE") throw new ForbiddenError("Your account isn't active.");
  const sale = await ctx.db.sale.findUnique({ where: { id: saleId }, select: { number: true, status: true, soldById: true } });
  if (!sale) throw new NotFoundError(SALE_NOT_FOUND);
  if (!canVoidSale(ctx.actor, sale)) throw new ForbiddenError("Only whoever rang it up, the Business team, and leaders can void an order.");
  await guard(ctx, { manager: false });
  const { count } = await ctx.db.sale.updateMany({
    where: { id: saleId, status: { not: "VOIDED" } },
    data: { status: "VOIDED", voidedAt: ctx.now, voidedById: ctx.actor.id },
  });
  if (count === 0) throw new ConflictError(`Order #${sale.number} was already voided.`);
  return { id: saleId, number: sale.number };
}

// ── Money book ───────────────────────────────────────────────────────────────

const ledgerInput = z.object({
  kind: z.enum(LedgerKind, { error: "Pick money in or money out." }),
  description: text("What it was for", LIMITS.ledgerDescriptionMax),
  amount: centsField(AMOUNT_MESSAGE, false),
  payment: z.preprocess(blankToUndefined, z.enum(SalePayment, { error: "Pick how it was paid." }).optional()),
  occurredOn: dateOnlySchema,
  fundraiserId: fundraiserField,
});

export async function createLedgerEntry(ctx: ServiceContext, raw: unknown) {
  const data = parseInput(ledgerInput, raw as Record<string, unknown>);
  await guard(ctx, { manager: true });
  const fundraiserId = await assertFundraiser(ctx, data.fundraiserId);
  const entry = await ctx.db.ledgerEntry.create({
    data: {
      kind: data.kind,
      description: data.description,
      amountCents: data.amount,
      payment: data.payment ?? null,
      occurredOn: dateOnlyToDb(data.occurredOn),
      fundraiserId,
      createdById: ctx.actor.id,
    },
    select: { id: true },
  });
  return entry;
}

export async function deleteLedgerEntry(ctx: ServiceContext, raw: unknown) {
  const { entryId } = parseInput(z.object({ entryId: idSchema }), raw as Record<string, unknown>);
  await guard(ctx, { manager: true });
  const { count } = await ctx.db.ledgerEntry.deleteMany({ where: { id: entryId } });
  if (count === 0) throw new NotFoundError("That entry was already removed.");
  return { id: entryId };
}
