import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { LIMITS } from "@/lib/constants";
import {
  isPedroPathFile,
  isPedroPathProject,
  pedroPathProblem,
  strategyFileProblem,
  strategyRemoveQuestion,
  strategySaveTooBigMessage,
  tooManyStrategyFilesMessage,
} from "@/lib/strategy";
import type { Actor } from "@/server/actor";
import { ForbiddenError, NotFoundError, RateLimitError, ValidationError } from "@/server/errors";
import { fileStorageUsage, storageFullSentence, usedFileStorageBytes } from "@/server/files/storage";
import { canEditStrategy } from "@/server/permissions";
import {
  getStrategyDetail,
  getStrategyFile,
  getStrategyForEdit,
  listStrategies,
  strategyFileHeaders,
  strategyFileHref,
} from "@/server/queries/strategy";
import { FILE_CSP, PDF_CSP } from "@/server/resources/serve";
import {
  createStrategy,
  deleteStrategy,
  PEDRO_PATH_CONTENT_TYPE,
  setStrategyPinned,
  STRATEGY_CANT_EDIT,
  STRATEGY_CANT_PIN,
  STRATEGY_FILE_BYTES_PER_PERSON,
  STRATEGY_INACTIVE,
  STRATEGY_NOT_FOUND,
  STRATEGY_RATE_LIMIT,
  updateStrategy,
} from "@/server/services/strategy";
import { createTestDb, type TestDb } from "./helpers/db";
import { contextFor, makeUser, TEST_NOW } from "./helpers/factories";

let t: TestDb;
let maya: Actor; // Software member
let ethan: Actor; // Build member
let ava: Actor; // Business member
let priya: Actor; // Software leader
let marcus: Actor; // Build leader
let amara: Actor; // Business leader
let jordan: Actor; // Captain
let elena: Actor; // Mentor
let david: Actor; // Teacher
let olivia: Actor; // Owner (a Build member with the Owner flag)
let pending: Actor;
let disabled: Actor;
let rejected: Actor;
let pendingLeader: Actor;

beforeAll(async () => {
  t = await createTestDb();
  maya = await makeUser(t.db, { name: "Maya Patel", role: "MEMBER", subteam: "SOFTWARE" });
  ethan = await makeUser(t.db, { name: "Ethan Chen", role: "MEMBER", subteam: "BUILD" });
  ava = await makeUser(t.db, { name: "Ava Thompson", role: "MEMBER", subteam: "BUSINESS" });
  priya = await makeUser(t.db, { name: "Priya Raman", role: "SOFTWARE_LEADER" });
  marcus = await makeUser(t.db, { name: "Marcus Johnson", role: "BUILD_LEADER" });
  amara = await makeUser(t.db, { name: "Amara Okafor", role: "BUSINESS_LEADER" });
  jordan = await makeUser(t.db, { name: "Jordan Lee", role: "CAPTAIN" });
  elena = await makeUser(t.db, { name: "Elena Petrova", role: "MENTOR" });
  david = await makeUser(t.db, { name: "David Kim", role: "TEACHER" });
  olivia = await makeUser(t.db, { name: "Olivia Stone", role: "MEMBER", subteam: "BUILD", isAdmin: true });
  pending = await makeUser(t.db, { name: "Pat Pending", role: "MEMBER", subteam: "BUILD", status: "PENDING" });
  disabled = await makeUser(t.db, { name: "Dana Gone", role: "MEMBER", subteam: "BUILD", status: "DISABLED" });
  rejected = await makeUser(t.db, { name: "Rex Rejected", role: "MEMBER", subteam: "SOFTWARE", status: "REJECTED" });
  pendingLeader = await makeUser(t.db, { name: "Quinn Waiting", role: "BUILD_LEADER", status: "PENDING" });
});
afterAll(async () => {
  await t.drop();
});
// Tests make lots of strategies with one fixed "now"; the hourly limit has its own test.
beforeEach(async () => {
  await t.db.rateLimit.deleteMany();
});

const ctx = (actor: Actor, now: Date = TEST_NOW) => ({ ...contextFor(t.db, actor), now });
const minutesLater = (m: number) => new Date(TEST_NOW.getTime() + m * 60 * 1000);

// ── Files ────────────────────────────────────────────────────────────────────

const enc = (s: string) => new TextEncoder().encode(s);
/** A real 1×1 PNG. */
const PNG = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"));
const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0));
const be32 = (n: number) => [(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
/** A PNG header claiming `width` × `height`. */
const pngOf = (width: number, height: number) =>
  Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, ...ascii("IHDR"), ...be32(width), ...be32(height), 8, 2, 0, 0, 0, 0, 0, 0, 0]);
const PDF = enc("%PDF-1.4\n% match plan\n");
/** A tiny path the planner can open (the shape its Save writes). */
const PATH = {
  startPoint: { x: 61.75, y: 8, heading: "linear", startDeg: 90, endDeg: 90 },
  lines: [
    { id: "line-a", name: "Path 1", endPoint: { x: 61.75, y: 30, heading: "linear", startDeg: 90, endDeg: 90 }, controlPoints: [], color: "#ffc516" },
  ],
  shapes: [],
  sequence: [{ kind: "path", lineId: "line-a" }],
  version: "1.2.1",
};
const PP = enc(JSON.stringify(PATH, null, 2));

/** A picked file, as the Server Action passes it to the service. */
function file(name = "red-auto.pp", bytes: Uint8Array | string = PP, type = "") {
  return { name, type, bytes: typeof bytes === "string" ? enc(bytes) : bytes };
}
/** `size` bytes of text (no checks beyond size apply to .txt). */
const textFile = (name: string, size: number) => file(name, new Uint8Array(size).fill(0x61), "text/plain");

function form(over: Record<string, unknown> = {}) {
  return { title: "Red audience-side auto", kind: "AUTO", description: "", link: "", ...over };
}

async function create(actor: Actor, over: Record<string, unknown> = {}, files: unknown[] = []) {
  return createStrategy(ctx(actor), { ...form(over), files });
}

async function errorOf(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => null,
    (e: unknown) => e,
  );
}

async function validationOf(p: Promise<unknown>): Promise<ValidationError> {
  const err = await errorOf(p);
  expect(err).toBeInstanceOf(ValidationError);
  return err as ValidationError;
}

async function filesErrorOf(p: Promise<unknown>): Promise<string | undefined> {
  return (await validationOf(p)).fieldErrors.files;
}

// ── Who can do what ────────────────────────────────────────────────────────────

describe("who can add, change, pin, and remove strategies", () => {
  it("everyone active can add one (every subteam and role); it's stored with who added it", async () => {
    for (const a of [maya, ethan, ava, priya, marcus, amara, jordan, elena, david, olivia]) {
      const { id } = await create(a, { title: `Auto from ${a.name}` }, [file(`${a.name}.pp`)]);
      const row = await t.db.strategy.findUniqueOrThrow({ where: { id }, include: { files: true } });
      expect(row).toMatchObject({ title: `Auto from ${a.name}`, kind: "AUTO", createdById: a.id, teamId: null, pinned: false, createdAt: TEST_NOW, updatedAt: TEST_NOW });
      expect(row.files).toHaveLength(1);
      expect(row.files[0]).toMatchObject({ filename: `${a.name}.pp`, contentType: PEDRO_PATH_CONTENT_TYPE, size: PP.byteLength });
    }
  });

  it("accounts that aren't active can't add, change, pin, or remove strategies, or see them", async () => {
    const { id } = await create(maya, {}, [file()]);
    const fileId = (await t.db.strategyFile.findFirstOrThrow({ where: { strategyId: id } })).id;
    for (const a of [pending, disabled, rejected, pendingLeader]) {
      const err = await errorOf(create(a));
      expect(err, a.name).toBeInstanceOf(ForbiddenError);
      expect((err as ForbiddenError).userMessage).toBe(STRATEGY_INACTIVE);
      await expect(updateStrategy(ctx(a), { strategyId: id, ...form({ title: "Hijacked" }) }), a.name).rejects.toBeInstanceOf(ForbiddenError);
      await expect(deleteStrategy(ctx(a), { strategyId: id }), a.name).rejects.toBeInstanceOf(ForbiddenError);
      await expect(setStrategyPinned(ctx(a), { strategyId: id, pinned: "on" }), a.name).rejects.toBeInstanceOf(ForbiddenError);
      expect(await listStrategies(a, { mine: false }, t.db), a.name).toBeNull();
      expect(await getStrategyDetail(a, id, t.db), a.name).toBeNull();
      expect(await getStrategyFile(a, fileId, t.db), a.name).toBeNull();
    }
    expect(await t.db.strategy.count({ where: { createdById: { in: [pending.id, disabled.id, rejected.id, pendingLeader.id] } } })).toBe(0);
    expect((await t.db.strategy.findUniqueOrThrow({ where: { id } })).title).toBe("Red audience-side auto");
  });

  it("canEditStrategy: whoever added it, plus everyone with admin access", () => {
    const mine = { createdById: maya.id };
    expect(canEditStrategy(maya, mine)).toBe(true);
    for (const a of [ethan, ava]) expect(canEditStrategy(a, mine), a.name).toBe(false);
    for (const a of [priya, marcus, amara, jordan, elena, david, olivia]) expect(canEditStrategy(a, mine), a.name).toBe(true);
    // Added by someone who has since left: only admin access.
    expect(canEditStrategy(maya, { createdById: null })).toBe(false);
    expect(canEditStrategy(priya, { createdById: null })).toBe(true);
  });

  it("other members can't change or remove it; its author and people with admin access can", async () => {
    const { id } = await create(maya, { title: "Maya's auto" });
    for (const a of [ethan, ava]) {
      const err = await errorOf(updateStrategy(ctx(a), { strategyId: id, ...form({ title: "Mine now" }) }));
      expect(err, a.name).toBeInstanceOf(ForbiddenError);
      expect((err as ForbiddenError).userMessage).toBe(STRATEGY_CANT_EDIT);
      await expect(deleteStrategy(ctx(a), { strategyId: id }), a.name).rejects.toBeInstanceOf(ForbiddenError);
      expect(await getStrategyForEdit(a, id, t.db), a.name).toBeNull();
      expect((await getStrategyDetail(a, id, t.db))?.canEdit, a.name).toBe(false);
    }
    await updateStrategy(ctx(maya, minutesLater(5)), { strategyId: id, ...form({ title: "Maya's auto v2", kind: "MATCH" }) });
    expect(await t.db.strategy.findUniqueOrThrow({ where: { id } })).toMatchObject({ title: "Maya's auto v2", kind: "MATCH", updatedAt: minutesLater(5) });
    for (const a of [priya, amara, jordan, elena, david, olivia]) {
      await updateStrategy(ctx(a), { strategyId: id, ...form({ title: `Fixed by ${a.name}` }) });
      expect((await getStrategyForEdit(a, id, t.db))?.title).toBe(`Fixed by ${a.name}`);
    }
    await deleteStrategy(ctx(marcus), { strategyId: id });
    expect(await t.db.strategy.findUnique({ where: { id } })).toBeNull();
    await expect(deleteStrategy(ctx(maya), { strategyId: id })).rejects.toBeInstanceOf(NotFoundError);
    const gone = await errorOf(updateStrategy(ctx(maya), { strategyId: id, ...form() }));
    expect(gone).toBeInstanceOf(NotFoundError);
    expect((gone as NotFoundError).userMessage).toBe(STRATEGY_NOT_FOUND);
  });

  it("pinning is for people with admin access; pinned ones come first; pinning doesn't change 'updated'", async () => {
    const who = await makeUser(t.db, { name: "Pin Tester", role: "MEMBER", subteam: "SOFTWARE" });
    const older = await createStrategy(ctx(who, minutesLater(-60)), form({ title: "Older plan" }));
    await createStrategy(ctx(who, minutesLater(-30)), form({ title: "Newer plan" }));
    const order = async () => (await listStrategies(who, { mine: true }, t.db))!.items.map((s) => s.title);
    expect(await order()).toEqual(["Newer plan", "Older plan"]);

    for (const a of [who, maya, ethan, ava]) {
      const err = await errorOf(setStrategyPinned(ctx(a), { strategyId: older.id, pinned: "on" }));
      expect(err, a.name).toBeInstanceOf(ForbiddenError);
      expect((err as ForbiddenError).userMessage).toBe(STRATEGY_CANT_PIN);
      expect((await getStrategyDetail(a, older.id, t.db))?.canPin).toBe(false);
    }
    for (const a of [priya, amara, jordan, elena, david, olivia]) {
      expect(await setStrategyPinned(ctx(a), { strategyId: older.id, pinned: "on" })).toEqual({ title: "Older plan", pinned: true });
      expect((await getStrategyDetail(a, older.id, t.db))?.canPin).toBe(true);
    }
    expect(await order()).toEqual(["Older plan", "Newer plan"]);
    const row = await t.db.strategy.findUniqueOrThrow({ where: { id: older.id } });
    expect(row).toMatchObject({ pinned: true, updatedAt: minutesLater(-60) });
    expect((await listStrategies(who, { mine: true }, t.db))!.items[0]).toMatchObject({ pinned: true, updatedAt: minutesLater(-60) });

    await setStrategyPinned(ctx(jordan), { strategyId: older.id }); // no "pinned" = unpin
    expect(await order()).toEqual(["Newer plan", "Older plan"]);
    await expect(setStrategyPinned(ctx(jordan), { strategyId: "missing", pinned: "on" })).rejects.toBeInstanceOf(NotFoundError);
  });
});

// ── Validation ────────────────────────────────────────────────────────────────

describe("what a strategy needs", () => {
  it("a title and a kind; description, link, and files are optional", async () => {
    const e = await validationOf(create(maya, { title: "  ", kind: "PARKING" }));
    expect(e.fieldErrors).toMatchObject({ title: "Title is required.", kind: "Pick what kind of strategy this is." });
    expect(e.userMessage).toBe("Please fix the highlighted fields.");
    expect((await validationOf(create(maya, { title: "x".repeat(LIMITS.strategyTitleMax + 1) }))).fieldErrors.title).toMatch(/at most 120/);
    expect((await validationOf(create(maya, { description: "x".repeat(LIMITS.strategyDescriptionMax + 1) }))).fieldErrors.description).toMatch(
      /at most 10000/,
    );
    const { id } = await create(maya, { title: "  Scouting notes  ", kind: "SCOUTING", description: "Watch 9040's auto." });
    expect(await t.db.strategy.findUniqueOrThrow({ where: { id } })).toMatchObject({ title: "Scouting notes", kind: "SCOUTING", description: "Watch 9040's auto.", link: "" });
  });

  it("a description typed up to the box's limit fits, although browsers send its line breaks as CRLF", async () => {
    // The textarea's maxlength counts a line break as one character; the form sends each as "\r\n".
    const lines = Array.from({ length: 10 }, (_, i) => `${i}`.padEnd(999, "x"));
    const typed = `${lines.join("\n")}!`;
    expect(typed).toHaveLength(LIMITS.strategyDescriptionMax);
    const sent = `${lines.join("\r\n")}!`;
    const { id } = await create(maya, { title: "Long notes", description: sent });
    // Stored with plain line breaks (old Mac "\r" ones too).
    expect((await t.db.strategy.findUniqueOrThrow({ where: { id } })).description).toBe(typed);
    const { id: mac } = await create(maya, { title: "Mac notes", description: "a\rb" });
    expect((await t.db.strategy.findUniqueOrThrow({ where: { id: mac } })).description).toBe("a\nb");
    await updateStrategy(ctx(maya), { strategyId: id, ...form({ title: "Long notes", description: `${sent}\r\n` }) });
    expect((await t.db.strategy.findUniqueOrThrow({ where: { id } })).description).toBe(typed);
    // One character more is still too long.
    expect((await validationOf(create(maya, { description: `${sent}x` }))).fieldErrors.description).toMatch(/at most 10000/);
  });

  it("links are http(s) only (https:// is added to a bare address)", async () => {
    for (const bad of ["javascript:alert(1)", "not a link", "ftp://example.com/x"]) {
      expect((await validationOf(create(maya, { link: bad }))).fieldErrors.link, bad).toBe("Enter a web link, like https://youtu.be/…");
    }
    const { id } = await create(maya, { link: "youtu.be/abc123" });
    expect((await t.db.strategy.findUniqueOrThrow({ where: { id } })).link).toBe("https://youtu.be/abc123");
    const detail = await getStrategyDetail(ethan, id, t.db);
    expect(detail).toMatchObject({ link: "https://youtu.be/abc123", linkHost: "youtu.be" });
    // A bad link in the database never reaches a page.
    const odd = await t.db.strategy.create({ data: { title: "Odd", link: "javascript:alert(1)", createdById: maya.id } });
    expect(await getStrategyDetail(maya, odd.id, t.db)).toMatchObject({ link: "", linkHost: "" });
  });

  it("every problem is reported at once (fields and files)", async () => {
    const e = await validationOf(create(maya, { title: "", link: "nope" }, [file("broken.pp", "{")]));
    expect(Object.keys(e.fieldErrors).sort()).toEqual(["files", "link", "title"]);
  });
});

describe("strategy files", () => {
  it("a .pp path must be JSON the planner can open; it's stored as JSON", async () => {
    expect(await filesErrorOf(create(maya, {}, [file("broken.pp", "{ not json")]))).toBe(
      "“broken.pp” isn't a path file the planner can open (it isn't valid JSON). Save it again from the planner and try again.",
    );
    expect(await filesErrorOf(create(maya, {}, [file("empty-project.pp", "{}")]))).toBe(
      "“empty-project.pp” isn't a path the planner can open: it needs a start point and at least one path. Save it again from the planner and try again.",
    );
    expect(await filesErrorOf(create(maya, {}, [file("no-lines.pp", JSON.stringify({ ...PATH, lines: [] }))]))).toMatch(/needs a start point/);
    expect(await filesErrorOf(create(maya, {}, [file("latin1.pp", Uint8Array.from([0x7b, 0xff, 0x7d]))]))).toMatch(/isn't valid JSON/);
    // A byte-order mark and quoted numbers are fine (the planner reads those too).
    const quoted = { ...PATH, startPoint: { ...PATH.startPoint, x: "61.75" } };
    const { id } = await create(maya, {}, [file("Hand Edited.PP", `﻿${JSON.stringify(quoted)}`, "text/plain")]);
    const [row] = await t.db.strategyFile.findMany({ where: { strategyId: id } });
    expect(row).toMatchObject({ filename: "Hand Edited.PP", contentType: "application/json" });
  });

  it("pictures must be real pictures a phone can draw; PDFs and other safe files are fine", async () => {
    expect(await filesErrorOf(create(maya, {}, [file("field.png", "<html>hi</html>", "image/png")]))).toBe(
      "“field.png” couldn't be opened as a picture. Save it again as a PNG or JPG and try again.",
    );
    expect(await filesErrorOf(create(maya, {}, [file("huge.png", pngOf(40_000, 40_000), "image/png")]))).toMatch(
      /^“huge\.png” is 40,000 × 40,000 pixels — too big to show on phones\./,
    );
    const { id } = await create(maya, {}, [
      file("field.png", PNG, "image/png"),
      file("plan.pdf", PDF, "application/pdf"),
      file("intake.step", "ISO-10303-21;", ""),
      file("notes.txt", "Park by the HIVE", "text/plain"),
    ]);
    const detail = (await getStrategyDetail(ethan, id, t.db))!;
    expect(detail.files.map((f) => [f.filename, f.kind, f.viewHref !== null])).toEqual([
      ["field.png", "image", true],
      ["plan.pdf", "pdf", true],
      ["intake.step", "file", false],
      ["notes.txt", "file", false],
    ]);
  });

  it("empty files, files over 4 MB, and programs are refused, by name", async () => {
    expect(await filesErrorOf(create(maya, {}, [file("blank.pp", new Uint8Array())]))).toBe("“blank.pp” is empty. Choose another file.");
    expect(await filesErrorOf(create(maya, {}, [textFile("big.txt", LIMITS.resourceFileMaxBytes + 1)]))).toBe(
      "“big.txt” is 4.0 MB. Files can be up to 4 MB each — save a smaller copy, or add a link to it instead.",
    );
    for (const ext of ["exe", "bat", "js", "jar", "lnk"]) {
      expect(await filesErrorOf(create(maya, {}, [file(`setup.${ext}`, "MZ")])), ext).toBe(
        `“setup.${ext}” can't be added: .${ext} files can run programs on a computer. Share it as a link instead.`,
      );
    }
    expect(await t.db.strategy.count({ where: { title: "Red audience-side auto", files: { some: { filename: { startsWith: "setup." } } } } })).toBe(0);
  });

  it(`a strategy has up to ${LIMITS.strategyFilesMax} files, counting the ones it keeps when editing`, async () => {
    const eleven = Array.from({ length: LIMITS.strategyFilesMax + 1 }, (_, i) => file(`path ${i}.pp`));
    expect(await filesErrorOf(create(maya, {}, eleven))).toBe(tooManyStrategyFilesMessage(0));
    const { id } = await create(maya, {}, eleven.slice(0, 8));
    const current = await t.db.strategyFile.findMany({ where: { strategyId: id }, orderBy: { filename: "asc" } });
    expect(current).toHaveLength(8);
    expect(await filesErrorOf(updateStrategy(ctx(maya), { strategyId: id, ...form(), files: eleven.slice(8, 11) }))).toBe(
      tooManyStrategyFilesMessage(8),
    );
    // Removing one makes room for three.
    await updateStrategy(ctx(maya), { strategyId: id, ...form(), removeFileIds: [current[0].id], files: eleven.slice(8, 11) });
    expect(await t.db.strategyFile.count({ where: { strategyId: id } })).toBe(LIMITS.strategyFilesMax);
    expect(await t.db.strategyFile.findUnique({ where: { id: current[0].id } })).toBeNull();
  });

  it("editing removes only this strategy's files, and keeps the rest", async () => {
    const a = await create(maya, { title: "A" }, [file("a1.pp"), file("a2.pdf", PDF)]);
    const b = await create(maya, { title: "B" }, [file("b1.pp")]);
    const [a1, a2] = await t.db.strategyFile.findMany({ where: { strategyId: a.id }, orderBy: { filename: "asc" } });
    const [b1] = await t.db.strategyFile.findMany({ where: { strategyId: b.id } });
    await updateStrategy(ctx(maya), { strategyId: a.id, ...form({ title: "A" }), removeFileIds: [a1.id, b1.id, "missing"] });
    expect((await t.db.strategyFile.findMany({ where: { strategyId: a.id } })).map((f) => f.id)).toEqual([a2.id]);
    expect(await t.db.strategyFile.findUnique({ where: { id: b1.id } })).not.toBeNull();
    // A bad new file leaves everything as it was.
    expect(await filesErrorOf(updateStrategy(ctx(maya), { strategyId: a.id, ...form({ title: "A changed" }), removeFileIds: [a2.id], files: [file("x.pp", "[")] }))).toMatch(
      /isn't valid JSON/,
    );
    expect(await t.db.strategy.findUniqueOrThrow({ where: { id: a.id }, include: { files: true } })).toMatchObject({ title: "A", files: [{ id: a2.id }] });
  });

  it("removing a strategy removes its files; a person leaving keeps their strategies", async () => {
    const leaver = await makeUser(t.db, { name: "Leaving Soon", role: "MEMBER", subteam: "BUILD" });
    const { id } = await create(leaver, { title: "Leaver's auto" }, [file(), file("plan.pdf", PDF)]);
    const other = await create(leaver, { title: "To remove" }, [file("gone.pp")]);
    await deleteStrategy(ctx(leaver), { strategyId: other.id });
    expect(await t.db.strategyFile.count({ where: { strategyId: other.id } })).toBe(0);

    await t.db.user.delete({ where: { id: leaver.id } });
    const kept = await t.db.strategy.findUniqueOrThrow({ where: { id }, include: { files: true } });
    expect(kept).toMatchObject({ createdById: null });
    expect(kept.files).toHaveLength(2);
    expect((await getStrategyDetail(maya, id, t.db))?.createdByName).toBeNull();
  });
});

// ── Storage ────────────────────────────────────────────────────────────────────

describe("storage", () => {
  /** Makes it look like `who` already has `bytes` of strategy files (only the size column counts). */
  async function alreadyUploaded(who: Actor, bytes: number) {
    return t.db.strategy.create({
      data: {
        title: "Old strategy",
        createdById: who.id,
        files: { create: { filename: "old.bin", contentType: "application/octet-stream", size: bytes, data: new Uint8Array([1]) } },
      },
    });
  }

  it(`a member's strategy files stay under ${STRATEGY_FILE_BYTES_PER_PERSON / 1024 / 1024} MB; removing frees it up`, async () => {
    const member = await makeUser(t.db, { name: "Busy Planner", role: "MEMBER", subteam: "SOFTWARE" });
    const old = await alreadyUploaded(member, STRATEGY_FILE_BYTES_PER_PERSON - 300);
    expect(await filesErrorOf(create(member, {}, [textFile("new.txt", 301)]))).toBe(
      "Your strategy files use 50 MB, and each person can have up to 50 MB. Remove files you don't need, add a link instead, or ask a leader to add this one.",
    );
    const { id } = await create(member, {}, [textFile("new.txt", 300)]); // exactly at the limit is fine
    await create(member, { title: "No files" }); // strategies without files don't count
    expect(await filesErrorOf(updateStrategy(ctx(member), { strategyId: id, ...form(), files: [textFile("more.txt", 10)] }))).toMatch(
      /^Your strategy files use 50 MB/,
    );
    // Removing a file in the same save frees its space.
    const [current] = await t.db.strategyFile.findMany({ where: { strategyId: id } });
    await updateStrategy(ctx(member), { strategyId: id, ...form(), removeFileIds: [current.id], files: [textFile("swap.txt", 300)] });
    await t.db.strategy.delete({ where: { id: old.id } });
    await create(member, {}, [textFile("fits now.txt", 1000)]);
  });

  it("people with admin access aren't limited per person", async () => {
    for (const a of [priya, jordan, olivia]) {
      const old = await alreadyUploaded(a, STRATEGY_FILE_BYTES_PER_PERSON);
      await create(a, {}, [textFile(`from ${a.name}.txt`, 100)]);
      await t.db.strategy.delete({ where: { id: old.id } });
    }
  });

  it("strategy files count toward the team's storage cap, with everyone else's", async () => {
    const member = await makeUser(t.db, { name: "Storage Planner", role: "MEMBER", subteam: "BUILD" });
    const holder = await t.db.resource.create({
      data: { title: "Big old CAD export", file: { create: { filename: "big.step", contentType: "application/octet-stream", size: 0, data: new Uint8Array([1]) } } },
    });
    const used = await t.db.$transaction((tx) => usedFileStorageBytes(tx));
    await t.db.resourceFile.update({ where: { resourceId: holder.id }, data: { size: LIMITS.resourceStorageMaxBytes - used - 300 } });
    const almostFull = await t.db.$transaction((tx) => fileStorageUsage(tx));
    expect(almostFull.strategy).toBeGreaterThan(0);
    expect(await filesErrorOf(create(member, {}, [textFile("full.txt", 301)]))).toBe(
      `${storageFullSentence(almostFull)} Remove strategy files you don't need, or add a link instead. Leaders, the captain, mentors, and teachers can clear out old files.`,
    );
    expect(storageFullSentence(almostFull)).toMatch(/ of strategy files\.$/);
    // Admin access doesn't get around the team's cap.
    await expect(create(jordan, {}, [textFile("x.txt", 301)])).rejects.toBeInstanceOf(ValidationError);
    const { id } = await create(member, {}, [textFile("fits.txt", 300)]); // exactly full is fine
    // Nothing was stored by the refused saves.
    expect(await t.db.strategyFile.count({ where: { filename: { in: ["full.txt", "x.txt"] } } })).toBe(0);
    await deleteStrategy(ctx(member), { strategyId: id });
    await t.db.resource.delete({ where: { id: holder.id } });
  });

  it(`each person can add ${STRATEGY_RATE_LIMIT.limit} strategies an hour (and edits that add files count too)`, async () => {
    const busy = await makeUser(t.db, { role: "MEMBER", subteam: "BUILD" });
    for (let i = 0; i < STRATEGY_RATE_LIMIT.limit; i++) await create(busy, { title: `Plan ${i}` });
    await expect(create(busy)).rejects.toBeInstanceOf(RateLimitError);
    const [one] = await t.db.strategy.findMany({ where: { createdById: busy.id }, take: 1 });
    // Editing without new files isn't limited; adding files is.
    await updateStrategy(ctx(busy), { strategyId: one.id, ...form({ title: "Renamed" }) });
    await expect(updateStrategy(ctx(busy), { strategyId: one.id, ...form(), files: [file()] })).rejects.toBeInstanceOf(RateLimitError);
    await createStrategy(ctx(busy, minutesLater(61)), form());
  });
});

// ── Lists and the file route ────────────────────────────────────────────────────

describe("the list", () => {
  it("filters by kind and 'Mine', and shows what each one has", async () => {
    const lister = await makeUser(t.db, { name: "List Tester", role: "MEMBER", subteam: "SOFTWARE" });
    const auto = await create(lister, { title: "Listed auto", description: "Line one\n\nline   two ".repeat(60), link: "https://www.youtube.com/watch?v=1" }, [
      file("a.pp"),
      file("b.pp"),
      file("field.png", PNG),
      file("plan.pdf", PDF),
    ]);
    await create(lister, { title: "Listed scouting", kind: "SCOUTING" });
    const mine = (await listStrategies(lister, { mine: true }, t.db))!;
    expect(mine.items.map((s) => s.title).sort()).toEqual(["Listed auto", "Listed scouting"]);
    const card = mine.items.find((s) => s.id === auto.id)!;
    expect(card).toMatchObject({ pathCount: 2, imageCount: 1, otherFileCount: 1, linkHost: "youtube.com", mine: true, createdByName: "List Tester" });
    expect(card.descriptionPreview.length).toBeLessThanOrEqual(301);
    expect(card.descriptionPreview).not.toMatch(/\n/);
    expect((await listStrategies(lister, { mine: true, kind: "SCOUTING" }, t.db))!.items.map((s) => s.title)).toEqual(["Listed scouting"]);
    const everyone = (await listStrategies(maya, { mine: false, kind: "AUTO" }, t.db))!;
    expect(everyone.items.some((s) => s.id === auto.id && !s.mine)).toBe(true);
    expect(everyone.items.every((s) => s.kind === "AUTO")).toBe(true);
  });
});

describe("the file route", () => {
  it("any active person gets the bytes; .pp paths always download; pictures and PDFs show inline, safely", async () => {
    const { id } = await create(maya, {}, [file("red.pp"), file("field.png", PNG, "image/png"), file("plan.pdf", PDF, "application/pdf")]);
    const files = await t.db.strategyFile.findMany({ where: { strategyId: id }, orderBy: { filename: "asc" } });
    const byName = Object.fromEntries(files.map((f) => [f.filename, f]));
    for (const a of [ethan, priya, jordan, olivia]) {
      const got = await getStrategyFile(a, byName["red.pp"].id, t.db);
      expect(Buffer.from(got!.data).equals(Buffer.from(PP)), a.name).toBe(true);
    }
    for (const a of [pending, disabled, rejected]) expect(await getStrategyFile(a, byName["red.pp"].id, t.db), a.name).toBeNull();
    expect(await getStrategyFile(maya, "missing", t.db)).toBeNull();
    expect(await getStrategyFile(maya, "x".repeat(65), t.db)).toBeNull();
    expect(strategyFileHref("a b", true)).toBe("/strategy/files/a%20b?download=1");

    const headers = (name: string, download = false) => {
      const f = byName[name];
      return strategyFileHeaders({ filename: f.filename, contentType: f.contentType, byteLength: f.size }, { download });
    };
    // A path is always a download, even when asked to show it (and even if it were stored as text).
    expect(headers("red.pp")).toMatchObject({ "Content-Type": "application/octet-stream", "Content-Security-Policy": FILE_CSP, "X-Content-Type-Options": "nosniff" });
    expect(headers("red.pp")["Content-Disposition"]).toMatch(/^attachment; filename="red\.pp"/);
    expect(strategyFileHeaders({ filename: "x.pp", contentType: "text/plain", byteLength: 1 })["Content-Disposition"]).toMatch(/^attachment/);
    expect(headers("field.png")).toMatchObject({ "Content-Type": "image/png", "Cache-Control": "private, no-store" });
    expect(headers("field.png")["Content-Disposition"]).toMatch(/^inline/);
    expect(headers("field.png", true)["Content-Disposition"]).toMatch(/^attachment/);
    expect(headers("plan.pdf")).toMatchObject({ "Content-Type": "application/pdf", "Content-Security-Policy": PDF_CSP });

    const detail = (await getStrategyDetail(ethan, id, t.db))!;
    const path = detail.files.find((f) => f.filename === "red.pp")!;
    expect(path).toMatchObject({ kind: "path", viewHref: null, downloadHref: `/strategy/files/${byName["red.pp"].id}?download=1` });
    // The request helper is only used for its URL here.
    expect(new NextRequest(`http://localhost${path.downloadHref}`).nextUrl.searchParams.get("download")).toBe("1");
  });
});

// ── Client-side checks ─────────────────────────────────────────────────────────

describe("the form's checks (client-safe)", () => {
  it("knows paths and what the planner can open", () => {
    expect(isPedroPathFile("Red Auto.PP")).toBe(true);
    expect(isPedroPathFile("auto.pp.txt")).toBe(false);
    expect(isPedroPathFile("pp")).toBe(false);
    expect(isPedroPathProject(PATH)).toBe(true);
    expect(isPedroPathProject({ startPoint: { x: 1, y: 2 }, lines: [{ endPoint: { x: "3", y: 4 } }] })).toBe(true);
    expect(isPedroPathProject({ startPoint: { x: 1 }, lines: [{ endPoint: { x: 3, y: 4 } }] })).toBe(false);
    expect(isPedroPathProject({ startPoint: { x: 1, y: 2 }, lines: [{}] })).toBe(false);
    expect(isPedroPathProject([PATH])).toBe(false);
    expect(pedroPathProblem(PP, "ok.pp")).toBeNull();
    expect(strategyFileProblem({ name: "a.pp", size: 0 })).toBe("“a.pp” is empty. Choose another file.");
    expect(strategyFileProblem({ name: "a.png", size: LIMITS.resourceFileMaxBytes + 1 })).toMatch(/^“a\.png” is 4\.0 MB\./);
    expect(strategyFileProblem({ name: "a.png", size: 10 })).toBeNull();
    expect(strategySaveTooBigMessage(6 * 1024 * 1024)).toBe(
      "These files add up to 6.0 MB, and one save can carry up to 4 MB. Save with some of them, then edit the strategy to add the rest.",
    );
  });

  it("says what goes when something is removed", () => {
    expect(strategyRemoveQuestion("Red auto", 0)).toBe("Remove “Red auto”?");
    expect(strategyRemoveQuestion("Red auto", 1)).toBe("Remove “Red auto” and its file?");
    expect(strategyRemoveQuestion("Red auto", 3)).toBe("Remove “Red auto” and its 3 files?");
    // Removing a team: tests/league-teams.test.ts.
  });
});
