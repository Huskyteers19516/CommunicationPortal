import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Subteam } from "@/generated/prisma/enums";
import type { Actor } from "@/server/actor";
import { ForbiddenError, NotFoundError, RateLimitError, ValidationError } from "@/server/errors";
import { getManagedCategoryLists, getTaskFormCategories } from "@/server/queries/categories";
import {
  CATEGORY_RATE_LIMIT,
  createCategory,
  deleteCategory,
  findOrCreateCategory,
  moveCategory,
  renameCategory,
} from "@/server/services/categories";
import { createTestDb, type TestDb } from "./helpers/db";
import { contextFor, makeTask, makeUser, TEST_NOW } from "./helpers/factories";

let t: TestDb;
let p: Record<
  | "admin"
  | "captain"
  | "mentor"
  | "teacher"
  | "swLead"
  | "buildLead1"
  | "buildLead2"
  | "bizLead"
  | "swMember"
  | "buildMember"
  | "pendingBuildLead"
  | "disabledBuildLead",
  Actor
>;

beforeAll(async () => {
  t = await createTestDb();
  const db = t.db;
  p = {
    admin: await makeUser(db, { role: "MEMBER", subteam: "BUSINESS", isAdmin: true, name: "Ada Admin" }),
    captain: await makeUser(db, { role: "CAPTAIN", name: "Casey Captain" }),
    mentor: await makeUser(db, { role: "MENTOR", name: "Morgan Mentor" }),
    teacher: await makeUser(db, { role: "TEACHER", name: "Taylor Teacher" }),
    swLead: await makeUser(db, { role: "SOFTWARE_LEADER", name: "Sam Software" }),
    buildLead1: await makeUser(db, { role: "BUILD_LEADER", name: "Blake Build" }),
    buildLead2: await makeUser(db, { role: "BUILD_LEADER", name: "Bailey Build" }),
    bizLead: await makeUser(db, { role: "BUSINESS_LEADER", name: "Bo Business" }),
    swMember: await makeUser(db, { role: "MEMBER", subteam: "SOFTWARE", name: "Sky Member" }),
    buildMember: await makeUser(db, { role: "MEMBER", subteam: "BUILD", name: "Brook Member" }),
    pendingBuildLead: await makeUser(db, { role: "BUILD_LEADER", status: "PENDING", name: "Pat Pending" }),
    disabledBuildLead: await makeUser(db, { role: "BUILD_LEADER", status: "DISABLED", name: "Dee Disabled" }),
  };
});

afterAll(async () => {
  await t?.drop();
});

const ctxFor = (a: Actor) => contextFor(t.db, a);

async function list(subteam: Subteam | null) {
  return t.db.taskCategory.findMany({ where: { subteam }, orderBy: { position: "asc" }, select: { name: true, position: true } });
}

async function errorOf(promise: Promise<unknown>) {
  const err = await promise.catch((e) => e);
  expect(err).toBeInstanceOf(Error);
  return err as Error;
}

describe("createCategory", () => {
  it("lets a leader add categories to their subteam, in order, with a tidied-up name", async () => {
    const { id } = await createCategory(ctxFor(p.buildLead1), { subteam: "BUILD", name: "  Intake  " });
    await createCategory(ctxFor(p.buildLead2), { subteam: "BUILD", name: "CAD   &\tDesign" });
    const row = await t.db.taskCategory.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ subteam: "BUILD", name: "Intake", nameKey: "intake", position: 0, createdById: p.buildLead1.id });
    expect(await list("BUILD")).toEqual([
      { name: "Intake", position: 0 },
      { name: "CAD & Design", position: 1 },
    ]);
  });

  it("rejects a duplicate name in the same subteam, ignoring case, but allows it elsewhere", async () => {
    const err = await errorOf(createCategory(ctxFor(p.buildLead2), { subteam: "BUILD", name: "INTAKE" }));
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).fieldErrors.name).toBe("There's already an “Intake” category in Build.");
    // Same name in another subteam is fine.
    await expect(createCategory(ctxFor(p.captain), { subteam: "SOFTWARE", name: "Intake" })).resolves.toHaveProperty("id");
  });

  it("catches duplicates in the whole-team list too (where the unique index can't)", async () => {
    await createCategory(ctxFor(p.captain), { subteam: "", name: "Events" });
    const err = await errorOf(createCategory(ctxFor(p.mentor), { subteam: "", name: "events" }));
    expect((err as ValidationError).fieldErrors.name).toBe("There's already an “Events” category for the whole team.");

    // Racing creates: exactly one wins.
    const results = await Promise.allSettled(
      [p.captain, p.mentor, p.teacher, p.admin].map((who) => createCategory(ctxFor(who), { subteam: "", name: "Competition" })),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results) if (r.status === "rejected") expect(r.reason).toBeInstanceOf(ValidationError);
    expect(await t.db.taskCategory.count({ where: { subteam: null, nameKey: "competition" } })).toBe(1);
  });

  it("validates the name and subteam", async () => {
    const fieldErrors = async (input: Record<string, unknown>) =>
      ((await errorOf(createCategory(ctxFor(p.captain), input))) as ValidationError).fieldErrors;
    expect((await fieldErrors({ subteam: "BUILD", name: "   " })).name).toBe("Name is required.");
    expect((await fieldErrors({ subteam: "BUILD" })).name).toBe("Name is required.");
    expect((await fieldErrors({ subteam: "BUILD", name: "x".repeat(41) })).name).toMatch(/at most 40/);
    expect((await fieldErrors({ subteam: "ROBOTS", name: "Intake 2" })).subteam).toBe("Pick a subteam.");
    // Exactly 40 characters is fine.
    await expect(createCategory(ctxFor(p.captain), { subteam: "BUSINESS", name: "y".repeat(40) })).resolves.toHaveProperty("id");
  });

  it("denies members, other subteams' leaders, whole-team for subteam leaders, and inactive leaders", async () => {
    const denied: [Actor, string][] = [
      [p.buildMember, "BUILD"],
      [p.swMember, "SOFTWARE"],
      [p.swLead, "BUILD"],
      [p.buildLead1, "SOFTWARE"],
      [p.buildLead1, ""],
      [p.pendingBuildLead, "BUILD"],
      [p.disabledBuildLead, "BUILD"],
    ];
    for (const [who, subteam] of denied) {
      await expect(createCategory(ctxFor(who), { subteam, name: "Nope" }), `${who.name} → ${subteam}`).rejects.toThrow(ForbiddenError);
    }
    // Members are refused before validation, too.
    await expect(createCategory(ctxFor(p.buildMember), {})).rejects.toThrow(ForbiddenError);
    expect(await t.db.taskCategory.count({ where: { name: "Nope" } })).toBe(0);
  });

  it("lets captain, mentor, teacher and admin add categories anywhere", async () => {
    for (const [i, who] of [p.captain, p.mentor, p.teacher, p.admin].entries()) {
      for (const subteam of ["SOFTWARE", "BUILD", "BUSINESS", ""]) {
        await expect(createCategory(ctxFor(who), { subteam, name: `All-scope ${i}` })).resolves.toHaveProperty("id");
      }
    }
  });

  it("caps each list at 30 categories", async () => {
    const lead = await makeUser(t.db, { role: "BUSINESS_LEADER", name: "Cap Tester" });
    const existing = await t.db.taskCategory.count({ where: { subteam: "BUSINESS" } });
    for (let i = existing; i < 30; i++) await createCategory(ctxFor(lead), { subteam: "BUSINESS", name: `Biz ${i}` });
    const err = await errorOf(createCategory(ctxFor(lead), { subteam: "BUSINESS", name: "One too many" }));
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).fieldErrors.name).toBe("Business already has 30 categories. Delete one you don't use first.");
  });

  it("is rate limited per person", async () => {
    const lead = await makeUser(t.db, { role: "SOFTWARE_LEADER", name: "Busy Lead" });
    await t.db.rateLimit.create({ data: { key: `category:${lead.id}`, count: CATEGORY_RATE_LIMIT.limit, windowStart: TEST_NOW } });
    await expect(createCategory(ctxFor(lead), { subteam: "SOFTWARE", name: "Too fast" })).rejects.toThrow(RateLimitError);
  });
});

describe("renameCategory", () => {
  it("renames, allows a capitalization-only change, and rejects clashes", async () => {
    const { id } = await createCategory(ctxFor(p.swLead), { subteam: "SOFTWARE", name: "vision" });
    await createCategory(ctxFor(p.swLead), { subteam: "SOFTWARE", name: "Autonomous" });
    await renameCategory(ctxFor(p.swLead), { categoryId: id, name: "Vision" });
    expect(await t.db.taskCategory.findUniqueOrThrow({ where: { id } })).toMatchObject({ name: "Vision", nameKey: "vision" });

    const err = await errorOf(renameCategory(ctxFor(p.swLead), { categoryId: id, name: "autonomous" }));
    expect((err as ValidationError).fieldErrors.name).toBe("There's already an “Autonomous” category in Software.");
    expect((await errorOf(renameCategory(ctxFor(p.swLead), { categoryId: id, name: " " })) as ValidationError).fieldErrors.name).toBe(
      "Name is required.",
    );
  });

  it("hides other subteams' categories and forbids members", async () => {
    const { id } = await createCategory(ctxFor(p.buildLead1), { subteam: "BUILD", name: "Drivetrain" });
    await expect(renameCategory(ctxFor(p.swLead), { categoryId: id, name: "Mine now" })).rejects.toThrow(NotFoundError);
    await expect(renameCategory(ctxFor(p.buildMember), { categoryId: id, name: "Mine now" })).rejects.toThrow(ForbiddenError);
    await expect(renameCategory(ctxFor(p.pendingBuildLead), { categoryId: id, name: "Mine now" })).rejects.toThrow(ForbiddenError);
    await expect(renameCategory(ctxFor(p.buildLead1), { categoryId: "missing", name: "Whatever" })).rejects.toThrow(NotFoundError);
    // The whole-team list is all-scope only.
    const team = await t.db.taskCategory.findFirstOrThrow({ where: { subteam: null } });
    await expect(renameCategory(ctxFor(p.buildLead1), { categoryId: team.id, name: "Mine now" })).rejects.toThrow(NotFoundError);
    // Another build leader can.
    await renameCategory(ctxFor(p.buildLead2), { categoryId: id, name: "Drive base" });
    expect((await t.db.taskCategory.findUniqueOrThrow({ where: { id } })).name).toBe("Drive base");
  });
});

describe("deleteCategory", () => {
  it("keeps the tasks, uncategorized", async () => {
    const { id } = await createCategory(ctxFor(p.buildLead1), { subteam: "BUILD", name: "Lift" });
    const task = await makeTask(t.db, p.buildLead1, { subteam: "BUILD" });
    await t.db.task.update({ where: { id: task.id }, data: { categoryId: id } });

    await expect(deleteCategory(ctxFor(p.swLead), { categoryId: id })).rejects.toThrow(NotFoundError);
    await expect(deleteCategory(ctxFor(p.buildMember), { categoryId: id })).rejects.toThrow(ForbiddenError);
    await deleteCategory(ctxFor(p.buildLead2), { categoryId: id });

    expect(await t.db.taskCategory.findUnique({ where: { id } })).toBeNull();
    expect((await t.db.task.findUniqueOrThrow({ where: { id: task.id } })).categoryId).toBeNull();
    await expect(deleteCategory(ctxFor(p.buildLead2), { categoryId: id })).rejects.toThrow(NotFoundError);
  });
});

describe("moveCategory", () => {
  it("swaps with the neighbour and renumbers the list 0..n-1", async () => {
    const lead = await makeUser(t.db, { role: "MENTOR", name: "Order Mentor" });
    const ctx = ctxFor(lead);
    // A fresh list: the whole-team one has leftovers from earlier tests, so clear it first.
    await t.db.taskCategory.deleteMany({ where: { subteam: null } });
    const a = await createCategory(ctx, { subteam: "", name: "A" });
    const b = await createCategory(ctx, { subteam: "", name: "B" });
    const c = await createCategory(ctx, { subteam: "", name: "C" });
    const d = await createCategory(ctx, { subteam: "", name: "D" });
    const names = async () => (await list(null)).map((x) => `${x.name}${x.position}`);

    await moveCategory(ctx, { categoryId: c.id, direction: "up" });
    expect(await names()).toEqual(["A0", "C1", "B2", "D3"]);
    await moveCategory(ctx, { categoryId: a.id, direction: "up" }); // already first: nothing changes
    expect(await names()).toEqual(["A0", "C1", "B2", "D3"]);
    await moveCategory(ctx, { categoryId: d.id, direction: "down" }); // already last
    expect(await names()).toEqual(["A0", "C1", "B2", "D3"]);

    // A delete leaves a gap; the next move closes it.
    await deleteCategory(ctx, { categoryId: b.id });
    await moveCategory(ctx, { categoryId: a.id, direction: "down" });
    expect(await names()).toEqual(["C0", "A1", "D2"]);

    await expect(moveCategory(ctx, { categoryId: a.id, direction: "sideways" })).rejects.toThrow(ValidationError);
    await expect(moveCategory(ctxFor(p.buildLead1), { categoryId: a.id, direction: "up" })).rejects.toThrow(NotFoundError);
    await expect(moveCategory(ctxFor(p.swMember), { categoryId: a.id, direction: "up" })).rejects.toThrow(ForbiddenError);
  });
});

describe("findOrCreateCategory", () => {
  it("finds an existing category ignoring case, or adds a new one at the end", async () => {
    const found = await t.db.$transaction((tx) => findOrCreateCategory(tx, p.buildLead1, { subteam: "BUILD", name: " intake " }));
    const intake = await t.db.taskCategory.findFirstOrThrow({ where: { subteam: "BUILD", nameKey: "intake" } });
    expect(found).toEqual({ id: intake.id, created: false });

    const made = await t.db.$transaction((tx) => findOrCreateCategory(tx, p.buildLead1, { subteam: "BUILD", name: "Outtake" }));
    expect(made.created).toBe(true);
    const all = await list("BUILD");
    expect(all[all.length - 1].name).toBe("Outtake");

    await expect(
      t.db.$transaction((tx) => findOrCreateCategory(tx, p.swLead, { subteam: "BUILD", name: "Sneaky" })),
    ).rejects.toThrow(ForbiddenError);
    await expect(t.db.$transaction((tx) => findOrCreateCategory(tx, p.buildLead1, { subteam: "BUILD", name: "  " }))).rejects.toThrow(
      ValidationError,
    );
  });
});

describe("category queries", () => {
  it("getTaskFormCategories: lists for the subteams the actor can create tasks in", async () => {
    const lead = await getTaskFormCategories(p.buildLead1, t.db);
    expect(Object.keys(lead)).toEqual(["BUILD"]);
    expect(lead.BUILD!.map((c) => c.name).slice(0, 2)).toEqual(["Intake", "CAD & Design"]);
    const captain = await getTaskFormCategories(p.captain, t.db);
    expect(Object.keys(captain).sort()).toEqual(["", "BUILD", "BUSINESS", "SOFTWARE"]);
    expect(await getTaskFormCategories(p.buildMember, t.db)).toEqual({});
  });

  it("getManagedCategoryLists: leaders get their own list; all-scope gets every list, with task counts", async () => {
    const lead = await getManagedCategoryLists(p.buildLead1, t.db);
    expect(lead.map((l) => l.key)).toEqual(["BUILD"]);
    const captain = await getManagedCategoryLists(p.captain, t.db);
    expect(captain.map((l) => [l.key, l.label])).toEqual([
      ["SOFTWARE", "Software"],
      ["BUILD", "Build"],
      ["BUSINESS", "Business"],
      ["TEAM", "Whole team"],
    ]);
    const intake = lead[0].categories.find((c) => c.name === "Intake")!;
    await makeTask(t.db, p.buildLead1, { subteam: "BUILD" }).then((task) =>
      t.db.task.update({ where: { id: task.id }, data: { categoryId: intake.id } }),
    );
    const again = await getManagedCategoryLists(p.buildLead1, t.db);
    expect(again[0].categories.find((c) => c.id === intake.id)?.taskCount).toBe(1);
    expect(await getManagedCategoryLists(p.buildMember, t.db)).toEqual([]);
  });
});
