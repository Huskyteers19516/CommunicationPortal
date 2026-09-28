import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PurchaseStatus, Subteam } from "@/generated/prisma/enums";
import { LIMITS } from "@/lib/constants";
import {
  COST_FORMAT_MESSAGE,
  COST_NEGATIVE_MESSAGE,
  csvCell,
  filterForStatus,
  ORDER_CSV_HEADER,
  type OrderSummary,
  orderSummaryText,
  ordersExportFilename,
  ordersExportHref,
  ordersHref,
  ordersToCsv,
  parseCents,
  parseOrderFilter,
  parseOrderFor,
  PURCHASE_COST_MAX_CENTS,
  toCsv,
} from "@/lib/orders";
import type { Actor } from "@/server/actor";
import type { Db } from "@/server/db";
import { ConflictError, ForbiddenError, NotFoundError, RateLimitError, ValidationError } from "@/server/errors";
import {
  canAddPurchaseWithStatus,
  canEditPurchase,
  canManageOrders,
  canSetPurchaseStatus,
  purchaseStatusTargets,
} from "@/server/permissions";
import { countOrdersToApprove, countOrdersToOrder, getOrder, getOrdererOptions, listOrders, listOrdersForExport } from "@/server/queries/orders";
import {
  createOrder,
  deleteOrder,
  ORDER_ADDS_PER_HOUR,
  ORDER_CHANGED_MEANWHILE,
  ORDER_EDIT_CONFLICT,
  ORDER_NOT_FOUND,
  ORDER_WRITES_PER_HOUR,
  setOrderStatus,
  updateOrder,
} from "@/server/services/orders";
import { createTestDb, type TestDb } from "./helpers/db";
import { contextFor, makeUser, TEST_NOW, TEST_TZ } from "./helpers/factories";

let t: TestDb;
let p: Record<
  | "admin"
  | "captain"
  | "mentor"
  | "teacher"
  | "buildLead"
  | "swLead"
  | "bizLead"
  | "bizMember"
  | "asker"
  | "orderer"
  | "buildMember"
  | "swMember"
  | "pending"
  | "disabled",
  Actor
>;

beforeAll(async () => {
  t = await createTestDb();
  const db = t.db;
  p = {
    // An owner on the Build subteam: manages orders because of admin access, not the Business subteam.
    admin: await makeUser(db, { role: "MEMBER", subteam: "BUILD", isAdmin: true, name: "Ada Admin" }),
    captain: await makeUser(db, { role: "CAPTAIN", name: "Casey Captain" }),
    mentor: await makeUser(db, { role: "MENTOR", name: "Morgan Mentor" }),
    teacher: await makeUser(db, { role: "TEACHER", name: "Taylor Teacher" }),
    buildLead: await makeUser(db, { role: "BUILD_LEADER", name: "Blake Build" }),
    swLead: await makeUser(db, { role: "SOFTWARE_LEADER", name: "Sam Software" }),
    bizLead: await makeUser(db, { role: "BUSINESS_LEADER", name: "Bo Business" }),
    bizMember: await makeUser(db, { role: "MEMBER", subteam: "BUSINESS", name: "Ava Business" }),
    asker: await makeUser(db, { role: "MEMBER", subteam: "BUILD", name: "Ethan Asker" }),
    orderer: await makeUser(db, { role: "MEMBER", subteam: "BUILD", name: "Olivia Orderer" }),
    buildMember: await makeUser(db, { role: "MEMBER", subteam: "BUILD", name: "Liam Build" }),
    swMember: await makeUser(db, { role: "MEMBER", subteam: "SOFTWARE", name: "Maya Software" }),
    pending: await makeUser(db, { role: "MEMBER", subteam: "BUILD", status: "PENDING", name: "Pat Pending" }),
    disabled: await makeUser(db, { role: "MEMBER", subteam: "BUILD", status: "DISABLED", name: "Dee Disabled" }),
  };
});

afterAll(async () => {
  await t?.drop();
});

beforeEach(async () => {
  await t.db.purchaseItem.deleteMany();
  await t.db.rateLimit.deleteMany();
});

const ctxFor = (a: Actor) => contextFor(t.db, a);

async function errorOf(promise: Promise<unknown>) {
  const err = await promise.catch((e) => e);
  expect(err).toBeInstanceOf(Error);
  return err as Error & { userMessage: string; fieldErrors?: Record<string, string> };
}

/** An item straight in the DB (bypassing services). */
async function makeItem(
  input: {
    description?: string;
    status?: PurchaseStatus;
    orderer?: Actor | null;
    createdBy?: Actor | null;
    subteam?: Subteam | null;
    costCents?: number | null;
    quantity?: number | null;
    link?: string;
    notes?: string;
    createdAt?: Date;
    statusChangedAt?: Date | null;
    statusChangedBy?: Actor | null;
  } = {},
) {
  return t.db.purchaseItem.create({
    data: {
      description: input.description ?? `Item ${Math.random().toString(36).slice(2, 8)}`,
      status: input.status ?? "REQUESTED",
      ordererId: input.orderer === undefined ? p.orderer.id : (input.orderer?.id ?? null),
      createdById: input.createdBy === undefined ? p.asker.id : (input.createdBy?.id ?? null),
      subteam: input.subteam === undefined ? "BUILD" : input.subteam,
      costCents: input.costCents ?? null,
      quantity: input.quantity ?? null,
      link: input.link ?? "",
      notes: input.notes ?? "",
      statusChangedAt: input.statusChangedAt ?? null,
      statusChangedById: input.statusChangedBy?.id ?? null,
      ...(input.createdAt ? { createdAt: input.createdAt } : {}),
    },
  });
}

const row = (id: string) => t.db.purchaseItem.findUniqueOrThrow({ where: { id } });
const hoursAgo = (h: number) => new Date(TEST_NOW.getTime() - h * 60 * 60 * 1000);

// ── permissions ─────────────────────────────────────────────────────────────

describe("order list permissions", () => {
  it("lets everyone with admin access manage the list, and nobody else (picking the Business subteam at sign-up isn't enough)", () => {
    for (const who of ["admin", "captain", "mentor", "teacher", "buildLead", "swLead", "bizLead"] as const) {
      expect(canManageOrders(p[who]), who).toBe(true);
    }
    for (const who of ["bizMember", "asker", "orderer", "buildMember", "swMember"] as const) {
      expect(canManageOrders(p[who]), who).toBe(false);
    }
    // Adding an item that's already approved or bought: all-scope staff only.
    for (const who of ["admin", "captain", "mentor", "teacher"] as const) expect(canAddPurchaseWithStatus(p[who]), who).toBe(true);
    for (const who of ["buildLead", "swLead", "bizLead", "bizMember", "asker"] as const) expect(canAddPurchaseWithStatus(p[who]), who).toBe(false);
  });

  it("lets whoever added it or orders it edit only while Requested; managers any time", () => {
    const item = (status: PurchaseStatus) => ({ status, createdById: p.asker.id, ordererId: p.orderer.id });
    expect(canEditPurchase(p.asker, item("REQUESTED"))).toBe(true);
    expect(canEditPurchase(p.orderer, item("REQUESTED"))).toBe(true);
    expect(canEditPurchase(p.buildMember, item("REQUESTED"))).toBe(false);
    for (const s of ["APPROVED", "ORDERED", "DONE", "NOT_NEEDED"] as const) {
      expect(canEditPurchase(p.asker, item(s)), s).toBe(false);
      expect(canEditPurchase(p.orderer, item(s)), s).toBe(false);
      expect(canEditPurchase(p.bizLead, item(s)), s).toBe(true);
      expect(canEditPurchase(p.bizMember, item(s)), s).toBe(false);
    }
    // Nobody matches a missing creator/orderer.
    expect(canEditPurchase(p.asker, { status: "REQUESTED", createdById: null, ordererId: null })).toBe(false);
  });

  it("lets the orderer move one step along Approved → Ordered → Done, and managers anywhere", () => {
    const item = (status: PurchaseStatus) => ({ status, createdById: p.asker.id, ordererId: p.orderer.id });
    expect(purchaseStatusTargets(p.orderer, item("REQUESTED"))).toEqual([]);
    expect(purchaseStatusTargets(p.orderer, item("APPROVED"))).toEqual(["ORDERED"]);
    expect(purchaseStatusTargets(p.orderer, item("ORDERED"))).toEqual(["APPROVED", "DONE"]);
    expect(purchaseStatusTargets(p.orderer, item("DONE"))).toEqual(["ORDERED"]);
    expect(purchaseStatusTargets(p.orderer, item("NOT_NEEDED"))).toEqual([]);
    expect(purchaseStatusTargets(p.asker, item("APPROVED"))).toEqual([]);
    expect(purchaseStatusTargets(p.bizLead, item("ORDERED"))).toEqual(["REQUESTED", "APPROVED", "DONE", "NOT_NEEDED"]);
    expect(canSetPurchaseStatus(p.orderer, item("APPROVED"), "DONE")).toBe(false);
    expect(canSetPurchaseStatus(p.orderer, item("REQUESTED"), "APPROVED")).toBe(false);
    expect(canSetPurchaseStatus(p.swLead, item("REQUESTED"), "APPROVED")).toBe(true);
  });

  it("lets the Business subteam buy any approved item (the orderer's steps), but not approve or mark N/A", () => {
    const item = (status: PurchaseStatus) => ({ status, createdById: p.asker.id, ordererId: p.orderer.id });
    expect(purchaseStatusTargets(p.bizMember, item("REQUESTED"))).toEqual([]);
    expect(purchaseStatusTargets(p.bizMember, item("APPROVED"))).toEqual(["ORDERED"]);
    expect(purchaseStatusTargets(p.bizMember, item("ORDERED"))).toEqual(["APPROVED", "DONE"]);
    expect(purchaseStatusTargets(p.bizMember, item("DONE"))).toEqual(["ORDERED"]);
    expect(purchaseStatusTargets(p.bizMember, item("NOT_NEEDED"))).toEqual([]);
  });

  it("doesn't let leaders approve what they added (all-scope staff may)", () => {
    const own = (status: PurchaseStatus, who: Actor) => ({ status, createdById: who.id, ordererId: null });
    // From Requested or N/A: only N/A / Requested.
    expect(purchaseStatusTargets(p.bizLead, own("REQUESTED", p.bizLead))).toEqual(["NOT_NEEDED"]);
    expect(purchaseStatusTargets(p.swLead, own("NOT_NEEDED", p.swLead))).toEqual(["REQUESTED"]);
    // Once someone else approved it, they manage it like any other item.
    expect(purchaseStatusTargets(p.swLead, own("APPROVED", p.swLead))).toEqual(["REQUESTED", "ORDERED", "DONE", "NOT_NEEDED"]);
    // Ordering it for someone else isn't approving your own request.
    expect(purchaseStatusTargets(p.swLead, { status: "REQUESTED", createdById: p.asker.id, ordererId: p.swLead.id })).toContain("APPROVED");
    for (const who of [p.captain, p.mentor, p.teacher, p.admin]) {
      expect(purchaseStatusTargets(who, own("REQUESTED", who))).toEqual(["APPROVED", "ORDERED", "DONE", "NOT_NEEDED"]);
    }
  });
});

// ── create ──────────────────────────────────────────────────────────────────

describe("createOrder", () => {
  it("lets any active member add an item: tidied values, cents, Requested, and they order it", async () => {
    const ctx = ctxFor(p.asker);
    const { id, status } = await createOrder(ctx, {
      description: "  Flywheels for the outtake  ",
      notes: "  SKU am-5437 (2)  ",
      link: " andymark.com/products/flywheel ",
      vendor: " AndyMark ",
      quantity: " 2 ",
      cost: "$59.98",
      subteam: "BUILD",
    });
    expect(status).toBe("REQUESTED");
    expect(await row(id)).toMatchObject({
      description: "Flywheels for the outtake",
      notes: "SKU am-5437 (2)",
      link: "https://andymark.com/products/flywheel",
      vendor: "AndyMark",
      quantity: 2,
      costCents: 5998,
      subteam: "BUILD",
      status: "REQUESTED",
      ordererId: p.asker.id,
      createdById: p.asker.id,
      statusChangedAt: null,
      statusChangedById: null,
    });
    expect(ctx.notifier.events).toEqual([]);
  });

  it("leaves optional fields empty: no link, no price, no quantity, whole team", async () => {
    const { id } = await createOrder(ctxFor(p.swMember), { description: "Zip ties", subteam: "", quantity: "", cost: "" });
    expect(await row(id)).toMatchObject({ notes: "", link: "", vendor: "", quantity: null, costCents: null, subteam: null, ordererId: p.swMember.id });
    const other = await createOrder(ctxFor(p.swMember), { description: "Tape" });
    expect(await row(other.id)).toMatchObject({ quantity: null, costCents: null, subteam: null });
  });

  it.each([
    ["12", 1200],
    ["$1,299.99", 129999],
    ["1299.5", 129950],
    ["1.5k", 150000],
    [".5", 50],
    ["  $ 24.99 ", 2499],
    ["250 USD", 25000],
    ["n/a", null],
    ["tbd", null],
    [`${" ".repeat(60)}12.99 `, 1299],
  ])("reads the price %j as %j cents", async (cost, cents) => {
    const { id } = await createOrder(ctxFor(p.asker), { description: "Priced", cost });
    expect((await row(id)).costCents).toBe(cents);
  });

  it.each([
    ["abc", COST_FORMAT_MESSAGE],
    ["12,34", COST_FORMAT_MESSAGE],
    ["-5", COST_NEGATIVE_MESSAGE],
    ["(5)", COST_NEGATIVE_MESSAGE],
    ["100000.01", "Prices can be up to $100,000.00."],
    // Too long to be a price (not quietly cut short to "$1").
    [`1${" ".repeat(39)}000`, COST_FORMAT_MESSAGE],
  ])("refuses the price %j", async (cost, message) => {
    const err = await errorOf(createOrder(ctxFor(p.asker), { description: "Priced", cost }));
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.fieldErrors).toEqual({ cost: message });
  });

  it("checks the other fields", async () => {
    const quantityMessage = `Enter a quantity from 1 to ${LIMITS.purchaseQuantityMax.toLocaleString("en-US")}, or leave it empty.`;
    const cases: [Record<string, unknown>, string, string][] = [
      [{ description: "   " }, "description", "Description is required."],
      [{ description: "x".repeat(LIMITS.purchaseDescriptionMax + 1) }, "description", `Description must be at most ${LIMITS.purchaseDescriptionMax} characters.`],
      [{ notes: "n".repeat(LIMITS.purchaseNotesMax + 1) }, "notes", `Notes must be at most ${LIMITS.purchaseNotesMax} characters.`],
      [{ vendor: "v".repeat(LIMITS.purchaseVendorMax + 1) }, "vendor", `Vendor must be at most ${LIMITS.purchaseVendorMax} characters.`],
      [{ quantity: "0" }, "quantity", quantityMessage],
      [{ quantity: "2.5" }, "quantity", quantityMessage],
      [{ quantity: "-1" }, "quantity", quantityMessage],
      [{ quantity: String(LIMITS.purchaseQuantityMax + 1) }, "quantity", quantityMessage],
      [{ link: "javascript:alert(1)" }, "link", "Enter a web link to the product, like andymark.com/…"],
      [{ link: "ftp://files.example.com/x" }, "link", "Enter a web link to the product, like andymark.com/…"],
      [{ link: "not a link" }, "link", "Enter a web link to the product, like andymark.com/…"],
      [{ subteam: "ROBOTS" }, "subteam", "Pick who it's for."],
    ];
    for (const [fields, key, message] of cases) {
      const err = await errorOf(createOrder(ctxFor(p.asker), { description: "Something", ...fields }));
      expect(err, key).toBeInstanceOf(ValidationError);
      expect(err.fieldErrors?.[key], JSON.stringify(fields)).toBe(message);
    }
    // The biggest quantity and a comma-grouped one are fine; http links are kept as they are.
    const { id } = await createOrder(ctxFor(p.asker), { description: "Bolts", quantity: "10,000", link: "http://shop.example.com/bolts" });
    expect(await row(id)).toMatchObject({ quantity: 10000, link: "http://shop.example.com/bolts" });
    expect(await t.db.purchaseItem.count()).toBe(1);
  });

  it("only lets managers pick someone else as the orderer (an ACTIVE person, or no one yet)", async () => {
    // Members: themselves only.
    const err = await errorOf(createOrder(ctxFor(p.asker), { description: "Wheels", ordererId: p.orderer.id }));
    expect(err).toBeInstanceOf(ForbiddenError);
    expect(err.userMessage).toBe("Only leaders can pick someone else to order it.");
    // The Business subteam doesn't pick either (it isn't an admin-approved role).
    expect(await errorOf(createOrder(ctxFor(p.bizMember), { description: "Banner", ordererId: p.swMember.id }))).toBeInstanceOf(ForbiddenError);
    const own = await createOrder(ctxFor(p.asker), { description: "Wheels", ordererId: p.asker.id });
    expect((await row(own.id)).ordererId).toBe(p.asker.id);
    const blank = await createOrder(ctxFor(p.asker), { description: "Wheels", ordererId: "" });
    expect((await row(blank.id)).ordererId).toBe(p.asker.id);

    // Managers: anyone ACTIVE, or no one yet.
    const picked = await createOrder(ctxFor(p.bizLead), { description: "Banner", ordererId: p.swMember.id });
    expect(await row(picked.id)).toMatchObject({ ordererId: p.swMember.id, createdById: p.bizLead.id });
    const nobody = await createOrder(ctxFor(p.bizLead), { description: "Banner", ordererId: "" });
    expect((await row(nobody.id)).ordererId).toBeNull();
    const self = await createOrder(ctxFor(p.bizLead), { description: "Banner" });
    expect((await row(self.id)).ordererId).toBe(p.bizLead.id);
    for (const who of [p.pending, p.disabled]) {
      const e = await errorOf(createOrder(ctxFor(p.captain), { description: "Banner", ordererId: who.id }));
      expect(e).toBeInstanceOf(ValidationError);
      expect(e.fieldErrors).toEqual({ ordererId: "Pick someone who's on the team now." });
    }
    const unknown = await errorOf(createOrder(ctxFor(p.captain), { description: "Banner", ordererId: "nope" }));
    expect(unknown.fieldErrors).toEqual({ ordererId: "Pick someone who's on the team now." });
  });

  it("lets all-scope staff add an item with another status (recorded as a status change); everyone else only as Requested", async () => {
    const err = await errorOf(createOrder(ctxFor(p.asker), { description: "Motors", status: "APPROVED" }));
    expect(err).toBeInstanceOf(ForbiddenError);
    expect(err.userMessage).toBe("Only leaders can approve items or change their status.");
    expect(await errorOf(createOrder(ctxFor(p.bizMember), { description: "Motors", status: "DONE" }))).toBeInstanceOf(ForbiddenError);
    // A subteam leader adding it already approved would be approving their own request.
    for (const who of [p.bizLead, p.buildLead]) {
      const own = await errorOf(createOrder(ctxFor(who), { description: "Motors", status: "APPROVED" }));
      expect(own).toBeInstanceOf(ForbiddenError);
      expect(own.userMessage).toBe("Add it as Requested: someone else approves what you add.");
    }
    const requested = await createOrder(ctxFor(p.asker), { description: "Motors", status: "REQUESTED" });
    expect(requested.status).toBe("REQUESTED");

    const done = await createOrder(ctxFor(p.captain), { description: "Already bought", status: "DONE" });
    expect(done.status).toBe("DONE");
    expect(await row(done.id)).toMatchObject({ status: "DONE", statusChangedAt: TEST_NOW, statusChangedById: p.captain.id });
    const bad = await errorOf(createOrder(ctxFor(p.captain), { description: "x", status: "LOST" }));
    expect(bad.fieldErrors).toEqual({ status: "Pick a status." });
  });

  it("refuses accounts that aren't active", async () => {
    for (const who of [p.pending, p.disabled]) {
      expect(await errorOf(createOrder(ctxFor(who), { description: "Sneaky" }))).toBeInstanceOf(ForbiddenError);
    }
    expect(await t.db.purchaseItem.count()).toBe(0);
  });

  it(`allows ${ORDER_ADDS_PER_HOUR} new items per person per hour`, async () => {
    for (let i = 0; i < ORDER_ADDS_PER_HOUR; i++) await createOrder(ctxFor(p.swMember), { description: `Item ${i}` });
    const err = await errorOf(createOrder(ctxFor(p.swMember), { description: "One too many" }));
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.userMessage).toMatch(/added a lot of items/);
    // Someone else is unaffected.
    await createOrder(ctxFor(p.asker), { description: "Mine" });
    expect(await t.db.purchaseItem.count()).toBe(ORDER_ADDS_PER_HOUR + 1);
  });
});

// ── update ──────────────────────────────────────────────────────────────────

const edit = (itemId: string, fields: Record<string, unknown> = {}) => ({
  itemId,
  description: "Flywheels (2)",
  notes: "SKU am-5437",
  link: "",
  vendor: "AndyMark",
  quantity: "2",
  cost: "60",
  subteam: "BUILD",
  ...fields,
});

describe("updateOrder", () => {
  it("lets whoever added it and whoever orders it change it while it's Requested (the orderer stays)", async () => {
    const item = await makeItem({ createdBy: p.asker, orderer: p.orderer });
    await updateOrder(ctxFor(p.asker), edit(item.id));
    expect(await row(item.id)).toMatchObject({ description: "Flywheels (2)", costCents: 6000, quantity: 2, vendor: "AndyMark", ordererId: p.orderer.id });
    await updateOrder(ctxFor(p.orderer), edit(item.id, { description: "Flywheels (3)", ordererId: p.orderer.id }));
    expect(await row(item.id)).toMatchObject({ description: "Flywheels (3)", ordererId: p.orderer.id, status: "REQUESTED" });
  });

  it("refuses other members, and members once the item is approved", async () => {
    const item = await makeItem({ createdBy: p.asker, orderer: p.orderer });
    expect(await errorOf(updateOrder(ctxFor(p.buildMember), edit(item.id)))).toBeInstanceOf(ForbiddenError);
    const noPick = await errorOf(updateOrder(ctxFor(p.asker), edit(item.id, { ordererId: p.asker.id })));
    expect(noPick).toBeInstanceOf(ForbiddenError);
    expect(noPick.userMessage).toBe("Only leaders can pick someone else to order it.");

    const other = await errorOf(updateOrder(ctxFor(p.buildMember), edit(item.id)));
    expect(other.userMessage).toBe("Only whoever added it, the person ordering it, and leaders can change it.");
    // Business members don't edit other people's items.
    expect(await errorOf(updateOrder(ctxFor(p.bizMember), edit(item.id)))).toBeInstanceOf(ForbiddenError);

    await t.db.purchaseItem.update({ where: { id: item.id }, data: { status: "APPROVED" } });
    for (const who of [p.asker, p.orderer]) {
      const err = await errorOf(updateOrder(ctxFor(who), edit(item.id)));
      expect(err).toBeInstanceOf(ForbiddenError);
      expect(err.userMessage).toBe("This item is Approved now, so only leaders can change it.");
    }
    expect((await row(item.id)).description).toBe(item.description);
  });

  it("lets managers change any item, pick the orderer, and keep one who left", async () => {
    const item = await makeItem({ status: "ORDERED", orderer: p.disabled });
    // Keeping the current orderer is fine even though they left.
    await updateOrder(ctxFor(p.bizLead), edit(item.id, { ordererId: p.disabled.id }));
    expect(await row(item.id)).toMatchObject({ description: "Flywheels (2)", ordererId: p.disabled.id, status: "ORDERED" });
    // A new one must be ACTIVE.
    const err = await errorOf(updateOrder(ctxFor(p.bizLead), edit(item.id, { ordererId: p.pending.id })));
    expect(err.fieldErrors).toEqual({ ordererId: "Pick someone who's on the team now." });
    await updateOrder(ctxFor(p.mentor), edit(item.id, { ordererId: p.swMember.id }));
    expect((await row(item.id)).ordererId).toBe(p.swMember.id);
    await updateOrder(ctxFor(p.mentor), edit(item.id, { ordererId: "" }));
    expect((await row(item.id)).ordererId).toBeNull();
    // Leaving the orderer out keeps it.
    await updateOrder(ctxFor(p.mentor), { ...edit(item.id), ordererId: undefined });
    expect((await row(item.id)).ordererId).toBeNull();
  });

  it("never changes the status (that's the status menu) and explains a missing item", async () => {
    const item = await makeItem({ createdBy: p.asker });
    const { status } = await updateOrder(ctxFor(p.bizLead), edit(item.id, { status: "DONE" }));
    expect(status).toBe("REQUESTED");
    expect(await row(item.id)).toMatchObject({ status: "REQUESTED", statusChangedAt: null });
    const err = await errorOf(updateOrder(ctxFor(p.bizLead), edit("missing-item")));
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.userMessage).toBe(ORDER_NOT_FOUND);
  });

  it("validates like adding", async () => {
    const item = await makeItem({ createdBy: p.asker });
    const err = await errorOf(updateOrder(ctxFor(p.asker), edit(item.id, { cost: "twelve", description: "" })));
    expect(err.fieldErrors).toEqual({ description: "Description is required.", cost: COST_FORMAT_MESSAGE });
  });
});

// ── delete ──────────────────────────────────────────────────────────────────

describe("deleteOrder", () => {
  it("lets whoever added it (or orders it) remove it while Requested; managers any time", async () => {
    const mine = await makeItem({ createdBy: p.asker, description: "Spare servo" });
    expect(await deleteOrder(ctxFor(p.asker), { itemId: mine.id })).toEqual({ description: "Spare servo", status: "REQUESTED" });
    expect(await t.db.purchaseItem.count()).toBe(0);

    const ordering = await makeItem({ createdBy: p.bizMember, orderer: p.orderer });
    await deleteOrder(ctxFor(p.orderer), { itemId: ordering.id });

    const approved = await makeItem({ createdBy: p.asker, status: "APPROVED" });
    expect(await errorOf(deleteOrder(ctxFor(p.asker), { itemId: approved.id }))).toBeInstanceOf(ForbiddenError);
    expect(await errorOf(deleteOrder(ctxFor(p.buildMember), { itemId: approved.id }))).toBeInstanceOf(ForbiddenError);
    // The Business subteam can't wipe the purchase history.
    expect(await errorOf(deleteOrder(ctxFor(p.bizMember), { itemId: approved.id }))).toBeInstanceOf(ForbiddenError);
    // The status it had comes back (so the list opens that tab).
    expect(await deleteOrder(ctxFor(p.captain), { itemId: approved.id })).toMatchObject({ status: "APPROVED" });
    expect(await t.db.purchaseItem.count()).toBe(0);

    expect(await errorOf(deleteOrder(ctxFor(p.captain), { itemId: approved.id }))).toBeInstanceOf(NotFoundError);
    expect(await errorOf(deleteOrder(ctxFor(p.pending), { itemId: approved.id }))).toBeInstanceOf(ForbiddenError);
  });
});

// ── status ──────────────────────────────────────────────────────────────────

describe("setOrderStatus", () => {
  it("lets managers approve (recording who and when)", async () => {
    const item = await makeItem({ createdBy: p.asker, orderer: p.orderer });
    const res = await setOrderStatus(ctxFor(p.bizLead), { itemId: item.id, status: "APPROVED" });
    expect(res).toEqual({ id: item.id, status: "APPROVED", changed: true });
    expect(await row(item.id)).toMatchObject({ status: "APPROVED", statusChangedAt: TEST_NOW, statusChangedById: p.bizLead.id });
    // Leaders of other subteams have admin access, so they can too.
    await setOrderStatus(ctxFor(p.swLead), { itemId: item.id, status: "NOT_NEEDED" });
    expect(await row(item.id)).toMatchObject({ status: "NOT_NEEDED", statusChangedById: p.swLead.id });
    await setOrderStatus(ctxFor(p.admin), { itemId: item.id, status: "REQUESTED" });
    expect((await row(item.id)).status).toBe("REQUESTED");
  });

  it("doesn't let the orderer (or whoever added it) approve it", async () => {
    const item = await makeItem({ createdBy: p.asker, orderer: p.orderer });
    const err = await errorOf(setOrderStatus(ctxFor(p.orderer), { itemId: item.id, status: "APPROVED" }));
    expect(err).toBeInstanceOf(ForbiddenError);
    expect(err.userMessage).toBe("It needs to be approved first. Only leaders can approve items.");
    const asker = await errorOf(setOrderStatus(ctxFor(p.asker), { itemId: item.id, status: "APPROVED" }));
    expect(asker.userMessage).toBe("Only the person ordering it, the Business team, and leaders can change its status.");
    // Business members buy approved items; they don't approve them.
    const biz = await errorOf(setOrderStatus(ctxFor(p.bizMember), { itemId: item.id, status: "APPROVED" }));
    expect(biz.userMessage).toBe("It needs to be approved first. Only leaders can approve items.");
    expect(await row(item.id)).toMatchObject({ status: "REQUESTED", statusChangedAt: null });
  });

  it("lets the orderer move it Approved → Ordered → Done, and one step back", async () => {
    const item = await makeItem({ createdBy: p.asker, orderer: p.orderer, status: "APPROVED" });
    const ctx = ctxFor(p.orderer);
    for (const status of ["ORDERED", "DONE", "ORDERED", "APPROVED", "ORDERED"] as const) {
      expect(await setOrderStatus(ctx, { itemId: item.id, status })).toMatchObject({ status, changed: true });
      expect(await row(item.id)).toMatchObject({ status, statusChangedById: p.orderer.id, statusChangedAt: TEST_NOW });
    }
  });

  it("keeps the orderer to one step, and away from N/A and Requested", async () => {
    const approved = await makeItem({ orderer: p.orderer, status: "APPROVED" });
    const skip = await errorOf(setOrderStatus(ctxFor(p.orderer), { itemId: approved.id, status: "DONE" }));
    expect(skip.userMessage).toBe("Move it one step at a time: Approved → Ordered → Done.");
    const na = await errorOf(setOrderStatus(ctxFor(p.orderer), { itemId: approved.id, status: "NOT_NEEDED" }));
    expect(na.userMessage).toBe("Only leaders can mark items N/A or bring them back.");
    const back = await errorOf(setOrderStatus(ctxFor(p.orderer), { itemId: approved.id, status: "REQUESTED" }));
    expect(back.userMessage).toBe("Only leaders can send items back to Requested.");
    const gone = await makeItem({ orderer: p.orderer, status: "NOT_NEEDED" });
    const revive = await errorOf(setOrderStatus(ctxFor(p.orderer), { itemId: gone.id, status: "APPROVED" }));
    expect(revive.userMessage).toBe("Only leaders can mark items N/A or bring them back.");
    expect((await row(approved.id)).status).toBe("APPROVED");
  });

  it("stops the old orderer once a manager hands the item to someone else", async () => {
    const item = await makeItem({ orderer: p.orderer, status: "APPROVED" });
    await updateOrder(ctxFor(p.bizLead), edit(item.id, { ordererId: p.buildMember.id }));
    expect(await errorOf(setOrderStatus(ctxFor(p.orderer), { itemId: item.id, status: "ORDERED" }))).toBeInstanceOf(ForbiddenError);
    await setOrderStatus(ctxFor(p.buildMember), { itemId: item.id, status: "ORDERED" });
    expect((await row(item.id)).statusChangedById).toBe(p.buildMember.id);
  });

  it("does nothing when it already has that status", async () => {
    const changedAt = hoursAgo(5);
    const item = await makeItem({ status: "ORDERED", statusChangedAt: changedAt, statusChangedBy: p.bizLead });
    expect(await setOrderStatus(ctxFor(p.orderer), { itemId: item.id, status: "ORDERED" })).toEqual({
      id: item.id,
      status: "ORDERED",
      changed: false,
    });
    expect(await row(item.id)).toMatchObject({ statusChangedAt: changedAt, statusChangedById: p.bizLead.id });
  });

  it("refuses bad input, missing items, and inactive accounts", async () => {
    const item = await makeItem({ orderer: p.pending, status: "APPROVED" });
    expect((await errorOf(setOrderStatus(ctxFor(p.bizLead), { itemId: item.id, status: "LOST" }))).fieldErrors).toEqual({ status: "Pick a status." });
    expect(await errorOf(setOrderStatus(ctxFor(p.bizLead), { itemId: "missing", status: "DONE" }))).toBeInstanceOf(NotFoundError);
    expect(await errorOf(setOrderStatus(ctxFor(p.pending), { itemId: item.id, status: "ORDERED" }))).toBeInstanceOf(ForbiddenError);
    expect(await errorOf(setOrderStatus(ctxFor(p.disabled), { itemId: item.id, status: "ORDERED" }))).toBeInstanceOf(ForbiddenError);
    expect((await row(item.id)).status).toBe("APPROVED");
  });

  it(`counts toward the ${ORDER_WRITES_PER_HOUR} changes per person per hour`, async () => {
    const item = await makeItem();
    await t.db.rateLimit.create({ data: { key: `orders:${p.bizLead.id}`, count: ORDER_WRITES_PER_HOUR, windowStart: TEST_NOW } });
    const err = await errorOf(setOrderStatus(ctxFor(p.bizLead), { itemId: item.id, status: "APPROVED" }));
    expect(err).toBeInstanceOf(RateLimitError);
    expect((await row(item.id)).status).toBe("REQUESTED");
    // Someone else is unaffected.
    await setOrderStatus(ctxFor(p.swLead), { itemId: item.id, status: "APPROVED" });
  });
});

// ── out-of-date pages and races ───────────────────────────────────────────────

/**
 * A copy of the test DB whose next `purchaseItem.updateMany` first runs `meanwhile` — someone else's change
 * landing between a service's read and its write.
 */
function dbWithChangeBeforeWrite(meanwhile: () => Promise<unknown>): Db {
  let fired = false;
  return new Proxy(t.db, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop !== "purchaseItem") return value;
      return new Proxy(value, {
        get(items, key, r) {
          const fn = Reflect.get(items, key, r);
          if (key !== "updateMany" || fired) return fn;
          return async (args: unknown) => {
            fired = true;
            await meanwhile();
            return fn.call(items, args);
          };
        },
      });
    },
  }) as Db;
}

let looks = 0;
/**
 * What a page loaded now sends as `seen` (the item's updatedAt). The row's updatedAt is moved back first, so the
 * next save always changes it, even within the same millisecond.
 */
async function seenOf(id: string): Promise<string> {
  const at = hoursAgo(100 + ++looks);
  await t.db.purchaseItem.update({ where: { id }, data: { updatedAt: at } });
  return at.toISOString();
}

describe("changes made from an out-of-date page", () => {
  it("won't roll an item back from a stale manager menu (someone else moved it on meanwhile)", async () => {
    const item = await makeItem({ createdBy: p.asker, orderer: p.orderer });
    const stale = await getOrder(p.swLead, item.id, t.db); // the Software leader's page: Requested
    await setOrderStatus(ctxFor(p.bizLead), { itemId: item.id, status: "APPROVED" });
    await setOrderStatus(ctxFor(p.orderer), { itemId: item.id, status: "ORDERED" });
    const err = await errorOf(
      setOrderStatus(ctxFor(p.swLead), { itemId: item.id, status: "APPROVED", from: stale?.status, seen: stale?.updatedAt }),
    );
    expect(err).toBeInstanceOf(ConflictError);
    expect(err.userMessage).toBe("Olivia Orderer just changed it to Ordered.");
    expect(await row(item.id)).toMatchObject({ status: "ORDERED", statusChangedById: p.orderer.id });
    expect(await countOrdersToOrder(p.orderer, t.db)).toBe(0);
  });

  it("says someone else changed it (not that the viewer broke a rule) when the orderer's menu is out of date", async () => {
    const item = await makeItem({ orderer: p.orderer, status: "APPROVED" });
    await setOrderStatus(ctxFor(p.bizLead), { itemId: item.id, status: "NOT_NEEDED" });
    const err = await errorOf(setOrderStatus(ctxFor(p.orderer), { itemId: item.id, status: "ORDERED", from: "APPROVED" }));
    expect(err).toBeInstanceOf(ConflictError);
    expect(err.userMessage).toBe("Bo Business just changed it to N/A.");
    // Their own earlier change (another tab): "You".
    const mine = await makeItem({ orderer: p.orderer, status: "APPROVED" });
    await setOrderStatus(ctxFor(p.orderer), { itemId: mine.id, status: "ORDERED" });
    const again = await errorOf(setOrderStatus(ctxFor(p.orderer), { itemId: mine.id, status: "APPROVED", from: "DONE" }));
    expect(again.userMessage).toBe("You just changed it to Ordered.");
  });

  it("won't approve an item that was edited after the manager looked at it", async () => {
    const { id } = await createOrder(ctxFor(p.asker), { description: "Zip ties", cost: "5" });
    await seenOf(id);
    const seen = await getOrder(p.bizLead, id, t.db);
    expect(seen).toMatchObject({ description: "Zip ties", costCents: 500, updatedAt: hoursAgo(100 + looks).toISOString() });
    await updateOrder(ctxFor(p.asker), edit(id, { description: "REV Control Hub x4", cost: "1,600" }));
    const err = await errorOf(setOrderStatus(ctxFor(p.bizLead), { itemId: id, status: "APPROVED", from: "REQUESTED", seen: seen?.updatedAt }));
    expect(err).toBeInstanceOf(ConflictError);
    expect(err.userMessage).toBe(ORDER_CHANGED_MEANWHILE);
    expect(await row(id)).toMatchObject({ status: "REQUESTED", statusChangedAt: null });
    // Looking again (the page refreshes) and approving works.
    await setOrderStatus(ctxFor(p.bizLead), { itemId: id, status: "APPROVED", from: "REQUESTED", seen: await seenOf(id) });
    expect((await row(id)).status).toBe("APPROVED");
  });

  it("checks the status and the edit again in the write (a change landing between the check and the write)", async () => {
    // Someone else's status change.
    const a = await makeItem({ createdBy: p.asker, orderer: p.orderer, status: "APPROVED" });
    const racing = dbWithChangeBeforeWrite(() => setOrderStatus(ctxFor(p.orderer), { itemId: a.id, status: "ORDERED" }));
    const err = await errorOf(setOrderStatus({ ...ctxFor(p.swLead), db: racing }, { itemId: a.id, status: "REQUESTED", from: "APPROVED" }));
    expect(err.userMessage).toBe("Olivia Orderer just changed it to Ordered.");
    expect((await row(a.id)).status).toBe("ORDERED");

    // An edit landing just before the approval.
    const b = await makeItem({ createdBy: p.asker, orderer: p.asker, description: "Zip ties" });
    const seen = await seenOf(b.id);
    const editing = dbWithChangeBeforeWrite(() => updateOrder(ctxFor(p.asker), edit(b.id, { description: "REV Control Hub x4" })));
    const late = await errorOf(setOrderStatus({ ...ctxFor(p.bizLead), db: editing }, { itemId: b.id, status: "APPROVED", from: "REQUESTED", seen }));
    expect(late).toBeInstanceOf(ConflictError);
    expect(late.userMessage).toBe(ORDER_CHANGED_MEANWHILE);
    expect(await row(b.id)).toMatchObject({ status: "REQUESTED", description: "REV Control Hub x4" });
  });

  it("still conditions a manager's change on the status it was loaded with when the menu didn't say", async () => {
    const item = await makeItem({ createdBy: p.asker, orderer: p.orderer, status: "APPROVED" });
    const racing = dbWithChangeBeforeWrite(() => setOrderStatus(ctxFor(p.orderer), { itemId: item.id, status: "ORDERED" }));
    expect(await errorOf(setOrderStatus({ ...ctxFor(p.captain), db: racing }, { itemId: item.id, status: "NOT_NEEDED" }))).toBeInstanceOf(
      ConflictError,
    );
    expect((await row(item.id)).status).toBe("ORDERED");
  });

  it("refuses a from / seen that isn't a status or a time", async () => {
    const item = await makeItem();
    const err = await errorOf(setOrderStatus(ctxFor(p.bizLead), { itemId: item.id, status: "APPROVED", from: "LOST", seen: "yesterday" }));
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.fieldErrors).toEqual({ from: "This page is out of date. Reload it and try again.", seen: "This page is out of date. Reload it and try again." });
  });

  it("keeps a manager's new orderer when the member who added it saves an edit at the same time", async () => {
    const { id } = await createOrder(ctxFor(p.asker), { description: "Bolts" });
    const racing = dbWithChangeBeforeWrite(() => updateOrder(ctxFor(p.bizLead), edit(id, { description: "Bolts", ordererId: p.buildMember.id })));
    await updateOrder({ ...ctxFor(p.asker), db: racing }, edit(id, { description: "Bolts M4", ordererId: "" }));
    expect(await row(id)).toMatchObject({ description: "Bolts M4", ordererId: p.buildMember.id });
  });

  it("refuses to save the edit form over someone else's change once (then saving again keeps this version)", async () => {
    const item = await makeItem({ createdBy: p.asker, orderer: p.orderer, description: "Wheels" });
    const seen = await seenOf(item.id);
    await updateOrder(ctxFor(p.bizLead), edit(item.id, { description: "Wheels (4)", seen }));
    const err = await errorOf(updateOrder(ctxFor(p.asker), edit(item.id, { description: "Wheels (2)", seen })));
    expect(err).toBeInstanceOf(ConflictError);
    expect(err.userMessage).toBe(ORDER_EDIT_CONFLICT);
    expect((await row(item.id)).description).toBe("Wheels (4)");
    await updateOrder(ctxFor(p.asker), edit(item.id, { description: "Wheels (2)", seen: await seenOf(item.id) }));
    expect((await row(item.id)).description).toBe("Wheels (2)");

    // Also when the other save lands between the check and the write.
    const now = await seenOf(item.id);
    const racing = dbWithChangeBeforeWrite(() => updateOrder(ctxFor(p.captain), edit(item.id, { description: "Wheels (6)" })));
    const late = await errorOf(updateOrder({ ...ctxFor(p.bizLead), db: racing }, edit(item.id, { description: "Wheels (8)", seen: now })));
    expect(late.userMessage).toBe(ORDER_EDIT_CONFLICT);
    expect((await row(item.id)).description).toBe("Wheels (6)");
    // Approved meanwhile: the member hears why they can't any more.
    const racingApproval = dbWithChangeBeforeWrite(() => setOrderStatus(ctxFor(p.captain), { itemId: item.id, status: "APPROVED" }));
    const approved = await errorOf(
      updateOrder({ ...ctxFor(p.asker), db: racingApproval }, edit(item.id, { description: "Wheels (1)", seen: await seenOf(item.id) })),
    );
    expect(approved.userMessage).toBe("This item is Approved now, so only leaders can change it.");
  });
});

describe("approving your own request", () => {
  it("needs someone else unless you're all-scope", async () => {
    const { id } = await createOrder(ctxFor(p.bizLead), { description: "Poster board" });
    const err = await errorOf(setOrderStatus(ctxFor(p.bizLead), { itemId: id, status: "APPROVED" }));
    expect(err).toBeInstanceOf(ForbiddenError);
    expect(err.userMessage).toBe("You added this item, so someone else needs to approve it.");
    expect(await errorOf(setOrderStatus(ctxFor(p.bizLead), { itemId: id, status: "DONE" }))).toBeInstanceOf(ForbiddenError);
    // Withdrawing it is fine, but not bringing it back as approved.
    await setOrderStatus(ctxFor(p.bizLead), { itemId: id, status: "NOT_NEEDED" });
    expect(await errorOf(setOrderStatus(ctxFor(p.bizLead), { itemId: id, status: "APPROVED" }))).toBeInstanceOf(ForbiddenError);
    await setOrderStatus(ctxFor(p.bizLead), { itemId: id, status: "REQUESTED" });
    // Another leader approves it; after that its creator moves it along like any manager.
    await setOrderStatus(ctxFor(p.swLead), { itemId: id, status: "APPROVED" });
    await setOrderStatus(ctxFor(p.bizLead), { itemId: id, status: "ORDERED" });
    expect((await row(id)).status).toBe("ORDERED");

    const mentor = await createOrder(ctxFor(p.mentor), { description: "Field tiles" });
    await setOrderStatus(ctxFor(p.mentor), { itemId: mentor.id, status: "APPROVED" });
    expect((await row(mentor.id)).status).toBe("APPROVED");
  });

  it("lets the Business subteam buy approved items for the team", async () => {
    const item = await makeItem({ createdBy: p.asker, orderer: p.orderer, status: "APPROVED" });
    await setOrderStatus(ctxFor(p.bizMember), { itemId: item.id, status: "ORDERED", from: "APPROVED" });
    await setOrderStatus(ctxFor(p.bizMember), { itemId: item.id, status: "DONE" });
    expect(await row(item.id)).toMatchObject({ status: "DONE", statusChangedById: p.bizMember.id });
    const na = await errorOf(setOrderStatus(ctxFor(p.bizMember), { itemId: item.id, status: "NOT_NEEDED" }));
    expect(na.userMessage).toBe("Only leaders can mark items N/A or bring them back.");
  });
});

// ── list, summary, and item flags ─────────────────────────────────────────────

describe("listOrders", () => {
  async function seedList() {
    return {
      oldRequest: await makeItem({ description: "Old request", createdAt: hoursAgo(50), costCents: 1000, subteam: "BUILD", createdBy: p.asker }),
      newRequest: await makeItem({ description: "New request", createdAt: hoursAgo(2), costCents: null, subteam: "SOFTWARE", createdBy: p.swMember, orderer: p.swMember }),
      approved: await makeItem({ description: "Approved", status: "APPROVED", createdAt: hoursAgo(60), costCents: 2550, subteam: null, orderer: p.orderer }),
      ordered: await makeItem({ description: "Ordered", status: "ORDERED", createdAt: hoursAgo(70), costCents: 12000, subteam: "BUSINESS", orderer: p.bizMember, createdBy: p.bizMember }),
      doneOld: await makeItem({ description: "Done a while ago", status: "DONE", createdAt: hoursAgo(90), costCents: 99999, statusChangedAt: hoursAgo(40), statusChangedBy: p.bizLead }),
      doneNew: await makeItem({ description: "Done just now", status: "DONE", createdAt: hoursAgo(95), costCents: 500, statusChangedAt: hoursAgo(1), statusChangedBy: p.orderer }),
      na: await makeItem({ description: "Not needed", status: "NOT_NEEDED", createdAt: hoursAgo(30), costCents: 700, statusChangedAt: hoursAgo(3), statusChangedBy: p.bizLead }),
    };
  }
  const names = (list: { items: { description: string }[] }) => list.items.map((i) => i.description);

  it("filters by status and sorts like the sheet: open items oldest first, finished ones latest first", async () => {
    await seedList();
    const open = await listOrders(p.asker, { filter: "open" }, t.db);
    expect(names(open)).toEqual(["Old request", "New request", "Approved", "Ordered"]);
    expect(names(await listOrders(p.asker, { filter: "done" }, t.db))).toEqual(["Done just now", "Done a while ago"]);
    expect(names(await listOrders(p.asker, { filter: "na" }, t.db))).toEqual(["Not needed"]);
    expect(names(await listOrders(p.asker, { filter: "all" }, t.db))).toEqual([
      "Old request",
      "New request",
      "Approved",
      "Ordered",
      "Done just now",
      "Done a while ago",
      "Not needed",
    ]);
    expect(open.counts).toEqual({ open: 4, done: 2, na: 1, all: 7 });
    expect(open.truncated).toBe(false);
  });

  it("adds up the open items (with a price) and counts the ones without", async () => {
    await seedList();
    const { summary, canManage } = await listOrders(p.asker, { filter: "done" }, t.db);
    expect(summary).toEqual({
      counts: { REQUESTED: 2, APPROVED: 1, ORDERED: 1, DONE: 2, NOT_NEEDED: 1 },
      open: 4,
      toApprove: 2,
      toOrder: 1,
      openTotalCents: 1000 + 2550 + 12000,
      openUnpriced: 1,
      doneTotalCents: 99999 + 500,
      doneUnpriced: 0,
    });
    expect(canManage).toBe(false);
    expect((await listOrders(p.bizMember, { filter: "open" }, t.db)).canManage).toBe(false);
    expect((await listOrders(p.bizLead, { filter: "open" }, t.db)).canManage).toBe(true);
  });

  it("filters by subteam, whole team, and Mine — and the summary and tab counts follow", async () => {
    await seedList();
    const build = await listOrders(p.asker, { filter: "all", for: "BUILD" }, t.db);
    expect(names(build)).toEqual(["Old request", "Done just now", "Done a while ago", "Not needed"]);
    expect(build.summary).toMatchObject({ open: 1, openTotalCents: 1000, openUnpriced: 0 });
    expect(build.counts).toEqual({ open: 1, done: 2, na: 1, all: 4 });
    expect(names(await listOrders(p.asker, { filter: "open", for: "team" }, t.db))).toEqual(["Approved"]);
    expect(names(await listOrders(p.asker, { filter: "open", for: "SOFTWARE" }, t.db))).toEqual(["New request"]);
    // Mine = added by me or I'm ordering it.
    const mine = await listOrders(p.orderer, { filter: "all", mine: true }, t.db);
    expect(names(mine)).toEqual(["Old request", "Approved", "Done just now", "Done a while ago", "Not needed"]);
    const bizMine = await listOrders(p.bizMember, { filter: "open", mine: true }, t.db);
    expect(names(bizMine)).toEqual(["Ordered"]);
    expect(bizMine.summary).toMatchObject({ open: 1, toApprove: 0, toOrder: 0, openTotalCents: 12000 });
  });

  it("says what each viewer can do with each item", async () => {
    const items = await seedList();
    const byName = async (who: Actor) => new Map((await listOrders(who, { filter: "all" }, t.db)).items.map((i) => [i.description, i]));

    const asker = await byName(p.asker);
    expect(asker.get("Old request")).toMatchObject({ canEdit: true, statusOptions: ["REQUESTED"], isMine: true });
    expect(asker.get("New request")).toMatchObject({ canEdit: false, statusOptions: ["REQUESTED"], isMine: false });

    const orderer = await byName(p.orderer);
    expect(orderer.get("Old request")).toMatchObject({ canEdit: true, statusOptions: ["REQUESTED"] });
    expect(orderer.get("Approved")).toMatchObject({ canEdit: false, statusOptions: ["APPROVED", "ORDERED"] });
    expect(orderer.get("Done just now")).toMatchObject({ statusOptions: ["ORDERED", "DONE"], statusChangedBy: "Olivia Orderer" });
    expect(orderer.get("Not needed")).toMatchObject({ statusOptions: ["NOT_NEEDED"] });

    const manager = await byName(p.bizLead);
    for (const item of manager.values()) {
      expect(item.canEdit).toBe(true);
      expect(item.statusOptions).toEqual(["REQUESTED", "APPROVED", "ORDERED", "DONE", "NOT_NEEDED"]);
    }
    expect(manager.get("Ordered")).toMatchObject({
      orderer: { id: p.bizMember.id, name: "Ava Business" },
      createdBy: { id: p.bizMember.id, name: "Ava Business" },
      costCents: 12000,
      subteam: "BUSINESS",
    });
    expect(items.ordered.id).toBe(manager.get("Ordered")?.id);
  });

  it("only links to http(s) product pages", async () => {
    await makeItem({ description: "Safe", link: "https://www.andymark.com/products/flywheel" });
    await makeItem({ description: "Unsafe", link: "javascript:alert(1)" });
    const items = new Map((await listOrders(p.asker, { filter: "open" }, t.db)).items.map((i) => [i.description, i]));
    expect(items.get("Safe")).toMatchObject({ link: "https://www.andymark.com/products/flywheel", linkHost: "andymark.com" });
    expect(items.get("Unsafe")).toMatchObject({ link: "", linkHost: "" });
  });

  it("shows nothing to accounts that aren't active", async () => {
    await seedList();
    const list = await listOrders(p.disabled, { filter: "all" }, t.db);
    expect(list.items).toEqual([]);
    expect(list.counts.all).toBe(0);
    expect(await listOrdersForExport(p.pending, { filter: "all" }, t.db)).toEqual([]);
    expect(await getOrder(p.pending, "anything", t.db)).toBeNull();
  });
});

describe("getOrder and getOrdererOptions", () => {
  it("loads one item with who changed its status last", async () => {
    const item = await makeItem({ description: "Batteries", status: "ORDERED", statusChangedAt: hoursAgo(4), statusChangedBy: p.orderer });
    const detail = await getOrder(p.swMember, item.id, t.db);
    expect(detail).toMatchObject({
      id: item.id,
      description: "Batteries",
      status: "ORDERED",
      statusChangedBy: "Olivia Orderer",
      statusChangedAt: hoursAgo(4).toISOString(),
      canEdit: false,
      statusOptions: ["ORDERED"],
    });
    expect(await getOrder(p.swMember, "missing", t.db)).toBeNull();
  });

  it("counts the approved items someone is ordering (Today's shortcut)", async () => {
    await makeItem({ orderer: p.orderer, status: "APPROVED" });
    await makeItem({ orderer: p.orderer, status: "APPROVED" });
    await makeItem({ orderer: p.orderer, status: "ORDERED" });
    await makeItem({ orderer: p.asker, status: "APPROVED" });
    expect(await countOrdersToOrder(p.orderer, t.db)).toBe(2);
    expect(await countOrdersToOrder(p.buildMember, t.db)).toBe(0);
  });

  it("counts the requests someone may approve (Today's shortcut): not their own unless all-scope", async () => {
    await makeItem({ createdBy: p.asker });
    await makeItem({ createdBy: null });
    await makeItem({ createdBy: p.bizLead });
    await makeItem({ createdBy: p.captain });
    await makeItem({ createdBy: p.asker, status: "APPROVED" });
    expect(await countOrdersToApprove(p.bizLead, t.db)).toBe(3);
    expect(await countOrdersToApprove(p.captain, t.db)).toBe(4);
    expect(await countOrdersToApprove(p.bizMember, t.db)).toBe(0);
    expect(await countOrdersToApprove(p.asker, t.db)).toBe(0);
  });

  it("lists ACTIVE people to pick as orderer, for managers only", async () => {
    const people = await getOrdererOptions(p.bizLead, t.db);
    const ids = people.map((x) => x.id);
    expect(ids).toContain(p.swMember.id);
    expect(ids).not.toContain(p.pending.id);
    expect(ids).not.toContain(p.disabled.id);
    expect(people.map((x) => x.name)).toEqual([...people.map((x) => x.name)].sort((a, b) => a.localeCompare(b)));
    expect(await getOrdererOptions(p.asker, t.db)).toEqual([]);
    expect(await getOrdererOptions(p.bizMember, t.db)).toEqual([]);
  });
});

// ── URLs, filters, and the spreadsheet export ─────────────────────────────────

describe("order list filters and links", () => {
  it("reads filters from the URL, falling back to Open / every subteam", () => {
    expect(parseOrderFilter("done")).toBe("done");
    expect(parseOrderFilter(["na", "all"])).toBe("na");
    expect(parseOrderFilter("nope")).toBe("open");
    expect(parseOrderFilter(undefined, "all")).toBe("all");
    expect(parseOrderFor("BUILD")).toBe("BUILD");
    expect(parseOrderFor("team")).toBe("team");
    expect(parseOrderFor("build")).toBeUndefined();
    expect(filterForStatus("REQUESTED")).toBe("open");
    expect(filterForStatus("ORDERED")).toBe("open");
    expect(filterForStatus("DONE")).toBe("done");
    expect(filterForStatus("NOT_NEEDED")).toBe("na");
  });

  it("builds list and export links", () => {
    expect(ordersHref({ filter: "open" })).toBe("/orders");
    expect(ordersHref({ filter: "done", for: "team", mine: true })).toBe("/orders?filter=done&for=team&mine=1");
    expect(ordersHref({ filter: "open" }, { added: "abc" })).toBe("/orders?added=abc");
    expect(ordersExportHref({ filter: "open", for: "BUILD" })).toBe("/orders/export?for=BUILD&filter=open");
  });

  it("names the export after what's in it", () => {
    expect(ordersExportFilename({ filter: "all" }, "2026-09-24")).toBe("order-list-2026-09-24.csv");
    expect(ordersExportFilename({ filter: "open" }, "2026-09-24")).toBe("order-list-open-2026-09-24.csv");
    expect(ordersExportFilename({ filter: "open", for: "SOFTWARE", mine: true }, "2026-09-24")).toBe("order-list-software-open-mine-2026-09-24.csv");
    expect(ordersExportFilename({ filter: "na", for: "team" }, "2026-09-24")).toBe("order-list-whole-team-na-2026-09-24.csv");
  });
});

describe("orderSummaryText", () => {
  const summary = (over: Partial<OrderSummary> = {}): OrderSummary => ({
    counts: { REQUESTED: 1, APPROVED: 1, ORDERED: 1, DONE: 2, NOT_NEEDED: 1 },
    open: 3,
    toApprove: 1,
    toOrder: 1,
    openTotalCents: 31249,
    openUnpriced: 1,
    doneTotalCents: 1500,
    doneUnpriced: 0,
    ...over,
  });

  it("describes the open items on Open and All", () => {
    expect(orderSummaryText(summary(), { filter: "open", for: "BUILD", mine: true })).toBe(
      "Build · Yours: 3 open items · 1 waiting for approval · 1 to order · Estimated total $312.49 (1 item without a price)",
    );
    expect(orderSummaryText(summary({ open: 0, toApprove: 0, toOrder: 0, openUnpriced: 0, openTotalCents: 0 }), { filter: "all" })).toBe(
      "Nothing open right now",
    );
  });

  it("says there are no prices yet instead of a $0.00 total", () => {
    const text = orderSummaryText(summary({ open: 1, toApprove: 1, toOrder: 0, openTotalCents: 0, openUnpriced: 1 }), { filter: "open", for: "team" });
    expect(text).toBe("Whole team: 1 open item · 1 waiting for approval · No prices yet");
  });

  it("describes the tab that's shown on Done and N/A", () => {
    expect(orderSummaryText(summary(), { filter: "done" })).toBe("2 items done · Total $15.00");
    expect(orderSummaryText(summary({ doneUnpriced: 2, doneTotalCents: 0 }), { filter: "done" })).toBe("2 items done · No prices yet");
    expect(orderSummaryText(summary({ counts: { REQUESTED: 0, APPROVED: 0, ORDERED: 0, DONE: 0, NOT_NEEDED: 0 } }), { filter: "done" })).toBe(
      "Nothing done yet",
    );
    expect(orderSummaryText(summary(), { filter: "na", mine: true })).toBe("Yours: 1 item marked N/A");
  });
});

describe("parseCents", () => {
  it("keeps the cents and refuses what isn't a price", () => {
    expect(parseCents("12.99")).toEqual({ ok: true, value: 1299 });
    expect(parseCents("0.10")).toEqual({ ok: true, value: 10 });
    expect(parseCents("0")).toEqual({ ok: true, value: 0 });
    expect(parseCents("")).toEqual({ ok: true, value: null });
    expect(parseCents("$100,000")).toEqual({ ok: true, value: PURCHASE_COST_MAX_CENTS });
    expect(parseCents("1,2,3")).toEqual({ ok: false, message: COST_FORMAT_MESSAGE });
    expect(parseCents("−3")).toEqual({ ok: false, message: COST_NEGATIVE_MESSAGE });
  });
});

describe("CSV export", () => {
  it("escapes cells a spreadsheet would run as formulas, and quotes commas, quotes, and line breaks", () => {
    expect(csvCell("=HYPERLINK(\"http://evil\")")).toBe(`"'=HYPERLINK(""http://evil"")"`);
    expect(csvCell("+1 555")).toBe("'+1 555");
    expect(csvCell("-2 spares")).toBe("'-2 spares");
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvCell("\t=1")).toBe("'\t=1");
    expect(csvCell("\r=1")).toBe(`"'\r=1"`);
    expect(csvCell("Wheels, 4 in")).toBe('"Wheels, 4 in"');
    expect(csvCell('The "good" ones')).toBe('"The ""good"" ones"');
    expect(csvCell("line one\nline two")).toBe('"line one\nline two"');
    expect(csvCell("SKU am-5437 (2)")).toBe("SKU am-5437 (2)");
    expect(csvCell(12)).toBe("12");
    expect(csvCell(null)).toBe("");
    expect(toCsv([["a", "b"], ["=c", null]])).toBe("﻿a,b\r\n'=c,\r\n");
  });

  it("exports the filtered items with the sheet's columns", async () => {
    await makeItem({
      description: "=cmd|' /C calc'!A0",
      notes: "Two sizes, see doc",
      link: "https://shop.example.com/x",
      quantity: 3,
      costCents: 4599,
      subteam: null,
      orderer: p.orderer,
      createdBy: p.asker,
      createdAt: new Date("2026-09-24T06:30:00Z"), // Sep 23 in Anaheim
      status: "ORDERED",
      statusChangedAt: TEST_NOW,
      statusChangedBy: p.bizLead,
    });
    await makeItem({ description: "Finished", status: "DONE", orderer: null, createdBy: null, createdAt: TEST_NOW });
    const items = await listOrdersForExport(p.swMember, { filter: "open" }, t.db);
    const csv = ordersToCsv(items, TEST_TZ);
    const lines = csv.replace(/^﻿/, "").split("\r\n");
    expect(lines[0]).toBe(ORDER_CSV_HEADER.join(","));
    expect(lines[1]).toBe(
      [
        "Olivia Orderer",
        "Ordered",
        `'=cmd|' /C calc'!A0`,
        '"Two sizes, see doc"',
        "https://shop.example.com/x",
        "",
        "3",
        "45.99",
        "Whole team",
        "2026-09-23",
        "Ethan Asker",
        "2026-09-24",
        "Bo Business",
      ].join(","),
    );
    expect(lines).toHaveLength(3); // header, one item, and the final line break
    const all = ordersToCsv(await listOrdersForExport(p.swMember, { filter: "all" }, t.db), TEST_TZ);
    expect(all).toContain("\r\n,Done,Finished,,,,,,Build,2026-09-24,,,\r\n");
  });
});
