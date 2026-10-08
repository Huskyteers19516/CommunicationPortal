import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addDays } from "@/lib/dates";
import { cartTotalCents, changeDueCents, moneyBookToCsv, parseSalesPeriod, periodStart } from "@/lib/sales";
import type { Actor } from "@/server/actor";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import { getMoneyBook, getMoneyBookExport, getOrderQueue, getRegister } from "@/server/queries/sales";
import {
  createLedgerEntry,
  createSale,
  createSaleItem,
  deleteLedgerEntry,
  deleteSaleItem,
  markSaleServed,
  reopenSale,
  updateSaleItem,
  voidSale,
} from "@/server/services/sales";
import { createTestDb, type TestDb } from "./helpers/db";
import { contextFor, makeUser, TEST_NOW, TEST_TODAY } from "./helpers/factories";

type Who = "owner" | "captain" | "bizLead" | "swLead" | "bizMember" | "swMember" | "buildMember" | "disabledBiz";

let t: TestDb;
let p: Record<Who, Actor>;

beforeAll(async () => {
  t = await createTestDb();
  const db = t.db;
  p = {
    owner: await makeUser(db, { role: "MEMBER", subteam: "SOFTWARE", isAdmin: true }),
    captain: await makeUser(db, { role: "CAPTAIN" }),
    bizLead: await makeUser(db, { role: "BUSINESS_LEADER" }),
    swLead: await makeUser(db, { role: "SOFTWARE_LEADER" }),
    bizMember: await makeUser(db, { role: "MEMBER", subteam: "BUSINESS", name: "Gwen Business" }),
    swMember: await makeUser(db, { role: "MEMBER", subteam: "SOFTWARE", name: "Maya Software" }),
    buildMember: await makeUser(db, { role: "MEMBER", subteam: "BUILD" }),
    disabledBiz: await makeUser(db, { role: "MEMBER", subteam: "BUSINESS", status: "DISABLED" }),
  };
});

afterAll(async () => {
  await t?.drop();
});

const ctxFor = (a: Actor, now: Date = TEST_NOW) => ({ ...contextFor(t.db, a), now });

let n = 0;
async function item(price = "2.50", over: Record<string, unknown> = {}) {
  return createSaleItem(ctxFor(p.bizMember), { name: `Cookie ${++n}`, category: "Baked goods", price, ...over });
}

describe("menu", () => {
  it("lets the Business team and staff add, edit, hide, and remove items", async () => {
    for (const who of ["bizMember", "bizLead", "swLead", "captain", "owner"] as const) {
      const { id } = await createSaleItem(ctxFor(p[who]), { name: `Lemonade ${who}`, category: "", price: "$1.75" });
      const row = await t.db.saleItem.findUniqueOrThrow({ where: { id } });
      expect(row).toMatchObject({ priceCents: 175, category: "", active: true });
    }
    const { id } = await item("3");
    await updateSaleItem(ctxFor(p.bizLead), { itemId: id, name: "Brownie", category: "Baked goods", price: "3.25" });
    expect(await t.db.saleItem.findUniqueOrThrow({ where: { id } })).toMatchObject({ name: "Brownie", priceCents: 325, active: false });
    await deleteSaleItem(ctxFor(p.bizLead), { itemId: id });
    await expect(deleteSaleItem(ctxFor(p.bizLead), { itemId: id })).rejects.toThrow(NotFoundError);
  });

  it("refuses members outside Business and disabled accounts", async () => {
    for (const who of ["swMember", "buildMember", "disabledBiz"] as const) {
      await expect(createSaleItem(ctxFor(p[who]), { name: "Nope", price: "1" })).rejects.toThrow(ForbiddenError);
    }
    const { id } = await item();
    await expect(updateSaleItem(ctxFor(p.swMember), { itemId: id, name: "x", price: "1", active: "on" })).rejects.toThrow(ForbiddenError);
    await expect(deleteSaleItem(ctxFor(p.swMember), { itemId: id })).rejects.toThrow(ForbiddenError);
  });

  it("checks names and prices", async () => {
    await expect(createSaleItem(ctxFor(p.bizLead), { name: "", price: "1" })).rejects.toThrow(ValidationError);
    await expect(createSaleItem(ctxFor(p.bizLead), { name: "Pie", price: "" })).rejects.toThrow(ValidationError);
    await expect(createSaleItem(ctxFor(p.bizLead), { name: "Pie", price: "-2" })).rejects.toThrow(ValidationError);
    await expect(createSaleItem(ctxFor(p.bizLead), { name: "Pie", price: "abc" })).rejects.toThrow(ValidationError);
    // Free samples are fine.
    await expect(createSaleItem(ctxFor(p.bizLead), { name: "Sample", price: "0" })).resolves.toBeTruthy();
  });
});

describe("register", () => {
  it("rings up an order with menu prices from the database and custom lines", async () => {
    const cookie = await item("2.50");
    const drink = await item("1.25");
    const sale = await createSale(ctxFor(p.swMember), {
      lines: JSON.stringify([
        { itemId: cookie.id, quantity: 3 },
        { itemId: drink.id, quantity: "2" },
        { name: "Donation", priceCents: 500, quantity: 1 },
      ]),
      customer: "  Jordan ",
      payment: "VENMO",
      queue: "on",
    });
    expect(sale).toMatchObject({ totalCents: 3 * 250 + 2 * 125 + 500, status: "OPEN" });
    const row = await t.db.sale.findUniqueOrThrow({ where: { id: sale.id }, include: { lines: true } });
    expect(row).toMatchObject({ customer: "Jordan", payment: "VENMO", soldById: p.swMember.id, servedAt: null });
    expect(row.lines.map((l) => [l.name, l.priceCents, l.quantity, l.itemId])).toEqual(
      expect.arrayContaining([
        [expect.stringMatching(/^Cookie/), 250, 3, cookie.id],
        ["Donation", 500, 1, null],
      ]),
    );
  });

  it("serves right away when it doesn't need making, and numbers orders", async () => {
    const cookie = await item();
    const a = await createSale(ctxFor(p.buildMember), { lines: JSON.stringify([{ itemId: cookie.id, quantity: 1 }]) });
    const b = await createSale(ctxFor(p.buildMember), { lines: JSON.stringify([{ itemId: cookie.id, quantity: 1 }]) });
    expect(a.status).toBe("SERVED");
    expect(b.number).toBeGreaterThan(a.number);
    const row = await t.db.sale.findUniqueOrThrow({ where: { id: a.id } });
    expect(row).toMatchObject({ payment: "CASH", servedById: p.buildMember.id });
  });

  it("refuses empty orders, hidden or removed items, bad quantities, and disabled accounts", async () => {
    const cookie = await item();
    await expect(createSale(ctxFor(p.swMember), { lines: "[]" })).rejects.toThrow(ValidationError);
    await expect(createSale(ctxFor(p.swMember), { lines: "not json" })).rejects.toThrow(ValidationError);
    await expect(createSale(ctxFor(p.swMember), { lines: JSON.stringify([{ itemId: cookie.id, quantity: 0 }]) })).rejects.toThrow(ValidationError);
    await expect(createSale(ctxFor(p.swMember), { lines: JSON.stringify([{ itemId: cookie.id, quantity: 1.5 }]) })).rejects.toThrow(ValidationError);
    await expect(createSale(ctxFor(p.swMember), { lines: JSON.stringify([{ name: "Tip", priceCents: -5, quantity: 1 }]) })).rejects.toThrow(
      ValidationError,
    );
    await expect(createSale(ctxFor(p.disabledBiz), { lines: JSON.stringify([{ itemId: cookie.id, quantity: 1 }]) })).rejects.toThrow(
      ForbiddenError,
    );
    await updateSaleItem(ctxFor(p.bizLead), { itemId: cookie.id, name: "Cookie", price: "2" }); // hidden
    await expect(createSale(ctxFor(p.swMember), { lines: JSON.stringify([{ itemId: cookie.id, quantity: 1 }]) })).rejects.toThrow(ConflictError);
    await expect(createSale(ctxFor(p.swMember), { lines: JSON.stringify([{ itemId: "gone", quantity: 1 }]) })).rejects.toThrow(ConflictError);
  });

  it("ties an order to an existing fundraiser only", async () => {
    const cookie = await item();
    const f = await t.db.fundraiser.create({ data: { name: "Bake sale", status: "ACTIVE" } });
    const s = await createSale(ctxFor(p.swMember), { lines: JSON.stringify([{ itemId: cookie.id, quantity: 1 }]), fundraiserId: f.id });
    expect((await t.db.sale.findUniqueOrThrow({ where: { id: s.id } })).fundraiserId).toBe(f.id);
    await expect(
      createSale(ctxFor(p.swMember), { lines: JSON.stringify([{ itemId: cookie.id, quantity: 1 }]), fundraiserId: "nope" }),
    ).rejects.toThrow(ValidationError);
    const reg = await getRegister(p.swMember, t.db);
    expect(reg.defaultEventId).toBe(f.id);
    expect(reg.canManage).toBe(false);
  });
});

describe("order queue", () => {
  it("serves, puts back, and voids orders", async () => {
    const cookie = await item();
    const s = await createSale(ctxFor(p.swMember), { lines: JSON.stringify([{ itemId: cookie.id, quantity: 2 }]), queue: "on" });
    let q = await getOrderQueue(p.buildMember, t.db);
    const mine = q.open.find((o) => o.id === s.id);
    expect(mine).toMatchObject({ canVoid: false, soldBy: "Maya Software" });

    await markSaleServed(ctxFor(p.buildMember), { saleId: s.id });
    await expect(markSaleServed(ctxFor(p.buildMember), { saleId: s.id })).rejects.toThrow(/already served/);
    await reopenSale(ctxFor(p.buildMember), { saleId: s.id });
    await expect(reopenSale(ctxFor(p.buildMember), { saleId: s.id })).rejects.toThrow(/already on the queue/);

    // Only whoever rang it up, or the Business team and staff.
    await expect(voidSale(ctxFor(p.buildMember), { saleId: s.id })).rejects.toThrow(ForbiddenError);
    await voidSale(ctxFor(p.swMember), { saleId: s.id });
    await expect(voidSale(ctxFor(p.bizMember), { saleId: s.id })).rejects.toThrow(/already voided/);
    await expect(markSaleServed(ctxFor(p.bizMember), { saleId: s.id })).rejects.toThrow(/voided/);
    q = await getOrderQueue(p.bizMember, t.db);
    expect(q.open.some((o) => o.id === s.id)).toBe(false);
    expect(q.recent.find((o) => o.id === s.id)).toMatchObject({ status: "VOIDED", canVoid: false });

    const other = await createSale(ctxFor(p.swMember), { lines: JSON.stringify([{ itemId: cookie.id, quantity: 1 }]) });
    await voidSale(ctxFor(p.bizMember), { saleId: other.id });
    await expect(voidSale(ctxFor(p.bizMember), { saleId: "missing" })).rejects.toThrow(NotFoundError);
  });
});

describe("money book", () => {
  it("adds up sales, money in, and money out by period and fundraiser, without voided orders", async () => {
    // A fresh database view: only count what this test adds, through its own fundraiser.
    const f = await t.db.fundraiser.create({ data: { name: "Robotics bake sale", status: "ACTIVE" } });
    const cookie = await item("2.00");
    const today = await createSale(ctxFor(p.swMember), {
      lines: JSON.stringify([{ itemId: cookie.id, quantity: 4 }]),
      payment: "CARD",
      fundraiserId: f.id,
    });
    const lastWeek = addDays(TEST_TODAY, -5);
    await createSale(ctxFor(p.swMember, new Date(TEST_NOW.getTime() - 5 * 86_400_000)), {
      lines: JSON.stringify([{ itemId: cookie.id, quantity: 1 }]),
      fundraiserId: f.id,
    });
    const voided = await createSale(ctxFor(p.swMember), { lines: JSON.stringify([{ itemId: cookie.id, quantity: 10 }]), fundraiserId: f.id });
    await voidSale(ctxFor(p.swMember), { saleId: voided.id });

    await createLedgerEntry(ctxFor(p.bizLead), {
      kind: "EXPENSE",
      description: "Flour and sugar",
      amount: "12.40",
      payment: "CARD",
      occurredOn: lastWeek,
      fundraiserId: f.id,
    });
    const tip = await createLedgerEntry(ctxFor(p.bizLead), { kind: "INCOME", description: "Cash donation", amount: "20", occurredOn: TEST_TODAY, fundraiserId: f.id });

    const day = await getMoneyBook(p.swMember, { period: "today", event: f.id }, TEST_TODAY, t.db);
    expect(day.totals).toEqual({ salesCents: 800, salesCount: 1, incomeCents: 2000, expenseCents: 0, netCents: 2800 });
    expect(day.payments).toEqual([{ payment: "CARD", cents: 800 }]);
    expect(day.items).toEqual([{ name: cookie.name, quantity: 4, cents: 800 }]);
    expect(day.rows.map((r) => r.id)).toEqual(expect.arrayContaining([today.id, tip.id]));
    expect(day.canManage).toBe(false);

    const week = await getMoneyBook(p.bizLead, { period: "week", event: f.id }, TEST_TODAY, t.db);
    expect(week.totals).toMatchObject({ salesCents: 1000, salesCount: 2, incomeCents: 2000, expenseCents: 1240, netCents: 1760 });
    expect(week.canManage).toBe(true);

    const csv = moneyBookToCsv(await getMoneyBookExport({ period: "week", event: f.id }, TEST_TODAY, t.db));
    expect(csv).toContain("Flour and sugar");
    expect(csv).toContain("-12.40");
    expect(csv).not.toContain("10× ");

    await deleteLedgerEntry(ctxFor(p.bizLead), { entryId: tip.id });
    await expect(deleteLedgerEntry(ctxFor(p.bizLead), { entryId: tip.id })).rejects.toThrow(NotFoundError);
  });

  it("lets only the Business team and staff write the money book", async () => {
    const entry = { kind: "EXPENSE", description: "Napkins", amount: "3", occurredOn: TEST_TODAY };
    await expect(createLedgerEntry(ctxFor(p.swMember), entry)).rejects.toThrow(ForbiddenError);
    await expect(createLedgerEntry(ctxFor(p.bizMember), { ...entry, amount: "0" })).rejects.toThrow(ValidationError);
    await expect(createLedgerEntry(ctxFor(p.bizMember), { ...entry, kind: "MAYBE" })).rejects.toThrow(ValidationError);
    const { id } = await createLedgerEntry(ctxFor(p.bizMember), entry);
    await expect(deleteLedgerEntry(ctxFor(p.swMember), { entryId: id })).rejects.toThrow(ForbiddenError);
  });
});

describe("helpers", () => {
  it("does cart math and periods", () => {
    expect(cartTotalCents([{ priceCents: 250, quantity: 3 }, { priceCents: 100, quantity: 1 }])).toBe(850);
    expect(changeDueCents(850, 1000)).toBe(150);
    expect(changeDueCents(850, 500)).toBeNull();
    expect(changeDueCents(850, null)).toBeNull();
    expect(parseSalesPeriod("week")).toBe("week");
    expect(parseSalesPeriod("bogus")).toBe("today");
    expect(periodStart("today", TEST_TODAY)).toBe(TEST_TODAY);
    expect(periodStart("week", TEST_TODAY)).toBe(addDays(TEST_TODAY, -6));
    expect(periodStart("all", TEST_TODAY)).toBeNull();
  });
});
