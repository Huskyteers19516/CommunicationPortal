import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PartProcess, PartStatus } from "@/generated/prisma/enums";
import { addDays, dateOnlyToDb } from "@/lib/dates";
import type { Actor } from "@/server/actor";
import { ConflictError, ForbiddenError, NotFoundError, RateLimitError, ValidationError } from "@/server/errors";
import { countPartsImMaking, getPartCategoryGroups, getPartForEdit, getPartsQueue, type PartsWho } from "@/server/queries/parts";
import {
  claimPart,
  createPart,
  deletePart,
  finishPart,
  movePart,
  PART_RATE_LIMIT,
  partGrabbedMessage,
  reopenPart,
  unclaimPart,
  updatePart,
} from "@/server/services/parts";
import { createTestDb, type TestDb } from "./helpers/db";
import { contextFor, makeUser, TEST_NOW, TEST_TODAY } from "./helpers/factories";

let t: TestDb;
let p: Record<
  | "admin"
  | "captain"
  | "mentor"
  | "teacher"
  | "buildLead"
  | "buildLead2"
  | "swLead"
  | "bizLead"
  | "asker"
  | "maker"
  | "buildMember"
  | "swMember"
  | "bizMember"
  | "pending"
  | "disabled",
  Actor
>;
let cat: { intake: string; vision: string; events: string };

beforeAll(async () => {
  t = await createTestDb();
  const db = t.db;
  p = {
    admin: await makeUser(db, { role: "MEMBER", subteam: "BUSINESS", isAdmin: true, name: "Ada Admin" }),
    captain: await makeUser(db, { role: "CAPTAIN", name: "Casey Captain" }),
    mentor: await makeUser(db, { role: "MENTOR", name: "Morgan Mentor" }),
    teacher: await makeUser(db, { role: "TEACHER", name: "Taylor Teacher" }),
    buildLead: await makeUser(db, { role: "BUILD_LEADER", name: "Blake Build" }),
    buildLead2: await makeUser(db, { role: "BUILD_LEADER", name: "Bailey Build" }),
    swLead: await makeUser(db, { role: "SOFTWARE_LEADER", name: "Sam Software" }),
    bizLead: await makeUser(db, { role: "BUSINESS_LEADER", name: "Bo Business" }),
    asker: await makeUser(db, { role: "MEMBER", subteam: "BUILD", name: "Ethan Asker" }),
    maker: await makeUser(db, { role: "MEMBER", subteam: "BUILD", name: "Isabella Maker" }),
    buildMember: await makeUser(db, { role: "MEMBER", subteam: "BUILD", name: "Liam Build" }),
    swMember: await makeUser(db, { role: "MEMBER", subteam: "SOFTWARE", name: "Maya Software" }),
    bizMember: await makeUser(db, { role: "MEMBER", subteam: "BUSINESS", name: "Ava Business" }),
    pending: await makeUser(db, { role: "MEMBER", subteam: "BUILD", status: "PENDING", name: "Pat Pending" }),
    disabled: await makeUser(db, { role: "MEMBER", subteam: "BUILD", status: "DISABLED", name: "Dee Disabled" }),
  };
  const mk = (subteam: "BUILD" | "SOFTWARE" | null, name: string, position: number) =>
    db.taskCategory.create({ data: { subteam, name, nameKey: name.toLowerCase(), position }, select: { id: true } });
  cat = {
    intake: (await mk("BUILD", "Intake", 0)).id,
    vision: (await mk("SOFTWARE", "Vision", 0)).id,
    events: (await mk(null, "Events", 0)).id,
  };
});

afterAll(async () => {
  await t?.drop();
});

beforeEach(async () => {
  await t.db.part.deleteMany();
  await t.db.rateLimit.deleteMany();
});

const ctxFor = (a: Actor) => contextFor(t.db, a);

async function errorOf(promise: Promise<unknown>) {
  const err = await promise.catch((e) => e);
  expect(err).toBeInstanceOf(Error);
  return err as Error & { userMessage: string; fieldErrors?: Record<string, string> };
}

/** A part straight in the DB (bypassing services). */
async function makePart(
  input: {
    name?: string;
    process?: PartProcess;
    status?: PartStatus;
    position?: number;
    requestedBy?: Actor | null;
    claimedBy?: Actor | null;
    doneAt?: Date | null;
    fileUrl?: string;
    neededBy?: string | null;
    createdAt?: Date;
  } = {},
) {
  const status = input.status ?? "NEEDED";
  return t.db.part.create({
    data: {
      name: input.name ?? `Part ${Math.random().toString(36).slice(2, 8)}`,
      process: input.process ?? "PRINT_3D",
      status,
      position: input.position ?? 0,
      requestedById: input.requestedBy === undefined ? p.asker.id : (input.requestedBy?.id ?? null),
      claimedById: input.claimedBy?.id ?? null,
      claimedAt: input.claimedBy ? TEST_NOW : null,
      doneAt: input.doneAt !== undefined ? input.doneAt : status === "DONE" ? TEST_NOW : null,
      fileUrl: input.fileUrl ?? "",
      neededBy: input.neededBy ? dateOnlyToDb(input.neededBy) : null,
      ...(input.createdAt ? { createdAt: input.createdAt } : {}),
    },
  });
}

const row = (id: string) => t.db.part.findUniqueOrThrow({ where: { id } });

async function queueNames() {
  const rows = await t.db.part.findMany({
    where: { status: { not: "DONE" } },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    select: { name: true, position: true },
  });
  return rows;
}

const LINK_MESSAGE = "Enter a web link to the file, like drive.google.com/…";

const validFields = {
  name: "Intake side plate",
  process: "LASER_CUT",
  quantity: "2",
  material: "1/8 in polycarbonate",
  fileUrl: "https://cad.example.com/intake-side-plate.dxf",
  notes: "Deburr the edges.",
  categoryId: "",
  neededBy: "",
};

// ── create ──────────────────────────────────────────────────────────────────

describe("createPart", () => {
  it("lets any active member ask for a part: tidied values, up for grabs, at the end of the queue", async () => {
    await makePart({ name: "Older", position: 4 });
    await makePart({ name: "Finished long ago", status: "DONE", position: 40 });
    const { id } = await createPart(ctxFor(p.swMember), {
      name: "  Camera mount  ",
      process: "PRINT_3D",
      quantity: " 3 ",
      material: " PETG ",
      fileUrl: " https://CAD.example.com/camera mount.stl ",
      notes: "  Two spares please.  ",
      categoryId: cat.vision,
      neededBy: addDays(TEST_TODAY, 5),
    });
    expect(await row(id)).toMatchObject({
      name: "Camera mount",
      process: "PRINT_3D",
      quantity: 3,
      material: "PETG",
      fileUrl: "https://cad.example.com/camera%20mount.stl",
      notes: "Two spares please.",
      categoryId: cat.vision,
      neededBy: dateOnlyToDb(addDays(TEST_TODAY, 5)),
      status: "NEEDED",
      position: 5, // after the last part that isn't done (finished parts don't count)
      requestedById: p.swMember.id,
      claimedById: null,
      claimedAt: null,
      doneAt: null,
    });
    const second = await createPart(ctxFor(p.buildLead), { name: "Spacer", process: "MACHINE" });
    expect(await row(second.id)).toMatchObject({
      position: 6,
      quantity: 1,
      material: "",
      fileUrl: "",
      notes: "",
      categoryId: null,
      neededBy: null,
    });
    expect(ctxFor(p.swMember).notifier.events).toEqual([]);
  });

  it("starts an empty queue at position 0 and gives parallel adds distinct places", async () => {
    const ids = await Promise.all(
      [p.asker, p.maker, p.buildMember, p.swMember].map((a, i) => createPart(ctxFor(a), { name: `Parallel ${i}`, process: "CNC" })),
    );
    const positions = (await Promise.all(ids.map(({ id }) => row(id)))).map((r) => r.position).sort();
    expect(positions).toEqual([0, 1, 2, 3]);
  });

  it("accepts every subteam's categories and whole-team ones", async () => {
    for (const categoryId of [cat.intake, cat.vision, cat.events]) {
      const { id } = await createPart(ctxFor(p.asker), { name: "Bracket", process: "OTHER", categoryId });
      expect((await row(id)).categoryId).toBe(categoryId);
    }
  });

  it.each([
    [{ name: "" }, "name", "Part name is required."],
    [{ name: "x".repeat(121) }, "name", "Part name must be at most 120 characters."],
    [{ process: "WELD" }, "process", "Pick how it's made."],
    [{ process: "" }, "process", "Pick how it's made."],
    [{ quantity: "0" }, "quantity", "Enter a quantity from 1 to 500."],
    [{ quantity: "501" }, "quantity", "Enter a quantity from 1 to 500."],
    [{ quantity: "2.5" }, "quantity", "Enter a quantity from 1 to 500."],
    [{ quantity: "-1" }, "quantity", "Enter a quantity from 1 to 500."],
    [{ quantity: "lots" }, "quantity", "Enter a quantity from 1 to 500."],
    [{ material: "m".repeat(81) }, "material", "Material must be at most 80 characters."],
    [{ fileUrl: "javascript:alert(1)" }, "fileUrl", LINK_MESSAGE],
    [{ fileUrl: "ftp://files.example.com/a.stl" }, "fileUrl", LINK_MESSAGE],
    [{ fileUrl: "intake plate v2" }, "fileUrl", LINK_MESSAGE],
    [{ fileUrl: "localhost:3000/part" }, "fileUrl", LINK_MESSAGE],
    [{ fileUrl: "https://user:pw@cad.example.com/" }, "fileUrl", LINK_MESSAGE],
    [{ notes: "n".repeat(2001) }, "notes", "Notes must be at most 2000 characters."],
    [{ categoryId: "no-such-category" }, "categoryId", "That category no longer exists. Pick another one."],
    [{ neededBy: "2026-02-30" }, "neededBy", "Pick a valid date."],
    [{ neededBy: addDays(TEST_TODAY, 366) }, "neededBy", "Pick a date within the next year."],
    [{ neededBy: addDays(TEST_TODAY, -31) }, "neededBy", "Pick a date no more than 30 days ago."],
  ])("rejects %o", async (override, field, message) => {
    const err = await errorOf(createPart(ctxFor(p.asker), { ...validFields, ...override }));
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.fieldErrors?.[field]).toBe(message);
    expect(await t.db.part.count()).toBe(0);
  });

  it.each([
    ["drive.google.com/file/d/abc123/view", "https://drive.google.com/file/d/abc123/view"],
    ["www.printables.com/model/42?lang=en", "https://www.printables.com/model/42?lang=en"],
    ["  cad.onshape.com/documents/9  ", "https://cad.onshape.com/documents/9"],
    ["HTTP://Example.com/a.stl", "http://example.com/a.stl"],
  ])("adds https:// to a bare link: %s", async (fileUrl, stored) => {
    const { id } = await createPart(ctxFor(p.asker), { ...validFields, fileUrl });
    expect((await row(id)).fileUrl).toBe(stored);
  });

  it("accepts needed-by dates right at the limits", async () => {
    for (const neededBy of [addDays(TEST_TODAY, 365), addDays(TEST_TODAY, -30), TEST_TODAY]) {
      await createPart(ctxFor(p.asker), { ...validFields, neededBy });
    }
    expect(await t.db.part.count()).toBe(3);
  });

  it("refuses pending and disabled accounts", async () => {
    for (const who of [p.pending, p.disabled]) {
      const err = await errorOf(createPart(ctxFor(who), validFields));
      expect(err).toBeInstanceOf(ForbiddenError);
    }
    expect(await t.db.part.count()).toBe(0);
  });

  it(`allows ${PART_RATE_LIMIT.limit} new parts per person per hour`, async () => {
    for (let i = 0; i < PART_RATE_LIMIT.limit; i++) await createPart(ctxFor(p.bizMember), { name: `Spam ${i}`, process: "CUT" });
    const err = await errorOf(createPart(ctxFor(p.bizMember), { name: "One too many", process: "CUT" }));
    expect(err).toBeInstanceOf(RateLimitError);
    // Someone else is unaffected.
    await createPart(ctxFor(p.bizLead), { name: "Fine", process: "CUT" });
    expect(await t.db.part.count()).toBe(PART_RATE_LIMIT.limit + 1);
  });
});

// ── update / delete ─────────────────────────────────────────────────────────

describe("updatePart and deletePart", () => {
  const edit = (who: Actor, partId: string, override: Record<string, unknown> = {}) =>
    updatePart(ctxFor(who), { partId, ...validFields, name: "Changed", ...override });

  it("lets whoever asked for it change it while it's up for grabs (queue place unchanged)", async () => {
    const part = await makePart({ name: "Mine", position: 3 });
    const res = await edit(p.asker, part.id, { categoryId: cat.intake, neededBy: addDays(TEST_TODAY, 2) });
    expect(res).toEqual({ id: part.id, status: "NEEDED" });
    expect(await row(part.id)).toMatchObject({
      name: "Changed",
      process: "LASER_CUT",
      quantity: 2,
      categoryId: cat.intake,
      position: 3,
      status: "NEEDED",
      requestedById: p.asker.id,
    });
    // Clearing optional fields.
    await edit(p.asker, part.id, { categoryId: "", neededBy: "", fileUrl: "", material: "", notes: "" });
    expect(await row(part.id)).toMatchObject({ categoryId: null, neededBy: null, fileUrl: "", material: "", notes: "" });
  });

  it("stops the asker once someone grabbed it or it's done, with a clear message", async () => {
    for (const status of ["CLAIMED", "DONE"] as const) {
      const part = await makePart({ status, claimedBy: p.maker });
      const err = await errorOf(edit(p.asker, part.id));
      expect(err).toBeInstanceOf(ForbiddenError);
      expect(err.userMessage).toBe("Only the person who asked for it (before someone grabs it) or a Build leader can change this.");
      expect(await errorOf(deletePart(ctxFor(p.asker), { partId: part.id }))).toBeInstanceOf(ForbiddenError);
      expect((await row(part.id)).name).not.toBe("Changed");
    }
  });

  it("stops other members and other subteams' leaders from changing someone else's part", async () => {
    const part = await makePart({ name: "Not yours" });
    for (const who of [p.maker, p.buildMember, p.swMember, p.swLead, p.bizLead]) {
      expect(await errorOf(edit(who, part.id)), who.name).toBeInstanceOf(ForbiddenError);
      expect(await errorOf(deletePart(ctxFor(who), { partId: part.id })), who.name).toBeInstanceOf(ForbiddenError);
    }
    expect(await row(part.id)).toMatchObject({ name: "Not yours" });
  });

  it("lets another subteam's leader change a part they asked for themselves", async () => {
    const part = await makePart({ requestedBy: p.swLead });
    await edit(p.swLead, part.id);
    expect((await row(part.id)).name).toBe("Changed");
    await deletePart(ctxFor(p.swLead), { partId: part.id });
    expect(await t.db.part.count()).toBe(0);
  });

  it("lets Build leaders and all-scope staff change or remove anyone's part, in any state", async () => {
    for (const who of [p.buildLead, p.buildLead2, p.captain, p.mentor, p.teacher, p.admin]) {
      for (const status of ["NEEDED", "CLAIMED", "DONE"] as const) {
        const part = await makePart({ status, claimedBy: status === "NEEDED" ? null : p.maker });
        const res = await edit(who, part.id, { name: `By ${who.name}` });
        expect(res.status).toBe(status);
        expect(await row(part.id), `${who.name} ${status}`).toMatchObject({ name: `By ${who.name}`, status });
        await deletePart(ctxFor(who), { partId: part.id });
        expect(await t.db.part.findUnique({ where: { id: part.id } })).toBeNull();
      }
    }
  });

  it("refuses pending and disabled accounts, even for their own parts", async () => {
    for (const who of [p.pending, p.disabled]) {
      const part = await makePart({ requestedBy: who });
      expect(await errorOf(edit(who, part.id))).toBeInstanceOf(ForbiddenError);
      expect(await errorOf(deletePart(ctxFor(who), { partId: part.id }))).toBeInstanceOf(ForbiddenError);
    }
  });

  it("reports missing parts as not found", async () => {
    expect(await errorOf(edit(p.buildLead, "missing-part"))).toBeInstanceOf(NotFoundError);
    expect(await errorOf(deletePart(ctxFor(p.buildLead), { partId: "missing-part" }))).toBeInstanceOf(NotFoundError);
  });

  it("validates edits and changes nothing on errors", async () => {
    const part = await makePart({ name: "Keep me" });
    const err = await errorOf(edit(p.asker, part.id, { fileUrl: "javascript:alert(1)", quantity: "0" }));
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.fieldErrors).toMatchObject({ fileUrl: LINK_MESSAGE, quantity: "Enter a quantity from 1 to 500." });
    expect((await row(part.id)).name).toBe("Keep me");
  });

  it("keeps an old needed-by date, but a new date must be in range", async () => {
    const old = addDays(TEST_TODAY, -60);
    const part = await makePart({ neededBy: old });
    await edit(p.asker, part.id, { neededBy: old });
    expect((await row(part.id)).neededBy).toEqual(dateOnlyToDb(old));
    const err = await errorOf(edit(p.asker, part.id, { neededBy: addDays(TEST_TODAY, -59) }));
    expect(err.fieldErrors?.neededBy).toBe("Pick a date no more than 30 days ago.");
  });
});

// ── claim / drop / done / reopen ────────────────────────────────────────────

describe("claimPart", () => {
  it("lets anyone active grab a part that's up for grabs; its place in the queue stays", async () => {
    const part = await makePart({ position: 2 });
    await claimPart(ctxFor(p.bizMember), { partId: part.id });
    expect(await row(part.id)).toMatchObject({ status: "CLAIMED", claimedById: p.bizMember.id, claimedAt: TEST_NOW, position: 2 });
  });

  it("gives exactly one of three people grabbing it at once the part", async () => {
    const part = await makePart();
    const people = [p.maker, p.buildMember, p.swMember];
    const results = await Promise.allSettled(people.map((a) => claimPart(ctxFor(a), { partId: part.id })));
    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(2);
    const winner = people[results.findIndex((r) => r.status === "fulfilled")];
    // The others are told who got it.
    for (const r of lost) {
      expect(r.reason).toBeInstanceOf(ConflictError);
      expect(r.reason.userMessage).toBe(`${winner.name} just grabbed this one.`);
    }
    expect(await row(part.id)).toMatchObject({ status: "CLAIMED", claimedById: winner.id });
  });

  it("explains why a part can't be grabbed", async () => {
    const mine = await makePart({ status: "CLAIMED", claimedBy: p.maker });
    expect((await errorOf(claimPart(ctxFor(p.maker), { partId: mine.id }))).userMessage).toBe("You're already making this one.");
    expect((await errorOf(claimPart(ctxFor(p.buildMember), { partId: mine.id }))).userMessage).toBe("Isabella Maker just grabbed this one.");
    expect(partGrabbedMessage(null)).toBe("Someone just grabbed this one.");
    const done = await makePart({ status: "DONE" });
    const err = await errorOf(claimPart(ctxFor(p.buildMember), { partId: done.id }));
    expect(err).toBeInstanceOf(ConflictError);
    expect(err.userMessage).toBe("This part is already done.");
    expect(await errorOf(claimPart(ctxFor(p.buildMember), { partId: "missing" }))).toBeInstanceOf(NotFoundError);
  });

  it("refuses pending and disabled accounts", async () => {
    const part = await makePart();
    for (const who of [p.pending, p.disabled]) {
      expect(await errorOf(claimPart(ctxFor(who), { partId: part.id }))).toBeInstanceOf(ForbiddenError);
    }
    expect((await row(part.id)).status).toBe("NEEDED");
  });
});

describe("unclaimPart", () => {
  it("lets the person making it drop it: up for grabs again, same place", async () => {
    const part = await makePart({ status: "CLAIMED", claimedBy: p.maker, position: 7 });
    await unclaimPart(ctxFor(p.maker), { partId: part.id });
    expect(await row(part.id)).toMatchObject({ status: "NEEDED", claimedById: null, claimedAt: null, position: 7 });
  });

  it("lets managers drop anyone's claim", async () => {
    for (const who of [p.buildLead, p.captain, p.mentor, p.teacher, p.admin]) {
      const part = await makePart({ status: "CLAIMED", claimedBy: p.maker });
      await unclaimPart(ctxFor(who), { partId: part.id });
      expect((await row(part.id)).status, who.name).toBe("NEEDED");
    }
  });

  it("stops everyone else (including whoever asked for it)", async () => {
    const part = await makePart({ status: "CLAIMED", claimedBy: p.maker });
    for (const who of [p.asker, p.buildMember, p.swLead, p.bizLead, p.pending, p.disabled]) {
      expect(await errorOf(unclaimPart(ctxFor(who), { partId: part.id })), who.name).toBeInstanceOf(ForbiddenError);
    }
    expect((await row(part.id)).claimedById).toBe(p.maker.id);
  });

  it("explains when there's nothing to drop", async () => {
    const needed = await makePart();
    expect((await errorOf(unclaimPart(ctxFor(p.buildLead), { partId: needed.id }))).userMessage).toBe("Nobody is making this one right now.");
    const done = await makePart({ status: "DONE", claimedBy: p.maker });
    const err = await errorOf(unclaimPart(ctxFor(p.maker), { partId: done.id }));
    expect(err).toBeInstanceOf(ConflictError);
    expect(err.userMessage).toBe("This part is already done.");
    expect(await errorOf(unclaimPart(ctxFor(p.buildLead), { partId: "missing" }))).toBeInstanceOf(NotFoundError);
  });
});

describe("finishPart", () => {
  it("lets the person making it mark it done", async () => {
    const part = await makePart({ status: "CLAIMED", claimedBy: p.maker, position: 1 });
    await finishPart(ctxFor(p.maker), { partId: part.id });
    expect(await row(part.id)).toMatchObject({ status: "DONE", doneAt: TEST_NOW, claimedById: p.maker.id });
  });

  it("lets managers finish someone's claimed part (the maker stays) or a part nobody grabbed", async () => {
    for (const who of [p.buildLead, p.captain, p.mentor, p.teacher, p.admin]) {
      const claimed = await makePart({ status: "CLAIMED", claimedBy: p.maker });
      await finishPart(ctxFor(who), { partId: claimed.id });
      expect(await row(claimed.id)).toMatchObject({ status: "DONE", claimedById: p.maker.id });
      const needed = await makePart();
      await finishPart(ctxFor(who), { partId: needed.id });
      expect(await row(needed.id)).toMatchObject({ status: "DONE", claimedById: null, doneAt: TEST_NOW });
    }
  });

  it("stops members from finishing parts they aren't making", async () => {
    const needed = await makePart();
    const err = await errorOf(finishPart(ctxFor(p.asker), { partId: needed.id }));
    expect(err).toBeInstanceOf(ForbiddenError);
    expect(err.userMessage).toMatch(/I'll make it/);
    const claimed = await makePart({ status: "CLAIMED", claimedBy: p.maker });
    for (const who of [p.asker, p.buildMember, p.swLead, p.bizLead, p.disabled]) {
      expect(await errorOf(finishPart(ctxFor(who), { partId: claimed.id })), who.name).toBeInstanceOf(ForbiddenError);
    }
    expect((await row(claimed.id)).status).toBe("CLAIMED");
  });

  it("says when it's already done, or gone", async () => {
    const done = await makePart({ status: "DONE", claimedBy: p.maker });
    const err = await errorOf(finishPart(ctxFor(p.maker), { partId: done.id }));
    expect(err).toBeInstanceOf(ConflictError);
    expect(err.userMessage).toBe("This part is already done.");
    expect(await errorOf(finishPart(ctxFor(p.buildLead), { partId: "missing" }))).toBeInstanceOf(NotFoundError);
  });
});

describe("reopenPart", () => {
  it("lets managers put a finished part back, up for grabs at the end of the queue", async () => {
    await makePart({ name: "A", position: 0 });
    await makePart({ name: "B", position: 3 });
    const done = await makePart({ name: "Finished", status: "DONE", claimedBy: p.maker, position: 0 });
    await reopenPart(ctxFor(p.buildLead2), { partId: done.id });
    expect(await row(done.id)).toMatchObject({ status: "NEEDED", position: 4, claimedById: null, claimedAt: null, doneAt: null });
    expect((await queueNames()).map((r) => r.name)).toEqual(["A", "B", "Finished"]);
  });

  it("is for managers only", async () => {
    const done = await makePart({ status: "DONE", claimedBy: p.maker });
    for (const who of [p.maker, p.asker, p.swLead, p.bizLead, p.pending]) {
      expect(await errorOf(reopenPart(ctxFor(who), { partId: done.id })), who.name).toBeInstanceOf(ForbiddenError);
    }
    for (const who of [p.captain, p.mentor, p.teacher, p.admin]) {
      await t.db.part.update({ where: { id: done.id }, data: { status: "DONE", doneAt: TEST_NOW } });
      await reopenPart(ctxFor(who), { partId: done.id });
      expect((await row(done.id)).status, who.name).toBe("NEEDED");
    }
  });

  it("says when the part is already in the queue, or gone", async () => {
    const needed = await makePart();
    const err = await errorOf(reopenPart(ctxFor(p.buildLead), { partId: needed.id }));
    expect(err).toBeInstanceOf(ConflictError);
    expect(err.userMessage).toBe("This part is already in the queue.");
    expect(await errorOf(reopenPart(ctxFor(p.buildLead), { partId: "missing" }))).toBeInstanceOf(NotFoundError);
  });
});

// ── move ────────────────────────────────────────────────────────────────────

describe("movePart", () => {
  /** A, B, C, D in the queue (with gaps in the positions) plus a finished part in between. */
  async function queueOfFour() {
    const a = await makePart({ name: "A", position: 0 });
    const b = await makePart({ name: "B", position: 5, status: "CLAIMED", claimedBy: p.maker });
    await makePart({ name: "Done", position: 6, status: "DONE" });
    const c = await makePart({ name: "C", position: 7 });
    const d = await makePart({ name: "D", position: 20 });
    return { a, b, c, d };
  }
  const move = (who: Actor, partId: string, direction: string) => movePart(ctxFor(who), { partId, direction });

  it("moves a part up, down, and to the top, renumbering the queue 0..n-1", async () => {
    const { a, b, c, d } = await queueOfFour();
    await move(p.buildLead, c.id, "up");
    expect(await queueNames()).toEqual([
      { name: "A", position: 0 },
      { name: "C", position: 1 },
      { name: "B", position: 2 },
      { name: "D", position: 3 },
    ]);
    await move(p.captain, a.id, "down");
    expect((await queueNames()).map((r) => r.name)).toEqual(["C", "A", "B", "D"]);
    await move(p.mentor, d.id, "top");
    expect(await queueNames()).toEqual([
      { name: "D", position: 0 },
      { name: "C", position: 1 },
      { name: "A", position: 2 },
      { name: "B", position: 3 },
    ]);
    // A claimed part moves like any other.
    await move(p.admin, b.id, "top");
    expect((await queueNames()).map((r) => r.name)).toEqual(["B", "D", "C", "A"]);
    expect((await row(b.id)).status).toBe("CLAIMED");
  });

  it("does nothing at the edges", async () => {
    const { a, d } = await queueOfFour();
    const before = await queueNames();
    await move(p.buildLead, a.id, "up");
    await move(p.buildLead, a.id, "top");
    await move(p.buildLead, d.id, "down");
    expect(await queueNames()).toEqual(before);
  });

  it("is for Build leaders and all-scope staff only", async () => {
    const { c } = await queueOfFour();
    for (const who of [p.asker, p.maker, p.buildMember, p.swLead, p.bizLead, p.swMember, p.pending, p.disabled]) {
      expect(await errorOf(move(who, c.id, "top")), who.name).toBeInstanceOf(ForbiddenError);
    }
    expect((await queueNames()).map((r) => r.name)).toEqual(["A", "B", "C", "D"]);
    for (const who of [p.buildLead, p.buildLead2, p.captain, p.mentor, p.teacher, p.admin]) {
      await move(who, c.id, "down");
      await move(who, c.id, "up");
    }
    expect((await queueNames()).map((r) => r.name)).toEqual(["A", "B", "C", "D"]);
  });

  it("rejects finished or missing parts and unknown directions", async () => {
    const done = await makePart({ status: "DONE" });
    const err = await errorOf(move(p.buildLead, done.id, "up"));
    expect(err).toBeInstanceOf(ConflictError);
    expect(err.userMessage).toBe("This part is already done.");
    expect(await errorOf(move(p.buildLead, "missing", "up"))).toBeInstanceOf(NotFoundError);
    expect(await errorOf(move(p.buildLead, done.id, "sideways"))).toBeInstanceOf(ValidationError);
  });
});

// ── queries ─────────────────────────────────────────────────────────────────

describe("getPartsQueue", () => {
  const load = (actor: Actor, f: { view?: "queue" | "done"; process?: PartProcess; who?: PartsWho } = {}) =>
    getPartsQueue(actor, { view: f.view ?? "queue", process: f.process, who: f.who, today: TEST_TODAY, now: TEST_NOW }, t.db);

  async function seedQueue() {
    const printA = await makePart({ name: "Print A", process: "PRINT_3D", position: 0, neededBy: addDays(TEST_TODAY, -1) });
    const cnc = await makePart({ name: "CNC plate", process: "CNC", position: 1, status: "CLAIMED", claimedBy: p.maker, requestedBy: p.buildLead });
    const printB = await makePart({ name: "Print B", process: "PRINT_3D", position: 2, requestedBy: p.swMember, fileUrl: "javascript:alert(1)" });
    const cut = await makePart({ name: "Cut rail", process: "CUT", position: 3, requestedBy: p.maker, neededBy: TEST_TODAY });
    const done1 = await makePart({ name: "Done yesterday", status: "DONE", claimedBy: p.maker, doneAt: new Date(TEST_NOW.getTime() - 86_400_000) });
    const done2 = await makePart({ name: "Done today", status: "DONE", claimedBy: null, doneAt: TEST_NOW });
    const old = await makePart({ name: "Done long ago", status: "DONE", doneAt: new Date(TEST_NOW.getTime() - 8 * 86_400_000) });
    return { printA, cnc, printB, cut, done1, done2, old };
  }

  it("lists the queue in order with ranks, counts, and the right buttons for a member", async () => {
    const s = await seedQueue();
    const q = await load(p.buildMember);
    expect(q.items.map((i) => [i.rank, i.name, i.status])).toEqual([
      [1, "Print A", "NEEDED"],
      [2, "CNC plate", "CLAIMED"],
      [3, "Print B", "NEEDED"],
      [4, "Cut rail", "NEEDED"],
    ]);
    expect(q.queueLength).toBe(4);
    expect(q.counts).toEqual({ upForGrabs: 3, beingMade: 1, doneThisWeek: 2, doneTotal: 3 });
    expect(q.canManage).toBe(false);
    const [printA, cnc, printB] = q.items;
    expect(printA).toMatchObject({
      canClaim: true,
      canUnclaim: false,
      canFinish: false,
      canEdit: false,
      canMove: false,
      canReopen: false,
      isMine: false,
      late: true,
      neededBy: addDays(TEST_TODAY, -1),
      requestedBy: { id: p.asker.id, name: p.asker.name },
      claimedBy: null,
    });
    expect(cnc).toMatchObject({ canClaim: false, canUnclaim: false, canFinish: false, claimedBy: { id: p.maker.id, name: p.maker.name } });
    expect(cnc.claimedAt).toBe(TEST_NOW.toISOString());
    // A bad link stored somehow is never handed to the page.
    expect(printB.fileUrl).toBe("");
    expect(q.items.find((i) => i.id === s.cut.id)?.late).toBe(false);
  });

  it("gives the asker, the maker, and managers their buttons", async () => {
    const s = await seedQueue();
    const byId = async (who: Actor) => new Map((await load(who)).items.map((i) => [i.id, i]));
    const asker = await byId(p.asker);
    expect(asker.get(s.printA.id)).toMatchObject({ canEdit: true, isMine: true, isRequester: true, isMaker: false });
    const maker = await byId(p.maker);
    expect(maker.get(s.cnc.id)).toMatchObject({ canUnclaim: true, canFinish: true, canEdit: false, isMine: true, isMaker: true });
    for (const who of [p.buildLead2, p.captain, p.admin]) {
      const m = await byId(who);
      expect(m.get(s.printA.id), who.name).toMatchObject({ canClaim: true, canFinish: true, canEdit: true, canMove: true, canUnclaim: false });
      expect(m.get(s.cnc.id), who.name).toMatchObject({ canClaim: false, canFinish: true, canUnclaim: true, canEdit: true, canMove: true });
    }
    // Another subteam's leader is like any member here.
    const sw = await byId(p.swLead);
    expect(sw.get(s.printA.id)).toMatchObject({ canEdit: false, canMove: false, canFinish: false, canClaim: true });
  });

  it("keeps ranks from the whole queue when filtering by process, or to what I'm making or asked for", async () => {
    await seedQueue();
    const prints = await load(p.buildMember, { process: "PRINT_3D" });
    expect(prints.items.map((i) => [i.rank, i.name])).toEqual([
      [1, "Print A"],
      [3, "Print B"],
    ]);
    // The maker grabbed the CNC plate and asked for the cut rail: each filter shows just one of them.
    const making = await load(p.maker, { who: "making" });
    expect(making.items.map((i) => [i.rank, i.name])).toEqual([[2, "CNC plate"]]);
    const asked = await load(p.maker, { who: "asked" });
    expect(asked.items.map((i) => [i.rank, i.name])).toEqual([[4, "Cut rail"]]);
    expect((await load(p.maker, { who: "making", process: "CNC" })).items.map((i) => i.name)).toEqual(["CNC plate"]);
    expect((await load(p.maker, { who: "making", process: "CUT" })).items).toEqual([]);
    expect((await load(p.bizMember, { who: "making" })).items).toEqual([]);
    expect((await load(p.bizMember, { who: "asked" })).items).toEqual([]);
    expect((await load(p.asker, { who: "asked" })).items.map((i) => i.name)).toEqual(["Print A"]);
    // The whole queue is still what ranks count against.
    expect(making.queueLength).toBe(4);
  });

  it("counts only the parts that match the filters", async () => {
    await seedQueue();
    expect((await load(p.buildMember, { process: "PRINT_3D" })).counts).toEqual({ upForGrabs: 2, beingMade: 0, doneThisWeek: 2, doneTotal: 3 });
    expect((await load(p.buildMember, { process: "CNC" })).counts).toEqual({ upForGrabs: 0, beingMade: 1, doneThisWeek: 0, doneTotal: 0 });
    expect((await load(p.maker, { who: "making" })).counts).toEqual({ upForGrabs: 0, beingMade: 1, doneThisWeek: 1, doneTotal: 1 });
    expect((await load(p.maker, { who: "asked" })).counts).toEqual({ upForGrabs: 1, beingMade: 0, doneThisWeek: 0, doneTotal: 0 });
    // Same counts on the Done tab.
    expect((await load(p.asker, { who: "asked", view: "done" })).counts).toEqual({ upForGrabs: 1, beingMade: 0, doneThisWeek: 2, doneTotal: 3 });
    expect((await load(p.bizMember, { who: "making" })).counts).toEqual({ upForGrabs: 0, beingMade: 0, doneThisWeek: 0, doneTotal: 0 });
  });

  it("lists finished parts, newest first, with who made them and manager buttons", async () => {
    const s = await seedQueue();
    const done = await load(p.buildMember, { view: "done" });
    expect(done.items.map((i) => [i.name, i.rank])).toEqual([
      ["Done today", null],
      ["Done yesterday", null],
      ["Done long ago", null],
    ]);
    expect(done.items[1]).toMatchObject({ claimedBy: { id: p.maker.id }, canReopen: false, canEdit: false, canClaim: false, late: false });
    const lead = await load(p.buildLead, { view: "done" });
    expect(lead.items.every((i) => i.canReopen && i.canEdit && !i.canMove && !i.canFinish)).toBe(true);
    const madeByMe = await load(p.maker, { view: "done", who: "making" });
    expect(madeByMe.items.map((i) => i.id)).toEqual([s.done1.id]);
    expect((await load(p.maker, { view: "done", who: "asked" })).items).toEqual([]);
  });

  it("shows at most the 50 most recently finished parts", async () => {
    await t.db.part.createMany({
      data: Array.from({ length: 55 }, (_, i) => ({
        name: `Old ${i}`,
        status: "DONE" as const,
        doneAt: new Date(TEST_NOW.getTime() - i * 60_000),
      })),
    });
    const done = await load(p.buildMember, { view: "done" });
    expect(done.items).toHaveLength(50);
    expect(done.truncated).toBe(true);
    expect(done.items[0].name).toBe("Old 0");
    expect(done.counts.doneTotal).toBe(55);
  });
});

describe("getPartForEdit, category groups, and parts I'm making", () => {
  it("returns form values only to people who may change the part", async () => {
    const part = await makePart({ name: "Plate", neededBy: TEST_TODAY });
    await t.db.part.update({ where: { id: part.id }, data: { categoryId: cat.intake, quantity: 3 } });
    expect(await getPartForEdit(p.asker, part.id, t.db)).toMatchObject({
      id: part.id,
      name: "Plate",
      quantity: 3,
      categoryId: cat.intake,
      neededBy: TEST_TODAY,
      byManager: false,
    });
    expect(await getPartForEdit(p.buildMember, part.id, t.db)).toBeNull();
    expect(await getPartForEdit(p.swLead, part.id, t.db)).toBeNull();
    expect((await getPartForEdit(p.buildLead, part.id, t.db))?.byManager).toBe(true);
    expect(await getPartForEdit(p.buildLead, "missing", t.db)).toBeNull();
    await t.db.part.update({ where: { id: part.id }, data: { status: "CLAIMED", claimedById: p.maker.id } });
    expect(await getPartForEdit(p.asker, part.id, t.db)).toBeNull();
  });

  it("lists Build's categories first, then other subteams', then whole-team ones", async () => {
    const groups = await getPartCategoryGroups(t.db);
    expect(groups.map((g) => g.label)).toEqual(["Build", "Software", "Whole team"]);
    expect(groups[0].options).toEqual([{ id: cat.intake, name: "Intake" }]);
  });

  it("counts the parts someone is making right now", async () => {
    await makePart({ status: "CLAIMED", claimedBy: p.maker });
    await makePart({ status: "CLAIMED", claimedBy: p.maker });
    await makePart({ status: "DONE", claimedBy: p.maker });
    await makePart({ status: "CLAIMED", claimedBy: p.buildMember });
    expect(await countPartsImMaking(p.maker, t.db)).toBe(2);
    expect(await countPartsImMaking(p.asker, t.db)).toBe(0);
  });
});
