// Order list (/orders): what the team needs to buy (replaces the "Purchase List" sheet).
// - Anyone ACTIVE adds an item. They're its orderer unless a manager picks someone else (ACTIVE people only).
// - Managers (everyone with admin access, `canManageOrders`) approve items, set any status, edit or remove
//   anything, and pick the orderer. Only all-scope staff approve items they added themselves.
// - Everyone else changes or removes their own items (added by them, or they're the orderer) while still
//   Requested; the orderer and the Business subteam (who buy for the team) move an approved item
//   Approved → Ordered → Done (and one step back).
// - The status menu sends what it showed (`from`, and `seen` = the item's updatedAt), and the edit form sends
//   `seen`: a change made from an out-of-date page is refused ("X just changed it to Y") instead of undoing
//   someone else's change, and nobody approves an item that was edited after they looked at it.
// Every status change records who made it and when. Writes are rate-limited per person. No emails.
import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { PurchaseStatus, Subteam } from "@/generated/prisma/enums";
import { LIMITS, PURCHASE_STATUS_LABELS } from "@/lib/constants";
import { COST_FORMAT_MESSAGE, parseCents } from "@/lib/orders";
import { parseHttpUrl } from "@/lib/urls";
import { idSchema, optionalText, text } from "@/lib/validation";
import { parseInput } from "../action";
import type { ServiceContext } from "../context";
import { ConflictError, ForbiddenError, NotFoundError, RateLimitError, ValidationError } from "../errors";
import { canAddPurchaseWithStatus, canEditPurchase, canManageOrders, canSetPurchaseStatus } from "../permissions";
import { consumeRateLimit } from "../rate-limit";

const HOUR = 60 * 60 * 1000;
/** Changes per person per hour (the status menu saves on every change, like the sheet's dropdown). */
export const ORDER_WRITES_PER_HOUR = 120;
/** New items per person per hour (also counted in the writes above). Plenty for a shopping list; stops scripted floods. */
export const ORDER_ADDS_PER_HOUR = 30;

export const ORDER_NOT_FOUND = "That item is no longer on the order list.";
/** Saving the edit form over someone else's change (the page is then refreshed, so saving again keeps this version). */
export const ORDER_EDIT_CONFLICT = "Someone else changed this item while you were editing it. Save again to keep your version, or cancel to see theirs.";
/** Approving (or any change out of Requested) after the item was edited, or the page is otherwise out of date. */
export const ORDER_CHANGED_MEANWHILE = "Someone changed this item after you opened the page. Check it and try again.";
const INACTIVE = "Your account isn't active.";
const MANAGERS = "leaders";
const CANT_PICK_ORDERER = `Only ${MANAGERS} can pick someone else to order it.`;
const CANT_SET_STATUS = `Only ${MANAGERS} can approve items or change their status.`;
const ADD_AS_REQUESTED = "Add it as Requested: someone else approves what you add.";
const ORDERER_GONE = "Pick someone who's on the team now.";
const LINK_MESSAGE = "Enter a web link to the product, like andymark.com/…";
const QUANTITY_MESSAGE = `Enter a quantity from 1 to ${LIMITS.purchaseQuantityMax.toLocaleString("en-US")}, or leave it empty.`;
const STALE_PAGE = "This page is out of date. Reload it and try again.";

/** The edit form was saved over someone else's change (the item is still the viewer's to change). */
export class OrderEditConflictError extends ConflictError {
  constructor() {
    super(ORDER_EDIT_CONFLICT);
  }
}
/** Longest text the cost box takes (after trimming). */
const COST_INPUT_MAX = 40;

// ---------- input schemas ----------

/**
 * "andymark.com/…" → "https://andymark.com/…"; anything with a scheme (or that doesn't look like a web address)
 * is left for parseHttpUrl to accept or refuse. Same rule as the parts queue's file link.
 */
function withHttps(value: string): string {
  const v = value.trim();
  if (!v || /^[a-z][a-z0-9+.-]*:\/\//i.test(v)) return v;
  return /^(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}(:\d+)?([/?#]\S*)?$/i.test(v) ? `https://${v}` : v;
}

const emptyIfMissing = (v: unknown) => (v === undefined || v === null ? "" : v);
const missingIfBlank = (v: unknown) => (v === undefined || v === null || v === "" ? undefined : v);

/** "" = no link; otherwise an absolute http(s) link (normalized; https:// added to a bare address). */
const linkField = z.preprocess(
  emptyIfMissing,
  z
    .string({ error: LINK_MESSAGE })
    .trim()
    .transform((v, ctx) => {
      if (v === "") return "";
      const url = parseHttpUrl(withHttps(v));
      if (!url) {
        ctx.addIssue({ code: "custom", message: LINK_MESSAGE });
        return z.NEVER;
      }
      return url;
    }),
);

/** "" / missing = not given (null); otherwise a whole number 1..LIMITS.purchaseQuantityMax. */
const quantityField = z.preprocess(
  (v) => {
    if (v === undefined || v === null) return null;
    if (typeof v !== "string") return v;
    const s = v.trim().replace(/,/g, "");
    if (s === "") return null;
    return /^\d+$/.test(s) ? Number(s) : Number.NaN;
  },
  z
    .number({ error: QUANTITY_MESSAGE })
    .int(QUANTITY_MESSAGE)
    .min(1, QUANTITY_MESSAGE)
    .max(LIMITS.purchaseQuantityMax, QUANTITY_MESSAGE)
    .nullable(),
);

/** The price for the whole line, typed in dollars ("$12.99", "1,200") → cents; "" = unknown (null). */
const costField = z.preprocess(
  emptyIfMissing,
  z
    .string({ error: "Enter the price in dollars." })
    .trim()
    .transform((v, ctx) => {
      const parsed = v.length > COST_INPUT_MAX ? ({ ok: false, message: COST_FORMAT_MESSAGE } as const) : parseCents(v);
      if (!parsed.ok) {
        ctx.addIssue({ code: "custom", message: parsed.message });
        return z.NEVER;
      }
      return parsed.value;
    }),
);

/** "" / "team" = the whole team (null); otherwise a subteam. */
const subteamField = z.preprocess(
  (v) => (v === undefined || v === null || v === "" || v === "team" ? null : v),
  z.enum(Subteam, { error: "Pick who it's for." }).nullable(),
);

/** Missing = keep (or yourself, when adding); "" = no one yet; otherwise a user id. */
const ordererField = z.preprocess(
  (v) => (v === null ? undefined : v),
  z.string({ error: ORDERER_GONE }).trim().max(64, ORDERER_GONE).optional(),
);

/** When the item the page showed was last changed (its updatedAt, ISO). Missing = not sent (no check). */
const seenField = z.preprocess(
  missingIfBlank,
  z.iso
    .datetime({ error: STALE_PAGE })
    .transform((v) => new Date(v))
    .optional(),
);

const itemFields = {
  description: text("Description", LIMITS.purchaseDescriptionMax),
  notes: optionalText("Notes", LIMITS.purchaseNotesMax),
  link: linkField,
  vendor: optionalText("Vendor", LIMITS.purchaseVendorMax),
  quantity: quantityField,
  cost: costField,
  subteam: subteamField,
  ordererId: ordererField,
};

const createInput = z.object({
  ...itemFields,
  /** All-scope staff only (e.g. adding something already bought); missing = Requested. */
  status: z.preprocess((v) => (v === "" || v === null ? undefined : v), z.enum(PurchaseStatus, { error: "Pick a status." }).optional()),
});
const itemIdInput = z.object({ itemId: idSchema });
const updateInput = z.object({ itemId: idSchema, ...itemFields, seen: seenField });
const statusInput = z.object({
  itemId: idSchema,
  status: z.enum(PurchaseStatus, { error: "Pick a status." }),
  /** The status the menu showed. Missing = not sent (the status the item has when it's loaded). */
  from: z.preprocess(missingIfBlank, z.enum(PurchaseStatus, { error: STALE_PAGE }).optional()),
  seen: seenField,
});

type ItemFields = z.infer<z.ZodObject<typeof itemFields>>;

// ---------- helpers ----------

function asRecord(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

function requireActive(ctx: ServiceContext) {
  if (ctx.actor.status !== "ACTIVE") throw new ForbiddenError(INACTIVE);
}

/** The hourly allowance for changes to the order list; adding an item also counts toward ORDER_ADDS_PER_HOUR. */
async function limitWrites(ctx: ServiceContext, opts: { adding?: boolean } = {}) {
  const { db, actor, now } = ctx;
  if (opts.adding && !(await consumeRateLimit(db, `order-add:${actor.id}`, ORDER_ADDS_PER_HOUR, HOUR, now))) {
    throw new RateLimitError("You've added a lot of items in the last hour. Please wait a bit and try again.");
  }
  if (!(await consumeRateLimit(db, `orders:${actor.id}`, ORDER_WRITES_PER_HOUR, HOUR, now))) {
    throw new RateLimitError("You've made a lot of changes to the order list in the last hour. Please wait a bit and try again.");
  }
}

function columns(f: ItemFields) {
  return {
    description: f.description,
    notes: f.notes ?? "",
    link: f.link,
    vendor: f.vendor ?? "",
    quantity: f.quantity,
    costCents: f.cost,
    subteam: f.subteam,
  };
}

/** A manager's pick must be ACTIVE (`keep`: the item's current orderer may stay even after they've left). */
async function assertOrderer(ctx: ServiceContext, ordererId: string | null, keep: string | null = null) {
  if (ordererId === null || ordererId === keep) return;
  const user = await ctx.db.user.findUnique({ where: { id: ordererId }, select: { status: true } });
  if (user?.status !== "ACTIVE") throw new ValidationError(ORDERER_GONE, { ordererId: ORDERER_GONE });
}

/**
 * Who orders it. Managers: what they picked ("" = no one yet). Everyone else: themselves when adding, unchanged
 * when editing — picking anyone else is refused.
 */
async function resolveOrderer(ctx: ServiceContext, picked: string | undefined, current: string | null | undefined): Promise<string | null> {
  const adding = current === undefined;
  const fallback = adding ? ctx.actor.id : current;
  if (picked === undefined) return fallback;
  if (canManageOrders(ctx.actor)) {
    const ordererId = picked === "" ? null : picked;
    await assertOrderer(ctx, ordererId, adding ? null : current);
    return ordererId;
  }
  if (picked === "" || picked === fallback) return fallback;
  throw new ForbiddenError(CANT_PICK_ORDERER);
}

const itemSelect = {
  id: true,
  description: true,
  status: true,
  ordererId: true,
  createdById: true,
  updatedAt: true,
} as const satisfies Prisma.PurchaseItemSelect;

async function loadItem(ctx: ServiceContext, itemId: string) {
  const item = await ctx.db.purchaseItem.findUnique({ where: { id: itemId }, select: itemSelect });
  if (!item) throw new NotFoundError(ORDER_NOT_FOUND);
  return item;
}

/** Non-managers' writes only land while they may still make them (it's Requested, and theirs). */
function ownRequestedWhere(ctx: ServiceContext, itemId: string): Prisma.PurchaseItemWhereInput {
  if (canManageOrders(ctx.actor)) return { id: itemId };
  return { id: itemId, status: "REQUESTED", OR: [{ createdById: ctx.actor.id }, { ordererId: ctx.actor.id }] };
}

/**
 * Why a conditional edit or removal matched nothing: gone, approved (or reassigned) meanwhile so it isn't the
 * viewer's to change any more, or — still theirs — someone else saved a change after they opened it.
 */
async function explainMiss(ctx: ServiceContext, itemId: string, verb: "change" | "remove") {
  const now = await ctx.db.purchaseItem.findUnique({ where: { id: itemId }, select: { status: true, ordererId: true, createdById: true } });
  if (!now) return new NotFoundError(ORDER_NOT_FOUND);
  if (!canEditPurchase(ctx.actor, now)) {
    const what = now.status === "REQUESTED" ? "Someone else is ordering this item now" : `This item is ${PURCHASE_STATUS_LABELS[now.status]} now`;
    return new ConflictError(`${what}, so only ${MANAGERS} can ${verb} it.`);
  }
  return verb === "change" ? new OrderEditConflictError() : new ConflictError(ORDER_CHANGED_MEANWHILE);
}

/** Why someone who isn't a manager may not change or remove an item. */
function cantEdit(item: { status: PurchaseStatus }, verb: "change" | "remove"): string {
  if (item.status !== "REQUESTED") return `This item is ${PURCHASE_STATUS_LABELS[item.status]} now, so only ${MANAGERS} can ${verb} it.`;
  return `Only whoever added it, the person ordering it, and ${MANAGERS} can ${verb} it.`;
}

/** What to say when someone may not move an item to `to`. */
function statusDenied(ctx: ServiceContext, item: { status: PurchaseStatus; ordererId: string | null }, to: PurchaseStatus): string {
  // A manager is only ever refused approving their own request (see purchaseStatusTargets).
  if (canManageOrders(ctx.actor)) return "You added this item, so someone else needs to approve it.";
  const buyer = ctx.actor.subteam === "BUSINESS" || (item.ordererId !== null && item.ordererId === ctx.actor.id);
  if (!buyer) return `Only the person ordering it, the Business team, and ${MANAGERS} can change its status.`;
  if (item.status === "REQUESTED") return `It needs to be approved first. Only ${MANAGERS} can approve items.`;
  if (to === "NOT_NEEDED" || item.status === "NOT_NEEDED") return `Only ${MANAGERS} can mark items N/A or bring them back.`;
  if (to === "REQUESTED") return `Only ${MANAGERS} can send items back to Requested.`;
  return "Move it one step at a time: Approved → Ordered → Done.";
}

/** "Ava Thompson just changed it to N/A." — when the status isn't what the viewer's page showed. */
async function changedMeanwhile(ctx: ServiceContext, itemId: string): Promise<Error> {
  const now = await ctx.db.purchaseItem.findUnique({
    where: { id: itemId },
    select: { status: true, statusChangedById: true, statusChangedBy: { select: { name: true } } },
  });
  if (!now) return new NotFoundError(ORDER_NOT_FOUND);
  const who = now.statusChangedById === ctx.actor.id ? "You" : (now.statusChangedBy?.name ?? "Someone");
  return new ConflictError(`${who} just changed it to ${PURCHASE_STATUS_LABELS[now.status]}.`);
}

// ---------- services ----------

/**
 * Add an item. Anyone ACTIVE; they're its orderer unless a manager picks someone else (or no one yet).
 * All-scope staff may also add it with another status (e.g. something already bought) — that counts as a
 * status change. For anyone else that would be approving their own request.
 */
export async function createOrder(ctx: ServiceContext, raw: unknown): Promise<{ id: string; status: PurchaseStatus }> {
  requireActive(ctx);
  const data = parseInput(createInput, asRecord(raw));
  const status = data.status ?? "REQUESTED";
  if (status !== "REQUESTED" && !canAddPurchaseWithStatus(ctx.actor)) {
    throw new ForbiddenError(canManageOrders(ctx.actor) ? ADD_AS_REQUESTED : CANT_SET_STATUS);
  }
  const ordererId = await resolveOrderer(ctx, data.ordererId, undefined);
  await limitWrites(ctx, { adding: true });
  const item = await ctx.db.purchaseItem.create({
    data: {
      ...columns(data),
      status,
      ordererId,
      createdById: ctx.actor.id,
      ...(status === "REQUESTED" ? {} : { statusChangedAt: ctx.now, statusChangedById: ctx.actor.id }),
    },
    select: { id: true },
  });
  return { id: item.id, status };
}

/**
 * Save the edit form (not the status: that's the status menu). Managers: any item. Whoever added it or is ordering
 * it: while it's still Requested (checked again in the write, so an approval that lands first wins). With `seen`
 * (the form sends the item's updatedAt), a save over someone else's change is refused once.
 */
export async function updateOrder(ctx: ServiceContext, raw: unknown): Promise<{ id: string; status: PurchaseStatus }> {
  requireActive(ctx);
  const rec = asRecord(raw);
  const { itemId } = parseInput(itemIdInput, rec);
  const item = await loadItem(ctx, itemId);
  if (!canEditPurchase(ctx.actor, item)) throw new ForbiddenError(cantEdit(item, "change"));
  const data = parseInput(updateInput, rec);
  if (data.seen && data.seen.getTime() !== item.updatedAt.getTime()) throw new OrderEditConflictError();
  const ordererId = await resolveOrderer(ctx, data.ordererId, item.ordererId);
  await limitWrites(ctx);
  const { count } = await ctx.db.purchaseItem.updateMany({
    where: { ...ownRequestedWhere(ctx, item.id), ...(data.seen ? { updatedAt: data.seen } : {}) },
    // Only managers change who orders it: everyone else can only keep it, so it's left out of their write (a
    // manager's reassignment that lands first stays).
    data: { ...columns(data), ...(canManageOrders(ctx.actor) ? { ordererId } : {}) },
  });
  if (count === 0) throw await explainMiss(ctx, item.id, "change");
  const now = await ctx.db.purchaseItem.findUnique({ where: { id: item.id }, select: { status: true } });
  return { id: item.id, status: now?.status ?? item.status };
}

/**
 * Remove an item (for good): managers any; whoever added it or is ordering it, while it's still Requested.
 * Returns the status it had, so the list can go back to that tab.
 */
export async function deleteOrder(ctx: ServiceContext, raw: unknown): Promise<{ description: string; status: PurchaseStatus }> {
  requireActive(ctx);
  const { itemId } = parseInput(itemIdInput, asRecord(raw));
  const item = await loadItem(ctx, itemId);
  if (!canEditPurchase(ctx.actor, item)) throw new ForbiddenError(cantEdit(item, "remove"));
  await limitWrites(ctx);
  const { count } = await ctx.db.purchaseItem.deleteMany({ where: ownRequestedWhere(ctx, item.id) });
  if (count === 0) throw await explainMiss(ctx, item.id, "remove");
  return { description: item.description, status: item.status };
}

export interface OrderStatusChange {
  id: string;
  status: PurchaseStatus;
  /** False when it already had that status (nothing was written). */
  changed: boolean;
}

/**
 * The status menu. Managers: any status (not approving their own request, unless all-scope). The orderer and the
 * Business subteam: one step along Approved → Ordered → Done. Every change only lands on the status it was made
 * from — `from` (what the menu showed) when sent, else what the item had when loaded — so an out-of-date menu
 * never undoes someone else's change; and leaving Requested with `seen` needs the item unchanged since it was
 * seen (nobody approves an edit they haven't looked at). Records who and when.
 */
export async function setOrderStatus(ctx: ServiceContext, raw: unknown): Promise<OrderStatusChange> {
  requireActive(ctx);
  const { itemId, status, from, seen } = parseInput(statusInput, asRecord(raw));
  const item = await loadItem(ctx, itemId);
  if (item.status === status) return { id: item.id, status, changed: false };
  if (from !== undefined && from !== item.status) throw await changedMeanwhile(ctx, item.id);
  if (!canSetPurchaseStatus(ctx.actor, item, status)) throw new ForbiddenError(statusDenied(ctx, item, status));
  // Leaving Requested is a decision about what the item says: it must still say what the viewer saw.
  const seenAt = item.status === "REQUESTED" ? seen : undefined;
  if (seenAt && item.updatedAt.getTime() !== seenAt.getTime()) throw new ConflictError(ORDER_CHANGED_MEANWHILE);
  await limitWrites(ctx);
  const { count } = await ctx.db.purchaseItem.updateMany({
    where: {
      id: item.id,
      status: item.status,
      // What the permission was checked on: the orderer (a manager's rights don't depend on it).
      ...(canManageOrders(ctx.actor) ? {} : { ordererId: item.ordererId }),
      ...(seenAt ? { updatedAt: seenAt } : {}),
    },
    data: { status, statusChangedAt: ctx.now, statusChangedById: ctx.actor.id },
  });
  if (count > 0) return { id: item.id, status, changed: true };
  const now = await ctx.db.purchaseItem.findUnique({ where: { id: item.id }, select: { status: true, ordererId: true, createdById: true } });
  if (!now) throw new NotFoundError(ORDER_NOT_FOUND);
  if (now.status === status) return { id: item.id, status, changed: false };
  if (now.status !== item.status) throw await changedMeanwhile(ctx, item.id);
  if (now.ordererId !== item.ordererId && !canSetPurchaseStatus(ctx.actor, now, status)) {
    throw new ConflictError("Someone else is ordering this item now.");
  }
  throw new ConflictError(ORDER_CHANGED_MEANWHILE);
}
