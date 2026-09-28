import { randomBytes } from "node:crypto";
import JSZip from "jszip";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { LIMITS } from "@/lib/constants";
import {
  exportMenuSide,
  formatStamp,
  isClearedNotebookVersion,
  NOTEBOOK_PICTURE_HEIC_MESSAGE,
  NOTEBOOK_PICTURE_TYPES_MESSAGE,
  NOTEBOOK_PICTURE_UNREADABLE_MESSAGE,
  notebookBlocks,
  notebookChangeLabel,
  notebookExportFilename,
  notebookPictureProblem,
  notebookPicturesFullMessage,
  STANDARD_NOTEBOOKS,
} from "@/lib/notebook";
import type { Actor } from "@/server/actor";
import { ConflictError, ForbiddenError, NotFoundError, RateLimitError, ValidationError } from "@/server/errors";
import { fileStorageUsage } from "@/server/files/storage";
import {
  buildNotebookDocx,
  buildNotebookDocxWithin,
  DOCX_CONTENT_TYPE,
  NOTEBOOK_EXPORT_IMAGE_BUDGET,
  notebookDocxFilename,
  notebookDocxResponse,
  pickExportImages,
} from "@/server/notebook/docx";
import { canEditNotebookEntry, canManageNotebookPages, canManageNotebooks } from "@/server/permissions";
import {
  getLatestNotebookEntries,
  getNotebookEntryHistory,
  getNotebookExport,
  getNotebookForEdit,
  getNotebookImage,
  getNotebookOutline,
  getNotebookPageView,
  loadNotebookImageBytes,
  type NotebookExport,
} from "@/server/queries/notebook";
import {
  addNotebookImage,
  clearNotebookEntryVersion,
  createNotebook,
  createNotebookEntry,
  createNotebookPage,
  createStandardNotebooks,
  deleteNotebook,
  deleteNotebookEntry,
  deleteNotebookPage,
  moveNotebook,
  moveNotebookPage,
  NOTEBOOK_ENTRY_CANT_EDIT,
  NOTEBOOK_ENTRY_EMPTY,
  NOTEBOOK_IMAGE_BYTES_PER_PERSON,
  NOTEBOOK_INACTIVE,
  NOTEBOOK_MANAGERS_ONLY,
  NOTEBOOK_PAGES_MANAGERS_ONLY,
  NOTEBOOK_PICTURE_EDIT_MERGE_MS,
  NOTEBOOK_STANDARD_EXISTS,
  NOTEBOOK_VERSION_NOT_FOUND,
  NOTEBOOK_WRITE_RATE_LIMIT,
  NOTEBOOK_WRITING_WINDOW_MS,
  removeNotebookImage,
  renameNotebookPage,
  updateNotebook,
  updateNotebookEntry,
} from "@/server/services/notebook";
import { createTestDb, type TestDb } from "./helpers/db";
import { contextFor, makeUser, TEST_NOW, TEST_TZ } from "./helpers/factories";

let t: TestDb;
let jordan: Actor; // Captain
let elena: Actor; // Mentor
let david: Actor; // Teacher
let olivia: Actor; // Owner (a Build member with the Owner flag)
let marcus: Actor; // Build leader
let priya: Actor; // Software leader
let amara: Actor; // Business leader
let ethan: Actor; // Build member
let isabella: Actor; // Build member
let maya: Actor; // Software member
let ava: Actor; // Business member
let pending: Actor;
let disabled: Actor;
let pendingLeader: Actor;

beforeAll(async () => {
  t = await createTestDb();
  jordan = await makeUser(t.db, { name: "Jordan Lee", role: "CAPTAIN" });
  elena = await makeUser(t.db, { name: "Elena Petrova", role: "MENTOR" });
  david = await makeUser(t.db, { name: "David Kim", role: "TEACHER" });
  olivia = await makeUser(t.db, { name: "Olivia Stone", role: "MEMBER", subteam: "BUILD", isAdmin: true });
  marcus = await makeUser(t.db, { name: "Marcus Johnson", role: "BUILD_LEADER" });
  priya = await makeUser(t.db, { name: "Priya Raman", role: "SOFTWARE_LEADER" });
  amara = await makeUser(t.db, { name: "Amara Okafor", role: "BUSINESS_LEADER" });
  ethan = await makeUser(t.db, { name: "Ethan Chen", role: "MEMBER", subteam: "BUILD" });
  isabella = await makeUser(t.db, { name: "Isabella Rossi", role: "MEMBER", subteam: "BUILD" });
  maya = await makeUser(t.db, { name: "Maya Patel", role: "MEMBER", subteam: "SOFTWARE" });
  ava = await makeUser(t.db, { name: "Ava Thompson", role: "MEMBER", subteam: "BUSINESS" });
  pending = await makeUser(t.db, { name: "Pat Pending", role: "MEMBER", subteam: "BUILD", status: "PENDING" });
  disabled = await makeUser(t.db, { name: "Dana Gone", role: "MEMBER", subteam: "BUILD", status: "DISABLED" });
  pendingLeader = await makeUser(t.db, { name: "Quinn Waiting", role: "BUILD_LEADER", status: "PENDING" });
});
afterAll(async () => {
  await t.drop();
});

const ctx = (actor: Actor, minutesLater = 0) => {
  const c = contextFor(t.db, actor);
  return minutesLater ? { ...c, now: new Date(TEST_NOW.getTime() + minutesLater * 60_000) } : c;
};

async function errorOf(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => null,
    (e: unknown) => e,
  );
}

async function forbidden(p: Promise<unknown>, message?: string) {
  const err = await errorOf(p);
  expect(err).toBeInstanceOf(ForbiddenError);
  if (message) expect((err as ForbiddenError).userMessage).toBe(message);
}

async function validationOf(p: Promise<unknown>): Promise<ValidationError> {
  const err = await errorOf(p);
  expect(err).toBeInstanceOf(ValidationError);
  return err as ValidationError;
}

// ── Pictures ─────────────────────────────────────────────────────────────────

/** A real 1×1 PNG. */
const PNG = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"));
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0));
const be16 = (n: number) => [(n >> 8) & 0xff, n & 0xff];
const be32 = (n: number) => [(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
const pngOf = (width: number, height: number) =>
  Uint8Array.from([...PNG_SIG, 0, 0, 0, 13, ...ascii("IHDR"), ...be32(width), ...be32(height), 8, 2, 0, 0, 0, 0, 0, 0, 0]);
const jpegOf = (width: number, height: number) =>
  Uint8Array.from([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x10, ...ascii("JFIF"), 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x11, 0x08, ...be16(height), ...be16(width), 0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
    0xff, 0xd9,
  ]);
const GIF = Uint8Array.from([...ascii("GIF89a"), 0x02, 0x00, 0x03, 0x00, 0x00, 0x00, 0x00, 0x3b]);
const WEBP = Uint8Array.from([...ascii("RIFF"), 0x1a, 0x00, 0x00, 0x00, ...ascii("WEBPVP8L"), 0x0d, 0x00, 0x00, 0x00, 0x2f, 0x00, 0x00, 0x00, 0x00]);
const PDF = new TextEncoder().encode("%PDF-1.4\n% not a picture\n");
const HEIC = Uint8Array.from([0x00, 0x00, 0x00, 0x18, ...ascii("ftypheic"), 0x00, 0x00, 0x00, 0x00, ...ascii("mif1heic")]);

function picture(name = "intake.png", bytes: Uint8Array | string = PNG, type = "image/png") {
  return { name, type, bytes: typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function notebookWithPages(subteam: "BUILD" | "SOFTWARE" | "BUSINESS" | null, title: string, pages: string[]) {
  const nb = await t.db.notebook.create({
    data: {
      title,
      subteam,
      position: 100,
      createdById: jordan.id,
      pages: { create: pages.map((p, i) => ({ title: p, position: i, createdById: jordan.id })) },
    },
    include: { pages: { orderBy: { position: "asc" } } },
  });
  return { notebook: nb, pages: nb.pages };
}

async function write(actor: Actor, pageId: string, body = "Tested the intake at 80% power.", title = "", minutesLater = 0) {
  return createNotebookEntry(ctx(actor, minutesLater), { pageId, title, body });
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

describe("notebook helpers", () => {
  it("stamps read like 'Thu, Sep 24, 2026, 12:00 PM' in the team timezone", () => {
    expect(formatStamp(TEST_NOW, TEST_TZ)).toBe("Thu, Sep 24, 2026, 12:00 PM");
    expect(formatStamp(new Date("2026-09-27T22:42:00Z"), TEST_TZ)).toBe("Sun, Sep 27, 2026, 3:42 PM");
  });

  it("splits entry text into paragraphs and '- ' bullet lists", () => {
    expect(notebookBlocks("Goals:\n- faster intake\n* fewer jams\n• lighter\n\nResult: works.\nNext time")).toEqual([
      { kind: "text", text: "Goals:" },
      { kind: "list", items: ["faster intake", "fewer jams", "lighter"] },
      { kind: "text", text: "Result: works.\nNext time" },
    ]);
    expect(notebookBlocks("-not a bullet\n- ")).toEqual([{ kind: "text", text: "-not a bullet\n- " }]);
    expect(notebookBlocks("\n\n")).toEqual([]);
  });

  it("export file names drop characters computers refuse", () => {
    expect(notebookExportFilename(["Hardware Notebook"], "2026-09-27")).toBe("Hardware Notebook 2026-09-27.docx");
    expect(notebookExportFilename(["Hardware Notebook", "Intake/Outtake: v2?"], "2026-09-27")).toBe(
      "Hardware Notebook - Intake Outtake v2 2026-09-27.docx",
    );
    expect(notebookExportFilename(["///"], "2026-09-27")).toBe("Notebook 2026-09-27.docx");
  });

  it("export file names are cut by whole characters, never half an emoji", () => {
    // "A"×80 + " - " + "B"×16 is 99 UTF-16 units: the wrench's first half would be the 100th.
    const name = notebookExportFilename(["A".repeat(80), `${"B".repeat(16)}🔧 Intake`], "2026-09-27");
    expect(name.isWellFormed()).toBe(true);
    expect(name).toBe(`${"A".repeat(80)} - ${"B".repeat(16)}🔧 2026-09-27.docx`);
    expect(() => encodeURIComponent(name)).not.toThrow();
    // A stray half character in a title is dropped.
    expect(notebookExportFilename(["Roller \ud83d test"], "2026-09-27")).toBe("Roller test 2026-09-27.docx");
  });

  it("History says what each change did", () => {
    const v = (title: string, body: string) => ({ title, body });
    expect(notebookChangeLabel(v("A", "x"), v("B", "x"))).toBe("changed the title");
    expect(notebookChangeLabel(v("A", "x"), v("A", "y"))).toBe("changed the text");
    expect(notebookChangeLabel(v("A", "x"), v("B", "y"))).toBe("changed the title and text");
    expect(notebookChangeLabel(v("A", "x"), v("A", "x"))).toBe("changed the pictures");
    expect(notebookChangeLabel(v("", ""), v("A", "x"))).toBe("changed it"); // its text was taken out
    expect(notebookChangeLabel(v("A", "x"), v("", ""))).toBe("changed it");
    expect(notebookChangeLabel(v("A", "x"), null)).toBe("changed it");
    expect(isClearedNotebookVersion(v("", ""))).toBe(true);
    expect(isClearedNotebookVersion(v("", "x"))).toBe(false);
  });

  it("the Export menu opens toward the side with room, so it never runs off a phone's screen", () => {
    // A 375px phone: the button at the right edge (a short page title beside it) opens leftwards…
    expect(exportMenuSide({ left: 233, right: 359 }, 375, "start")).toBe("end");
    expect(exportMenuSide({ left: 233, right: 359 }, 375, "end")).toBe("end");
    // …and at the left edge (a long title above it) rightwards, even when the right edge is preferred.
    expect(exportMenuSide({ left: 16, right: 142 }, 375, "end")).toBe("start");
    expect(exportMenuSide({ left: 16, right: 142 }, 375, "start")).toBe("start");
    // Desktop: the preferred side.
    expect(exportMenuSide({ left: 1200, right: 1320 }, 1440, "end")).toBe("end");
    expect(exportMenuSide({ left: 300, right: 420 }, 1440, "start")).toBe("start");
    // No room either way (a very narrow screen): the side with more room.
    expect(exportMenuSide({ left: 100, right: 200 }, 300, "start")).toBe("start");
    expect(exportMenuSide({ left: 150, right: 250 }, 300, "start")).toBe("end");
  });

  it("the editor checks a picked picture before sending it", () => {
    expect(notebookPictureProblem({ name: "a.png", type: "image/png", size: 10 })).toBeNull();
    expect(notebookPictureProblem({ name: "a.webp", type: "", size: 10 })).toBeNull();
    expect(notebookPictureProblem({ name: "a.png", type: "image/png", size: 0 })).toMatch(/empty/);
    expect(notebookPictureProblem({ name: "IMG_1.HEIC", type: "", size: 10 })).toBe(NOTEBOOK_PICTURE_HEIC_MESSAGE);
    expect(notebookPictureProblem({ name: "logo.svg", type: "image/svg+xml", size: 10 })).toBe(NOTEBOOK_PICTURE_TYPES_MESSAGE);
    expect(notebookPictureProblem({ name: "a.pdf", type: "application/pdf", size: 10 })).toBe(NOTEBOOK_PICTURE_TYPES_MESSAGE);
    expect(notebookPictureProblem({ name: "big.jpg", type: "image/jpeg", size: LIMITS.resourceFileMaxBytes + 1 })).toMatch(/^That picture is 4\.0 MB/);
  });
});

// ── Permissions ──────────────────────────────────────────────────────────────

describe("who can manage notebooks and pages", () => {
  it("canManageNotebooks: the captain, mentors, teachers, and owners", () => {
    for (const a of [jordan, elena, david, olivia]) expect(canManageNotebooks(a), a.name).toBe(true);
    for (const a of [marcus, priya, amara, ethan, maya, ava]) expect(canManageNotebooks(a), a.name).toBe(false);
  });

  it("canManageNotebookPages: all-scope staff, plus the leaders of that notebook's subteam only", () => {
    const build = { subteam: "BUILD" as const };
    const software = { subteam: "SOFTWARE" as const };
    const wholeTeam = { subteam: null };
    for (const nb of [build, software, wholeTeam]) {
      for (const a of [jordan, elena, david, olivia]) expect(canManageNotebookPages(a, nb), a.name).toBe(true);
      for (const a of [ethan, maya, ava]) expect(canManageNotebookPages(a, nb), a.name).toBe(false);
    }
    expect(canManageNotebookPages(marcus, build)).toBe(true);
    expect(canManageNotebookPages(marcus, software)).toBe(false);
    expect(canManageNotebookPages(marcus, wholeTeam)).toBe(false);
    expect(canManageNotebookPages(priya, software)).toBe(true);
    expect(canManageNotebookPages(priya, build)).toBe(false);
    expect(canManageNotebookPages(amara, build)).toBe(false);
  });

  it("canEditNotebookEntry: whoever wrote it, plus whoever manages the notebook's pages", () => {
    const build = { subteam: "BUILD" as const };
    const by = (a: Actor) => ({ authorId: a.id, author: { role: a.role, isAdmin: a.isAdmin } });
    const byEthan = by(ethan);
    expect(canEditNotebookEntry(ethan, byEthan, build)).toBe(true);
    expect(canEditNotebookEntry(marcus, byEthan, build)).toBe(true);
    expect(canEditNotebookEntry(jordan, byEthan, build)).toBe(true);
    expect(canEditNotebookEntry(isabella, byEthan, build)).toBe(false);
    expect(canEditNotebookEntry(priya, byEthan, build)).toBe(false);
    // An entry whose author left (null) is only for managers.
    expect(canEditNotebookEntry(ethan, { authorId: null, author: null }, build)).toBe(false);
    expect(canEditNotebookEntry(marcus, { authorId: null, author: null }, build)).toBe(true);
  });

  it("canEditNotebookEntry: subteam leaders don't change entries by the captain, mentors, teachers, or owners", () => {
    const build = { subteam: "BUILD" as const };
    const by = (a: Actor) => ({ authorId: a.id, author: { role: a.role, isAdmin: a.isAdmin } });
    for (const author of [jordan, elena, david, olivia]) {
      expect(canEditNotebookEntry(marcus, by(author), build), author.name).toBe(false);
      expect(canEditNotebookEntry(author, by(author), build), author.name).toBe(true);
    }
    // All-scope staff still change each other's, and a leader still changes another leader's.
    expect(canEditNotebookEntry(elena, by(jordan), build)).toBe(true);
    expect(canEditNotebookEntry(jordan, by(olivia), build)).toBe(true);
    expect(canEditNotebookEntry(marcus, by(marcus), build)).toBe(true);
    const otherBuildLeader = { ...marcus, id: "another-build-leader" };
    expect(canEditNotebookEntry(otherBuildLeader, by(marcus), build)).toBe(true);
  });
});

// ── Standard notebooks ───────────────────────────────────────────────────────

describe("the standard notebooks", () => {
  beforeEach(async () => {
    await t.db.notebook.deleteMany();
  });

  it("only managers can create them", async () => {
    for (const a of [marcus, priya, amara, ethan]) await forbidden(createStandardNotebooks(ctx(a)), NOTEBOOK_MANAGERS_ONLY);
    for (const a of [pending, disabled, pendingLeader]) await forbidden(createStandardNotebooks(ctx(a)), NOTEBOOK_INACTIVE);
    expect(await t.db.notebook.count()).toBe(0);
  });

  it("creates Hardware, Software, and Business with their pages, in order — only once", async () => {
    expect(await createStandardNotebooks(ctx(jordan))).toEqual({ count: 3 });
    const notebooks = await t.db.notebook.findMany({ orderBy: { position: "asc" }, include: { pages: { orderBy: { position: "asc" } } } });
    expect(
      notebooks.map((n) => ({ title: n.title, emoji: n.emoji, subteam: n.subteam, position: n.position, pages: n.pages.map((p) => p.title) })),
    ).toEqual([
      { title: "Hardware Notebook", emoji: "👷", subteam: "BUILD", position: 0, pages: ["Intake", "Outtake"] },
      { title: "Software Notebook", emoji: "🧑‍💻", subteam: "SOFTWARE", position: 1, pages: ["Competition", "Prototyping", "Transfer"] },
      { title: "Business Notebook", emoji: "🧑‍💼", subteam: "BUSINESS", position: 2, pages: ["Outreach", "Sponsorships", "Engineering Journal"] },
    ]);
    expect(STANDARD_NOTEBOOKS).toHaveLength(3);
    for (const n of notebooks) {
      expect(n.createdById).toBe(jordan.id);
      expect(n.pages.map((p) => p.position)).toEqual(n.pages.map((_, i) => i));
    }

    const again = await errorOf(createStandardNotebooks(ctx(elena)));
    expect(again).toBeInstanceOf(ConflictError);
    expect((again as ConflictError).userMessage).toBe(NOTEBOOK_STANDARD_EXISTS);
    expect(await t.db.notebook.count()).toBe(3);
  });

  it("two managers clicking at the same moment still get one set", async () => {
    const results = await Promise.allSettled([createStandardNotebooks(ctx(jordan)), createStandardNotebooks(ctx(elena))]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await t.db.notebook.count()).toBe(3);
    expect(await t.db.notebookPage.count()).toBe(8);
  });

  it("isn't offered once any notebook exists", async () => {
    await createNotebook(ctx(jordan), { title: "Robot journal" });
    await expect(createStandardNotebooks(ctx(jordan))).rejects.toBeInstanceOf(ConflictError);
    expect(await t.db.notebook.count()).toBe(1);
  });
});

// ── Notebooks ────────────────────────────────────────────────────────────────

describe("notebooks", () => {
  beforeEach(async () => {
    await t.db.notebook.deleteMany();
  });

  it("the captain, mentors, teachers, and owners add them, at the end of the list", async () => {
    const made = [];
    for (const [i, a] of [jordan, elena, david, olivia].entries()) {
      const { id } = await createNotebook(ctx(a), { title: `  Notebook ${i}  `, emoji: "🔧", description: "Stuff", subteam: "BUILD" });
      made.push(await t.db.notebook.findUniqueOrThrow({ where: { id } }));
    }
    expect(made.map((n) => [n.title, n.position, n.createdById])).toEqual([
      ["Notebook 0", 0, jordan.id],
      ["Notebook 1", 1, elena.id],
      ["Notebook 2", 2, david.id],
      ["Notebook 3", 3, olivia.id],
    ]);
    expect(made[0]).toMatchObject({ emoji: "🔧", description: "Stuff", subteam: "BUILD", createdAt: TEST_NOW });
    // "" = the whole team's notebook.
    const { id } = await createNotebook(ctx(jordan), { title: "Team journal", subteam: "" });
    expect((await t.db.notebook.findUniqueOrThrow({ where: { id } })).subteam).toBeNull();
  });

  it("leaders, members, and inactive accounts can't add, change, move, or delete notebooks", async () => {
    const { id } = await createNotebook(ctx(jordan), { title: "Hardware Notebook", subteam: "BUILD" });
    for (const a of [marcus, priya, amara, ethan, maya]) {
      await forbidden(createNotebook(ctx(a), { title: "Mine" }), NOTEBOOK_MANAGERS_ONLY);
      await forbidden(updateNotebook(ctx(a), { notebookId: id, title: "Hijacked" }), NOTEBOOK_MANAGERS_ONLY);
      await forbidden(moveNotebook(ctx(a), { notebookId: id, direction: "down" }), NOTEBOOK_MANAGERS_ONLY);
      await forbidden(deleteNotebook(ctx(a), { notebookId: id }), NOTEBOOK_MANAGERS_ONLY);
    }
    for (const a of [pending, disabled]) await forbidden(createNotebook(ctx(a), { title: "Mine" }), NOTEBOOK_INACTIVE);
    expect((await t.db.notebook.findUniqueOrThrow({ where: { id } })).title).toBe("Hardware Notebook");
    expect(await t.db.notebook.count()).toBe(1);
  });

  it("checks the fields", async () => {
    const empty = await validationOf(createNotebook(ctx(jordan), { title: "  " }));
    expect(empty.fieldErrors.title).toBe("Title is required.");
    const long = await validationOf(createNotebook(ctx(jordan), { title: "x".repeat(LIMITS.notebookTitleMax + 1) }));
    expect(long.fieldErrors.title).toMatch(/at most/);
    const team = await validationOf(createNotebook(ctx(jordan), { title: "Ok", subteam: "ROBOTS" }));
    expect(team.fieldErrors.subteam).toBe("Pick whose notebook it is.");
    const emoji = await validationOf(createNotebook(ctx(jordan), { title: "Ok", emoji: "🔧".repeat(20) }));
    expect(emoji.fieldErrors.emoji).toMatch(/at most/);
    expect(await t.db.notebook.count()).toBe(0);
  });

  it("changes a notebook (title, emoji, description, whose it is)", async () => {
    const { id } = await createNotebook(ctx(jordan), { title: "Hardware", subteam: "BUILD" });
    await updateNotebook(ctx(elena), { notebookId: id, title: "Hardware Notebook", emoji: "👷", description: "Build's notebook", subteam: "SOFTWARE" });
    expect(await t.db.notebook.findUniqueOrThrow({ where: { id } })).toMatchObject({
      title: "Hardware Notebook",
      emoji: "👷",
      description: "Build's notebook",
      subteam: "SOFTWARE",
    });
    await expect(updateNotebook(ctx(jordan), { notebookId: "nope", title: "X" })).rejects.toBeInstanceOf(NotFoundError);
    // The edit form: only for managers.
    expect(await getNotebookForEdit(jordan, id, t.db)).toMatchObject({ id, title: "Hardware Notebook", pageCount: 0, entryCount: 0 });
    expect(await getNotebookForEdit(marcus, id, t.db)).toBeNull();
    expect(await getNotebookForEdit(pending, id, t.db)).toBeNull();
  });

  it("moves up and down, renumbering 0..n-1; at an end nothing changes", async () => {
    const a = await createNotebook(ctx(jordan), { title: "A" });
    const b = await createNotebook(ctx(jordan), { title: "B" });
    const c = await createNotebook(ctx(jordan), { title: "C" });
    // A gap, like after a delete.
    await t.db.notebook.update({ where: { id: c.id }, data: { position: 7 } });
    const order = async () =>
      (await t.db.notebook.findMany({ orderBy: { position: "asc" }, select: { title: true, position: true } })).map((n) => `${n.title}${n.position}`);

    await moveNotebook(ctx(jordan), { notebookId: c.id, direction: "up" });
    expect(await order()).toEqual(["A0", "C1", "B2"]);
    await moveNotebook(ctx(elena), { notebookId: a.id, direction: "up" }); // already first
    expect(await order()).toEqual(["A0", "C1", "B2"]);
    await moveNotebook(ctx(david), { notebookId: a.id, direction: "down" });
    expect(await order()).toEqual(["C0", "A1", "B2"]);
    await moveNotebook(ctx(jordan), { notebookId: b.id, direction: "down" }); // already last
    expect(await order()).toEqual(["C0", "A1", "B2"]);
    await expect(moveNotebook(ctx(jordan), { notebookId: "gone", direction: "up" })).rejects.toBeInstanceOf(NotFoundError);
    const bad = await validationOf(moveNotebook(ctx(jordan), { notebookId: a.id, direction: "sideways" }));
    expect(bad.fieldErrors.direction).toBe("Pick up or down.");
  });

  it("deleting a notebook deletes its pages, entries, history, and pictures, and says how many", async () => {
    const { notebook, pages } = await notebookWithPages("BUILD", "Doomed", ["Intake", "Outtake"]);
    const e1 = await write(ethan, pages[0].id);
    await write(isabella, pages[1].id);
    await updateNotebookEntry(ctx(ethan), { entryId: e1.id, body: "Changed" });
    await addNotebookImage(ctx(ethan), { entryId: e1.id, file: picture() });
    expect(await getNotebookForEdit(jordan, notebook.id, t.db)).toMatchObject({ pageCount: 2, entryCount: 2 });

    expect(await deleteNotebook(ctx(jordan), { notebookId: notebook.id })).toEqual({ title: "Doomed", pages: 2, entries: 2 });
    expect(await t.db.notebookPage.count({ where: { notebookId: notebook.id } })).toBe(0);
    expect(await t.db.notebookEntry.count({ where: { id: e1.id } })).toBe(0);
    expect(await t.db.notebookEntryEdit.count({ where: { entryId: e1.id } })).toBe(0);
    expect(await t.db.notebookImage.count({ where: { entryId: e1.id } })).toBe(0);
    await expect(deleteNotebook(ctx(jordan), { notebookId: notebook.id })).rejects.toBeInstanceOf(NotFoundError);
  });
});

// ── Pages ────────────────────────────────────────────────────────────────────

describe("pages", () => {
  beforeEach(async () => {
    await t.db.notebook.deleteMany();
  });

  it("a subteam's leaders manage their own notebook's pages only; all-scope staff manage every notebook's", async () => {
    const hw = (await notebookWithPages("BUILD", "Hardware Notebook", [])).notebook;
    const sw = (await notebookWithPages("SOFTWARE", "Software Notebook", [])).notebook;
    const team = (await notebookWithPages(null, "Team journal", [])).notebook;

    const intake = await createNotebookPage(ctx(marcus), { notebookId: hw.id, title: "Intake" });
    await createNotebookPage(ctx(priya), { notebookId: sw.id, title: "Competition" });
    for (const a of [jordan, elena, david, olivia]) {
      for (const nb of [hw, sw, team]) await createNotebookPage(ctx(a), { notebookId: nb.id, title: `From ${a.name}` });
    }

    await forbidden(createNotebookPage(ctx(marcus), { notebookId: sw.id, title: "Nope" }), NOTEBOOK_PAGES_MANAGERS_ONLY);
    await forbidden(createNotebookPage(ctx(marcus), { notebookId: team.id, title: "Nope" }), NOTEBOOK_PAGES_MANAGERS_ONLY);
    await forbidden(createNotebookPage(ctx(priya), { notebookId: hw.id, title: "Nope" }), NOTEBOOK_PAGES_MANAGERS_ONLY);
    await forbidden(createNotebookPage(ctx(amara), { notebookId: hw.id, title: "Nope" }), NOTEBOOK_PAGES_MANAGERS_ONLY);
    for (const a of [ethan, maya, ava]) {
      await forbidden(createNotebookPage(ctx(a), { notebookId: hw.id, title: "Nope" }), NOTEBOOK_PAGES_MANAGERS_ONLY);
      await forbidden(renameNotebookPage(ctx(a), { pageId: intake.id, title: "Nope" }), NOTEBOOK_PAGES_MANAGERS_ONLY);
      await forbidden(moveNotebookPage(ctx(a), { pageId: intake.id, direction: "down" }), NOTEBOOK_PAGES_MANAGERS_ONLY);
      await forbidden(deleteNotebookPage(ctx(a), { pageId: intake.id }), NOTEBOOK_PAGES_MANAGERS_ONLY);
    }
    await forbidden(renameNotebookPage(ctx(priya), { pageId: intake.id, title: "Nope" }), NOTEBOOK_PAGES_MANAGERS_ONLY);
    for (const a of [pending, disabled, pendingLeader]) {
      await forbidden(createNotebookPage(ctx(a), { notebookId: hw.id, title: "Nope" }), NOTEBOOK_INACTIVE);
    }
    expect(await t.db.notebookPage.count({ where: { title: "Nope" } })).toBe(0);

    const hwPages = await t.db.notebookPage.findMany({ where: { notebookId: hw.id }, orderBy: { position: "asc" } });
    expect(hwPages.map((p) => [p.title, p.position])).toEqual([
      ["Intake", 0],
      ["From Jordan Lee", 1],
      ["From Elena Petrova", 2],
      ["From David Kim", 3],
      ["From Olivia Stone", 4],
    ]);
    expect(hwPages[0]).toMatchObject({ createdById: marcus.id, createdAt: TEST_NOW });

    await renameNotebookPage(ctx(marcus), { pageId: intake.id, title: " Intake v2 " });
    expect((await t.db.notebookPage.findUniqueOrThrow({ where: { id: intake.id } })).title).toBe("Intake v2");
    const empty = await validationOf(renameNotebookPage(ctx(marcus), { pageId: intake.id, title: "" }));
    expect(empty.fieldErrors.title).toBe("Page name is required.");
    await expect(createNotebookPage(ctx(jordan), { notebookId: "gone", title: "X" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(renameNotebookPage(ctx(jordan), { pageId: "gone", title: "X" })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("move within their notebook (renumbered), and new pages go at the end", async () => {
    const { notebook, pages } = await notebookWithPages("BUILD", "Hardware Notebook", ["Intake", "Outtake", "Drivetrain"]);
    const other = await notebookWithPages("BUILD", "Other", ["Elsewhere"]);
    const titles = async () =>
      (await t.db.notebookPage.findMany({ where: { notebookId: notebook.id }, orderBy: { position: "asc" } })).map((p) => `${p.title}${p.position}`);

    await moveNotebookPage(ctx(marcus), { pageId: pages[2].id, direction: "up" });
    expect(await titles()).toEqual(["Intake0", "Drivetrain1", "Outtake2"]);
    await moveNotebookPage(ctx(marcus), { pageId: pages[0].id, direction: "up" });
    expect(await titles()).toEqual(["Intake0", "Drivetrain1", "Outtake2"]);
    await moveNotebookPage(ctx(jordan), { pageId: pages[0].id, direction: "down" });
    expect(await titles()).toEqual(["Drivetrain0", "Intake1", "Outtake2"]);
    // Another notebook's pages don't move.
    expect((await t.db.notebookPage.findUniqueOrThrow({ where: { id: other.pages[0].id } })).position).toBe(0);

    await deleteNotebookPage(ctx(marcus), { pageId: pages[2].id }); // Drivetrain
    await createNotebookPage(ctx(marcus), { notebookId: notebook.id, title: "Lift" });
    expect(await titles()).toEqual(["Intake1", "Outtake2", "Lift3"]);
  });

  it("deleting a page deletes its entries (with history and pictures) and says how many", async () => {
    const { pages } = await notebookWithPages("BUILD", "Hardware Notebook", ["Intake", "Outtake"]);
    const e1 = await write(ethan, pages[0].id);
    await write(isabella, pages[0].id);
    const kept = await write(ethan, pages[1].id);
    await updateNotebookEntry(ctx(ethan), { entryId: e1.id, body: "v2" });
    await addNotebookImage(ctx(ethan), { entryId: e1.id, file: picture() });

    expect(await deleteNotebookPage(ctx(marcus), { pageId: pages[0].id })).toMatchObject({ title: "Intake", entries: 2 });
    expect(await t.db.notebookEntry.count({ where: { pageId: pages[0].id } })).toBe(0);
    expect(await t.db.notebookEntryEdit.count({ where: { entryId: e1.id } })).toBe(0);
    expect(await t.db.notebookImage.count({ where: { entryId: e1.id } })).toBe(0);
    expect(await t.db.notebookEntry.count({ where: { id: kept.id } })).toBe(1);
    await expect(deleteNotebookPage(ctx(marcus), { pageId: pages[0].id })).rejects.toBeInstanceOf(NotFoundError);
  });
});

// ── Entries ──────────────────────────────────────────────────────────────────

describe("entries", () => {
  let intake: string;
  let competition: string;

  beforeAll(async () => {
    await t.db.notebook.deleteMany();
    intake = (await notebookWithPages("BUILD", "Hardware Notebook", ["Intake"])).pages[0].id;
    competition = (await notebookWithPages("SOFTWARE", "Software Notebook", ["Competition"])).pages[0].id;
  });

  it("anyone active writes on any page; the server stamps who and when (never the form)", async () => {
    for (const a of [ethan, maya, ava, marcus, priya, jordan, elena, olivia]) {
      const { id } = await createNotebookEntry(ctx(a), {
        pageId: intake,
        title: `  From ${a.name}  `,
        body: "  Measured the intake roller speed.\n- 312 rpm\n- no jams  ",
        authorId: jordan.id,
        createdAt: "2020-01-01T00:00:00Z",
        lastEditedAt: "2020-01-01T00:00:00Z",
      });
      const row = await t.db.notebookEntry.findUniqueOrThrow({ where: { id } });
      expect(row).toMatchObject({
        pageId: intake,
        title: `From ${a.name}`,
        body: "Measured the intake roller speed.\n- 312 rpm\n- no jams",
        authorId: a.id,
        createdAt: TEST_NOW,
        lastEditedAt: null,
        lastEditedById: null,
      });
    }
    // Title is optional.
    const { id } = await write(maya, competition, "Auto path 2 works from the far side.");
    expect((await t.db.notebookEntry.findUniqueOrThrow({ where: { id } })).title).toBe("");
  });

  it("accounts that aren't active can't write, and the text is required and capped", async () => {
    for (const a of [pending, disabled, pendingLeader]) await forbidden(write(a, intake), NOTEBOOK_INACTIVE);
    const empty = await validationOf(createNotebookEntry(ctx(ethan), { pageId: intake, title: "Just a title", body: "   " }));
    expect(empty.fieldErrors.body).toBe(NOTEBOOK_ENTRY_EMPTY);
    const missing = await validationOf(createNotebookEntry(ctx(ethan), { pageId: intake }));
    expect(missing.fieldErrors.body).toBe(NOTEBOOK_ENTRY_EMPTY);
    const long = await validationOf(write(ethan, intake, "x".repeat(LIMITS.notebookEntryBodyMax + 1)));
    expect(long.fieldErrors.body).toMatch(/^Keep the entry under 20,000 characters/);
    const longTitle = await validationOf(write(ethan, intake, "ok", "t".repeat(LIMITS.notebookEntryTitleMax + 1)));
    expect(longTitle.fieldErrors.title).toMatch(/at most/);
    await expect(write(ethan, "gone")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("every change is logged with who, when, and what it said before, and marks it edited", async () => {
    const { id } = await write(ethan, intake, "First try: 60% power.", "Intake test");
    const v2 = await updateNotebookEntry(ctx(ethan, 30), { entryId: id, title: "Intake test", body: "First try: 80% power." });
    expect(v2).toEqual({ id, pageId: intake, changed: true });
    // A Build leader fixes it later.
    await updateNotebookEntry(ctx(marcus, 90), { entryId: id, title: "Intake test (fixed)", body: "First try: 80% power. Roller swapped." });

    const row = await t.db.notebookEntry.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({
      title: "Intake test (fixed)",
      body: "First try: 80% power. Roller swapped.",
      authorId: ethan.id,
      createdAt: TEST_NOW,
      lastEditedById: marcus.id,
      lastEditedAt: new Date(TEST_NOW.getTime() + 90 * 60_000),
    });
    const edits = await t.db.notebookEntryEdit.findMany({ where: { entryId: id }, orderBy: { editedAt: "asc" } });
    expect(edits.map((e) => [e.editorId, e.editedAt.getTime() - TEST_NOW.getTime(), e.previousTitle, e.previousBody])).toEqual([
      [ethan.id, 30 * 60_000, "Intake test", "First try: 60% power."],
      [marcus.id, 90 * 60_000, "Intake test", "First try: 80% power."],
    ]);

    // Saved without changes: nothing is logged.
    const same = await updateNotebookEntry(ctx(jordan, 120), { entryId: id, title: "Intake test (fixed)", body: "First try: 80% power. Roller swapped." });
    expect(same.changed).toBe(false);
    expect(await t.db.notebookEntryEdit.count({ where: { entryId: id } })).toBe(2);
    expect((await t.db.notebookEntry.findUniqueOrThrow({ where: { id } })).lastEditedById).toBe(marcus.id);

    // The page shows it: stamps, "Edited by", and the history newest first.
    const view = await getNotebookPageView(isabella, intake, { order: "newest" }, t.db);
    const shown = view!.entries.find((e) => e.id === id)!;
    expect(shown).toMatchObject({
      authorName: "Ethan Chen",
      lastEditedByName: "Marcus Johnson",
      historyCount: 2,
      canEdit: false,
      mine: false,
    });
    expect(shown).not.toHaveProperty("history"); // loaded when History is opened
    const history = (await getNotebookEntryHistory(isabella, id, t.db))!;
    expect(history).toMatchObject({ entryId: id, title: "Intake test (fixed)", historyCount: 2, canClear: false });
    expect(history.versions.map((h) => [h.editorName, h.previousTitle, h.previousBody])).toEqual([
      ["Marcus Johnson", "Intake test", "First try: 80% power."],
      ["Ethan Chen", "Intake test", "First try: 60% power."],
    ]);
    expect((await getNotebookEntryHistory(marcus, id, t.db))!.canClear).toBe(true);
    expect(await getNotebookEntryHistory(pending, id, t.db)).toBeNull();
    expect(await getNotebookEntryHistory(isabella, "gone", t.db)).toBeNull();
  });

  it("saving it unchanged doesn't use up one of the hourly writes", async () => {
    const { id } = await write(amara, intake, "Amara's entry");
    const key = `notebook-write:${amara.id}`;
    const count = async () => (await t.db.rateLimit.findUnique({ where: { key } }))?.count ?? 0;
    const before = await count();
    expect((await updateNotebookEntry(ctx(amara), { entryId: id, body: "Amara's entry" })).changed).toBe(false);
    expect(await count()).toBe(before);
    expect((await updateNotebookEntry(ctx(amara), { entryId: id, body: "Amara's entry, fixed" })).changed).toBe(true);
    expect(await count()).toBe(before + 1);
  });

  it("subteam leaders can't change or delete what the captain, mentors, teachers, or owners wrote", async () => {
    for (const author of [jordan, elena, david, olivia]) {
      const { id } = await write(author, intake, `${author.name}'s entry`);
      await forbidden(updateNotebookEntry(ctx(marcus), { entryId: id, body: "Changed" }), NOTEBOOK_ENTRY_CANT_EDIT);
      await forbidden(deleteNotebookEntry(ctx(marcus), { entryId: id }), NOTEBOOK_ENTRY_CANT_EDIT);
      await forbidden(addNotebookImage(ctx(marcus), { entryId: id, file: picture() }), NOTEBOOK_ENTRY_CANT_EDIT);
      expect((await getNotebookPageView(marcus, intake, { order: "newest" }, t.db))!.entries.find((e) => e.id === id)!.canEdit).toBe(false);
      // All-scope staff still can.
      await updateNotebookEntry(ctx(author === jordan ? elena : jordan), { entryId: id, body: "Checked" });
    }
  });

  it("an old version's text can be taken out of the history, keeping who changed it and when", async () => {
    const { id } = await write(ethan, intake, "Wi-Fi password is hunter2", "Setup");
    await updateNotebookEntry(ctx(ethan, 5), { entryId: id, title: "Setup", body: "Wi-Fi: ask a mentor." });
    const [edit] = await t.db.notebookEntryEdit.findMany({ where: { entryId: id } });

    // Only whoever can change the entry.
    for (const a of [isabella, maya, priya]) {
      await forbidden(clearNotebookEntryVersion(ctx(a), { editId: edit.id }), NOTEBOOK_ENTRY_CANT_EDIT);
    }
    await forbidden(clearNotebookEntryVersion(ctx(pending), { editId: edit.id }), NOTEBOOK_INACTIVE);
    await expect(clearNotebookEntryVersion(ctx(marcus), { editId: "gone" })).rejects.toThrow(NOTEBOOK_VERSION_NOT_FOUND);

    expect(await clearNotebookEntryVersion(ctx(marcus, 10), { editId: edit.id })).toEqual({ entryId: id, pageId: intake });
    const row = await t.db.notebookEntryEdit.findUniqueOrThrow({ where: { id: edit.id } });
    expect(row).toMatchObject({ previousTitle: "", previousBody: "", editorId: ethan.id, editedAt: new Date(TEST_NOW.getTime() + 5 * 60_000) });
    const history = (await getNotebookEntryHistory(maya, id, t.db))!;
    expect(history.historyCount).toBe(1);
    expect(isClearedNotebookVersion({ title: history.versions[0].previousTitle, body: history.versions[0].previousBody })).toBe(true);
    expect(JSON.stringify(history)).not.toContain("hunter2");
    // The entry itself doesn't change.
    expect(await t.db.notebookEntry.findUniqueOrThrow({ where: { id } })).toMatchObject({ body: "Wi-Fi: ask a mentor.", lastEditedById: ethan.id });
  });

  it("only the author and the notebook's page managers change or delete an entry", async () => {
    const { id } = await write(ethan, intake, "Ethan's entry");
    for (const a of [isabella, maya, ava, priya, amara]) {
      await forbidden(updateNotebookEntry(ctx(a), { entryId: id, body: "Hijacked" }), NOTEBOOK_ENTRY_CANT_EDIT);
      await forbidden(deleteNotebookEntry(ctx(a), { entryId: id }), NOTEBOOK_ENTRY_CANT_EDIT);
    }
    for (const a of [pending, disabled, pendingLeader]) {
      await forbidden(updateNotebookEntry(ctx(a), { entryId: id, body: "Hijacked" }), NOTEBOOK_INACTIVE);
    }
    for (const a of [ethan, marcus, jordan, elena, david, olivia]) {
      await updateNotebookEntry(ctx(a), { entryId: id, body: `Edited by ${a.name}` });
    }
    expect(await t.db.notebookEntryEdit.count({ where: { entryId: id } })).toBe(6);

    // Software's leader manages Software's notebook, not Build's.
    const sw = await write(maya, competition, "Maya's entry");
    await updateNotebookEntry(ctx(priya), { entryId: sw.id, body: "Priya fixed it" });
    await forbidden(updateNotebookEntry(ctx(marcus), { entryId: sw.id, body: "Nope" }), NOTEBOOK_ENTRY_CANT_EDIT);

    await forbidden(deleteNotebookEntry(ctx(isabella), { entryId: id }));
    expect(await deleteNotebookEntry(ctx(ethan), { entryId: id })).toEqual({ pageId: intake });
    expect(await t.db.notebookEntryEdit.count({ where: { entryId: id } })).toBe(0);
    await expect(deleteNotebookEntry(ctx(ethan), { entryId: id })).rejects.toBeInstanceOf(NotFoundError);
    await expect(updateNotebookEntry(ctx(ethan), { entryId: id, body: "x" })).rejects.toBeInstanceOf(NotFoundError);
    await deleteNotebookEntry(ctx(marcus), { entryId: (await write(isabella, intake)).id });
  });

  it("writing is rate-limited per person", async () => {
    const key = `notebook-write:${ava.id}`;
    const full = { count: NOTEBOOK_WRITE_RATE_LIMIT.limit, windowStart: TEST_NOW };
    await t.db.rateLimit.upsert({ where: { key }, create: { key, ...full }, update: full });
    await expect(write(ava, intake)).rejects.toBeInstanceOf(RateLimitError);
    await t.db.rateLimit.deleteMany({ where: { key } });
    await write(ava, intake);
  });
});

// ── Reading ──────────────────────────────────────────────────────────────────

describe("reading the notebook", () => {
  let hwId: string;
  let intake: string;
  let outtake: string;

  beforeAll(async () => {
    await t.db.notebook.deleteMany();
    await createStandardNotebooks(ctx(jordan));
    const hw = await t.db.notebook.findFirstOrThrow({ where: { subteam: "BUILD" }, include: { pages: { orderBy: { position: "asc" } } } });
    hwId = hw.id;
    [intake, outtake] = hw.pages.map((p) => p.id);
    await write(ethan, intake, "Oldest", "", 0);
    await write(isabella, intake, "Middle", "", 10);
    await write(ethan, intake, "Newest", "", 20);
    await write(maya, outtake, "Outtake note", "", 5);
  });

  it("the outline lists notebooks and pages in order with counts, and who manages what", async () => {
    const outline = (await getNotebookOutline(marcus, t.db))!;
    expect(outline.canManageNotebooks).toBe(false);
    expect(outline.notebooks.map((n) => [n.title, n.canManagePages, n.entryCount])).toEqual([
      ["Hardware Notebook", true, 4],
      ["Software Notebook", false, 0],
      ["Business Notebook", false, 0],
    ]);
    expect(outline.notebooks[0].pages).toEqual([
      { id: intake, title: "Intake", entryCount: 3, lastEntryAt: new Date(TEST_NOW.getTime() + 20 * 60_000) },
      { id: outtake, title: "Outtake", entryCount: 1, lastEntryAt: new Date(TEST_NOW.getTime() + 5 * 60_000) },
    ]);
    expect((await getNotebookOutline(jordan, t.db))!.notebooks.every((n) => n.canManagePages)).toBe(true);
    expect((await getNotebookOutline(ethan, t.db))!.notebooks.some((n) => n.canManagePages)).toBe(false);
    expect(await getNotebookOutline(pending, t.db)).toBeNull();
  });

  it("a page shows its entries newest first, or oldest first", async () => {
    const newest = (await getNotebookPageView(ethan, intake, { order: "newest" }, t.db))!;
    expect(newest.entries.map((e) => e.body)).toEqual(["Newest", "Middle", "Oldest"]);
    expect(newest.entries.map((e) => [e.mine, e.canEdit])).toEqual([
      [true, true],
      [false, false],
      [true, true],
    ]);
    expect(newest).toMatchObject({ entryCount: 3, screen: 1, screenCount: 1, notebook: { id: hwId, title: "Hardware Notebook", emoji: "👷" } });
    const oldest = (await getNotebookPageView(marcus, intake, { order: "oldest" }, t.db))!;
    expect(oldest.entries.map((e) => e.body)).toEqual(["Oldest", "Middle", "Newest"]);
    expect(oldest.entries.every((e) => e.canEdit)).toBe(true);
    expect(oldest.canManagePages).toBe(true);
    expect(await getNotebookPageView(ethan, "gone", { order: "newest" }, t.db)).toBeNull();
    expect(await getNotebookPageView(pending, intake, { order: "newest" }, t.db)).toBeNull();
  });

  it("the latest entries across notebooks, newest first", async () => {
    const latest = await getLatestNotebookEntries(ava, 2, t.db);
    expect(latest.map((e) => [e.snippet, e.pageTitle, e.notebookTitle, e.authorName])).toEqual([
      ["Newest", "Intake", "Hardware Notebook", "Ethan Chen"],
      ["Middle", "Intake", "Hardware Notebook", "Isabella Rossi"],
    ]);
    expect(await getLatestNotebookEntries(disabled, 5, t.db)).toEqual([]);
  });
});

// ── Pictures ─────────────────────────────────────────────────────────────────

describe("pictures", () => {
  let intake: string;
  let competition: string;

  beforeAll(async () => {
    await t.db.notebook.deleteMany();
    intake = (await notebookWithPages("BUILD", "Hardware Notebook", ["Intake"])).pages[0].id;
    competition = (await notebookWithPages("SOFTWARE", "Software Notebook", ["Competition"])).pages[0].id;
  });

  async function pictureErrorOf(p: Promise<unknown>) {
    return (await validationOf(p)).fieldErrors.file;
  }

  it("adds PNG, JPG, GIF, and WebP pictures, checked by their contents, with their size in pixels", async () => {
    const { id } = await write(ethan, intake);
    await addNotebookImage(ctx(ethan), { entryId: id, file: picture("cad.png", PNG) });
    await addNotebookImage(ctx(ethan), { entryId: id, file: picture("IMG_0001.HEIC", jpegOf(1600, 1200), "image/heic") });
    await addNotebookImage(ctx(ethan), { entryId: id, file: picture("spin", GIF, "") });
    await addNotebookImage(ctx(ethan), { entryId: id, file: picture("photo.webp", WEBP, "image/webp") });
    const rows = await t.db.notebookImage.findMany({ where: { entryId: id }, orderBy: { position: "asc" } });
    expect(rows.map((r) => [r.filename, r.contentType, r.width, r.height, r.position, r.size])).toEqual([
      ["cad.png", "image/png", 1, 1, 0, PNG.byteLength],
      ["IMG_0001.jpg", "image/jpeg", 1600, 1200, 1, jpegOf(1600, 1200).byteLength],
      ["spin.gif", "image/gif", 2, 3, 2, GIF.byteLength],
      ["photo.webp", "image/webp", 1, 1, 3, WEBP.byteLength],
    ]);
    // Added by the author right after writing it: part of writing it, not an edit.
    expect((await t.db.notebookEntry.findUniqueOrThrow({ where: { id } })).lastEditedAt).toBeNull();

    // The picture route: any active person, never anyone else.
    const img = await getNotebookImage(maya, rows[0].id, t.db);
    expect(img).toMatchObject({ filename: "cad.png", contentType: "image/png" });
    expect(Buffer.from(img!.data).equals(Buffer.from(PNG))).toBe(true);
    expect(await getNotebookImage(pending, rows[0].id, t.db)).toBeNull();
    expect(await getNotebookImage(maya, "gone", t.db)).toBeNull();
  });

  it("refuses anything that isn't really a picture, or is too big", async () => {
    const { id } = await write(ethan, intake);
    const add = (f: unknown) => addNotebookImage(ctx(ethan), { entryId: id, file: f });
    expect(await pictureErrorOf(add(picture("logo.svg", "<svg xmlns='http://www.w3.org/2000/svg'/>", "image/svg+xml")))).toBe(NOTEBOOK_PICTURE_TYPES_MESSAGE);
    expect(await pictureErrorOf(add(picture("page.png", "<html><body>hi</body></html>")))).toBe(NOTEBOOK_PICTURE_TYPES_MESSAGE);
    expect(await pictureErrorOf(add(picture("flyer.pdf", PDF, "application/pdf")))).toBe(NOTEBOOK_PICTURE_TYPES_MESSAGE);
    expect(await pictureErrorOf(add(picture("IMG.HEIC", HEIC, "image/heic")))).toBe(NOTEBOOK_PICTURE_HEIC_MESSAGE);
    expect(await pictureErrorOf(add(picture("run.exe", PNG)))).toBe(NOTEBOOK_PICTURE_TYPES_MESSAGE);
    expect(await pictureErrorOf(add(picture("broken.png", Uint8Array.from([...PNG_SIG, 1, 2, 3]))))).toBe(NOTEBOOK_PICTURE_UNREADABLE_MESSAGE);
    expect(await pictureErrorOf(add(picture("huge.png", pngOf(30_000, 30_000))))).toMatch(/^That picture is 30,000 × 30,000 pixels/);
    const big = new Uint8Array(LIMITS.resourceFileMaxBytes + 1);
    big.set(PNG);
    expect(await pictureErrorOf(add(picture("big.png", big)))).toMatch(/^That picture is 4\.0 MB/);
    expect(await pictureErrorOf(add(picture("empty.png", new Uint8Array())))).toMatch(/empty/);
    expect(await pictureErrorOf(add(undefined))).toBe("Choose a picture to add.");
    expect(await t.db.notebookImage.count({ where: { entryId: id } })).toBe(0);
  });

  it("only whoever can change the entry adds or takes off its pictures", async () => {
    const { id } = await write(ethan, intake);
    for (const a of [isabella, maya, priya]) {
      await forbidden(addNotebookImage(ctx(a), { entryId: id, file: picture() }), NOTEBOOK_ENTRY_CANT_EDIT);
    }
    await forbidden(addNotebookImage(ctx(pending), { entryId: id, file: picture() }), NOTEBOOK_INACTIVE);
    const mine = await addNotebookImage(ctx(ethan), { entryId: id, file: picture() });
    await forbidden(removeNotebookImage(ctx(isabella), { imageId: mine.id }), NOTEBOOK_ENTRY_CANT_EDIT);
    await expect(addNotebookImage(ctx(ethan), { entryId: "gone", file: picture() })).rejects.toBeInstanceOf(NotFoundError);

    // A leader adding one marks it edited by them.
    await addNotebookImage(ctx(marcus, 5), { entryId: id, file: picture("leader.png") });
    expect(await t.db.notebookEntry.findUniqueOrThrow({ where: { id } })).toMatchObject({
      lastEditedById: marcus.id,
      lastEditedAt: new Date(TEST_NOW.getTime() + 5 * 60_000),
    });
    expect(await removeNotebookImage(ctx(ethan, 6), { imageId: mine.id })).toEqual({ entryId: id, filename: "intake.png" });
    expect((await t.db.notebookEntry.findUniqueOrThrow({ where: { id } })).lastEditedById).toBe(ethan.id);
    await expect(removeNotebookImage(ctx(ethan), { imageId: mine.id })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("the author's picture changes count as edits once they're done writing it", async () => {
    const { id } = await write(isabella, intake);
    const later = NOTEBOOK_WRITING_WINDOW_MS / 60_000 + 1;
    await addNotebookImage(ctx(isabella, later), { entryId: id, file: picture() });
    expect(await t.db.notebookEntry.findUniqueOrThrow({ where: { id } })).toMatchObject({
      lastEditedById: isabella.id,
      lastEditedAt: new Date(TEST_NOW.getTime() + later * 60_000),
    });
  });

  it("picture changes by someone else show in the history as 'changed the pictures', one line per save", async () => {
    const { id } = await write(ethan, intake, "Roller test", "Intake");
    const mine = await addNotebookImage(ctx(ethan), { entryId: id, file: picture("roller.png") });
    expect(await t.db.notebookEntryEdit.count({ where: { entryId: id } })).toBe(0); // still writing it

    // A Build leader takes Ethan's picture off and adds two others in one save: one history line.
    await removeNotebookImage(ctx(marcus, 30), { imageId: mine.id });
    await addNotebookImage(ctx(marcus, 30), { entryId: id, file: picture("a.png") });
    await addNotebookImage(ctx(marcus, 31), { entryId: id, file: picture("b.png") });
    let edits = await t.db.notebookEntryEdit.findMany({ where: { entryId: id } });
    expect(edits.map((e) => [e.editorId, e.previousTitle, e.previousBody, e.editedAt.getTime() - TEST_NOW.getTime()])).toEqual([
      [marcus.id, "Intake", "Roller test", 31 * 60_000],
    ]);
    const history = (await getNotebookEntryHistory(ethan, id, t.db))!;
    const [row] = history.versions;
    expect(notebookChangeLabel({ title: row.previousTitle, body: row.previousBody }, history)).toBe("changed the pictures");
    expect(await t.db.notebookEntry.findUniqueOrThrow({ where: { id } })).toMatchObject({
      lastEditedById: marcus.id,
      lastEditedAt: new Date(TEST_NOW.getTime() + 31 * 60_000),
    });

    // Later (or someone else, or after a text change): its own line.
    const later = 31 + NOTEBOOK_PICTURE_EDIT_MERGE_MS / 60_000 + 1;
    await addNotebookImage(ctx(marcus, later), { entryId: id, file: picture("c.png") });
    await updateNotebookEntry(ctx(ethan, later + 1), { entryId: id, title: "Intake", body: "Roller test, v2" });
    await addNotebookImage(ctx(ethan, later + 2), { entryId: id, file: picture("d.png") });
    edits = await t.db.notebookEntryEdit.findMany({ where: { entryId: id }, orderBy: { editedAt: "asc" } });
    expect(edits.map((e) => [e.editorId, e.previousBody])).toEqual([
      [marcus.id, "Roller test"],
      [marcus.id, "Roller test"],
      [ethan.id, "Roller test"],
      [ethan.id, "Roller test, v2"],
    ]);
    const labels = (await getNotebookEntryHistory(ethan, id, t.db))!;
    const after = (i: number) =>
      i === 0 ? labels : { title: labels.versions[i - 1].previousTitle, body: labels.versions[i - 1].previousBody };
    expect(labels.versions.map((v, i) => notebookChangeLabel({ title: v.previousTitle, body: v.previousBody }, after(i)))).toEqual([
      "changed the pictures",
      "changed the text",
      "changed the pictures",
      "changed the pictures",
    ]);
  });

  it(`an entry holds at most ${LIMITS.notebookImagesPerEntry} pictures`, async () => {
    const { id } = await write(marcus, intake);
    for (let i = 0; i < LIMITS.notebookImagesPerEntry; i++) {
      await addNotebookImage(ctx(marcus), { entryId: id, file: picture(`p${i}.png`) });
    }
    expect(await pictureErrorOf(addNotebookImage(ctx(marcus), { entryId: id, file: picture("one-more.png") }))).toBe(
      notebookPicturesFullMessage(),
    );
    expect(await t.db.notebookImage.count({ where: { entryId: id } })).toBe(LIMITS.notebookImagesPerEntry);
  });

  it("each person's pictures stay under the per-person cap, unless they manage the notebook's pages", async () => {
    const { id } = await write(maya, competition);
    // Maya already has nearly the whole allowance in pictures (only the size column counts).
    await t.db.notebookImage.create({
      data: { entryId: id, filename: "old.png", contentType: "image/png", size: NOTEBOOK_IMAGE_BYTES_PER_PERSON - 10, data: PNG },
    });
    expect(await pictureErrorOf(addNotebookImage(ctx(maya), { entryId: id, file: picture() }))).toMatch(
      /^Your notebook pictures use 25 MB, and each person can have up to 25 MB\./,
    );
    // Software's leader (who manages this notebook) can still add it.
    await addNotebookImage(ctx(priya), { entryId: id, file: picture() });
    await t.db.notebookImage.deleteMany({ where: { entryId: id } });
  });

  it("counts toward the team's shared file storage, and stops when it's full", async () => {
    const { id } = await write(jordan, intake);
    const before = await fileStorageUsage(t.db);
    await addNotebookImage(ctx(jordan), { entryId: id, file: picture() });
    const after = await fileStorageUsage(t.db);
    expect(after.notebook - before.notebook).toBe(PNG.byteLength);
    expect(after.used - before.used).toBe(PNG.byteLength);

    const filler = await t.db.notebookImage.create({
      data: { entryId: id, filename: "filler.png", contentType: "image/png", size: LIMITS.resourceStorageMaxBytes - after.used, data: PNG },
    });
    const full = await pictureErrorOf(addNotebookImage(ctx(jordan), { entryId: id, file: picture() }));
    expect(full).toMatch(/^The team's file storage is full: .* of notebook pictures\. Take off notebook pictures you don't need/);
    await t.db.notebookImage.delete({ where: { id: filler.id } });
    await addNotebookImage(ctx(jordan), { entryId: id, file: picture() });
  });
});

// ── Export ───────────────────────────────────────────────────────────────────

async function documentXml(buffer: Buffer): Promise<{ xml: string; media: string[] }> {
  const zip = await JSZip.loadAsync(buffer);
  const xml = await zip.file("word/document.xml")!.async("string");
  const media = Object.keys(zip.files).filter((name) => name.startsWith("word/media/") && !name.endsWith("/"));
  return { xml, media };
}

describe("export", () => {
  let notebookId: string;
  let intake: string;

  beforeAll(async () => {
    await t.db.notebook.deleteMany();
    const { notebook, pages } = await notebookWithPages("BUILD", "Hardware Notebook", ["Intake", "Outtake"]);
    await t.db.notebook.update({ where: { id: notebook.id }, data: { emoji: "👷", description: "Build's engineering notebook" } });
    notebookId = notebook.id;
    intake = pages[0].id;
    const first = await write(ethan, intake, "Goals for the roller:\n- grab from the wall\n- no jams\nResult: works at 80% \u0007power.", "Roller test");
    await addNotebookImage(ctx(ethan), { entryId: first.id, file: picture("roller.png") });
    await addNotebookImage(ctx(ethan), { entryId: first.id, file: picture("photo.webp", WEBP, "image/webp") });
    await updateNotebookEntry(ctx(marcus, 45), { entryId: first.id, title: "Roller test", body: "Goals for the roller:\n- grab from the wall\n- no jams\nResult: works at 80% power & <fast>." });
    await write(isabella, intake, "Second entry without a title.", "", 60);
  });

  it("gathers a notebook (or one page) with each page's entries oldest first", async () => {
    const data = (await getNotebookExport(ava, { notebookId }, t.db))!;
    expect(data.scope).toBe("notebook");
    expect(data.pages.map((p) => [p.title, p.entries.map((e) => e.authorName)])).toEqual([
      ["Intake", ["Ethan Chen", "Isabella Rossi"]],
      ["Outtake", []],
    ]);
    expect(data.pages[0].entries[0]).toMatchObject({ title: "Roller test", lastEditedByName: "Marcus Johnson" });
    expect(data.pages[0].entries[0].images.map((i) => i.filename)).toEqual(["roller.png", "photo.webp"]);
    const page = (await getNotebookExport(ava, { pageId: intake }, t.db))!;
    expect(page.scope).toBe("page");
    expect(page.pages.map((p) => p.title)).toEqual(["Intake"]);
    expect(await getNotebookExport(pending, { notebookId }, t.db)).toBeNull();
    expect(await getNotebookExport(ava, { notebookId: "gone" }, t.db)).toBeNull();
  });

  it("builds a Word file: title page, pages as Heading 1, entries as Heading 2 with stamps, text, pictures, and edits", async () => {
    const data = (await getNotebookExport(ava, { notebookId }, t.db))!;
    const { included, leftOut } = pickExportImages(data);
    expect(leftOut).toBe(1); // the WebP
    const bytes = await loadNotebookImageBytes([...included], t.db);
    const buffer = await buildNotebookDocx(data, { timeZone: TEST_TZ, now: TEST_NOW, imageBytes: bytes, leftOut });
    expect(buffer.subarray(0, 2).toString()).toBe("PK");
    const { xml, media } = await documentXml(buffer);
    for (const text of [
      "FTC 19516 The Huskyteers",
      "👷 Hardware Notebook",
      "Build&apos;s engineering notebook",
      "Exported Thu, Sep 24, 2026",
      "2 pages · 2 entries",
      "Intake",
      "Outtake",
      "No entries yet.",
      "Roller test",
      "Written by Ethan Chen · Thu, Sep 24, 2026, 12:00 PM",
      "Goals for the roller:",
      "grab from the wall",
      "Result: works at 80% power &amp; &lt;fast&gt;.",
      "Edited by Marcus Johnson on Thu, Sep 24, 2026, 12:45 PM",
      "Written by Isabella Rossi · Thu, Sep 24, 2026, 1:00 PM",
      "Second entry without a title.",
      "[Picture: photo.webp — see it in the Team notebook]",
    ]) {
      expect(xml, text).toContain(text);
    }
    expect(xml).toMatch(/w:pStyle w:val="Heading1"/);
    expect(xml).toMatch(/w:pStyle w:val="Heading2"/);
    expect(xml).toMatch(/w:numPr/); // the bullet list
    expect(media).toHaveLength(1);
    expect(notebookDocxFilename(data, TEST_TZ, TEST_NOW)).toBe("Hardware Notebook 2026-09-24.docx");
  });

  it("control characters never reach the file (Word refuses them)", async () => {
    const data = (await getNotebookExport(ava, { pageId: intake }, t.db))!;
    data.pages[0].entries[0].body = "bell \u0007 and \u0000 nul";
    const buffer = await buildNotebookDocx(data, { timeZone: TEST_TZ, now: TEST_NOW, imageBytes: new Map() });
    const { xml } = await documentXml(buffer);
    expect(xml).toContain("bell  and  nul");
    expect(xml).not.toMatch(/[\u0000\u0007]/);
  });

  it("leaves pictures out past the size budget, in reading order", () => {
    const image = (id: string, size: number, contentType = "image/jpeg") => ({ id, src: "", filename: `${id}.jpg`, contentType, size, width: 10, height: 10 });
    const entry = (images: ReturnType<typeof image>[]) => ({
      id: "e",
      title: "",
      body: "x",
      authorName: null,
      createdAt: TEST_NOW,
      lastEditedAt: null,
      lastEditedByName: null,
      images,
    });
    const data: NotebookExport = {
      scope: "notebook",
      notebook: { id: "n", title: "N", emoji: "", description: "", subteam: null },
      pages: [{ id: "p", title: "P", entries: [entry([image("a", 2_000_000), image("b", 2_000_000)]), entry([image("c", 1_000_000)])] }],
    };
    const { included, leftOut } = pickExportImages(data, NOTEBOOK_EXPORT_IMAGE_BUDGET);
    expect([...included]).toEqual(["a", "c"]);
    expect(leftOut).toBe(1);
  });

  it("sends the file as a download", async () => {
    const data = (await getNotebookExport(ava, { pageId: intake }, t.db))!;
    const res = await notebookDocxResponse(data, TEST_TZ, TEST_NOW, t.db);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(DOCX_CONTENT_TYPE);
    expect(res.headers.get("content-disposition")).toBe(
      `attachment; filename="Hardware Notebook - Intake 2026-09-24.docx"; filename*=UTF-8''Hardware%20Notebook%20-%20Intake%202026-09-24.docx`,
    );
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const { xml, media } = await documentXml(Buffer.from(await res.arrayBuffer()));
    expect(xml).toContain("Roller test");
    expect(media).toHaveLength(1);
  });

  it("a page whose name would split an emoji still downloads", async () => {
    const { notebook, pages } = await notebookWithPages("BUILD", "A".repeat(80), [`${"B".repeat(16)}🔧 Intake`]);
    const data = (await getNotebookExport(ava, { pageId: pages[0].id }, t.db))!;
    const res = await notebookDocxResponse(data, TEST_TZ, TEST_NOW, t.db);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain(`filename*=UTF-8''${"A".repeat(80)}%20-%20${"B".repeat(16)}%F0%9F%94%A7%202026-09-24.docx`);
    await t.db.notebook.delete({ where: { id: notebook.id } });
  });

  it("links in the text are clickable in the Word file", async () => {
    const data = (await getNotebookExport(ava, { pageId: intake }, t.db))!;
    data.pages[0].entries[0].body = "Link to CAD: https://cad.onshape.com/documents/abc123.\n- parts: https://example.com/a?b=1&c=2";
    const buffer = await buildNotebookDocx(data, { timeZone: TEST_TZ, now: TEST_NOW, imageBytes: new Map() });
    const zip = await JSZip.loadAsync(buffer);
    const xml = await zip.file("word/document.xml")!.async("string");
    const rels = await zip.file("word/_rels/document.xml.rels")!.async("string");
    expect(xml.match(/<w:hyperlink /g)).toHaveLength(2);
    expect(xml).toContain("Link to CAD: ");
    expect(xml).toContain(">https://cad.onshape.com/documents/abc123<");
    expect(rels).toContain('Target="https://cad.onshape.com/documents/abc123"');
    expect(rels).toContain('Target="https://example.com/a?b=1&amp;c=2"');
    expect(rels).toContain('TargetMode="External"');
  });

  it("stays under the download limit: fewer pictures when there's lots of text, a message when the text alone is too big", async () => {
    const { notebook, pages } = await notebookWithPages("BUILD", "Big notebook", ["Photos"]);
    const { id } = await write(ethan, pages[0].id, "Lots of photos.");
    for (const name of ["one.jpg", "two.jpg"]) {
      const bytes = Uint8Array.from(randomBytes(200_000)); // random bytes don't compress
      await t.db.notebookImage.create({
        data: { entryId: id, filename: name, contentType: "image/jpeg", size: bytes.byteLength, data: bytes, width: 10, height: 10 },
      });
    }
    const data = (await getNotebookExport(ava, { pageId: pages[0].id }, t.db))!;
    const opts = { timeZone: TEST_TZ, now: TEST_NOW };

    const everything = (await buildNotebookDocxWithin(data, { ...opts, maxBytes: 10_000_000 }, t.db))!;
    expect((await documentXml(everything)).media).toHaveLength(2);

    const one = (await buildNotebookDocxWithin(data, { ...opts, maxBytes: 300_000 }, t.db))!;
    expect(one.byteLength).toBeLessThanOrEqual(300_000);
    const oneXml = await documentXml(one);
    expect(oneXml.media).toHaveLength(1);
    expect(oneXml.xml).toContain("1 picture is not in this file");
    expect(oneXml.xml).toContain("[Picture: two.jpg — see it in the Team notebook]");

    const textOnly = await buildNotebookDocx(data, { ...opts, imageBytes: new Map(), leftOut: 2 });
    const none = (await buildNotebookDocxWithin(data, { ...opts, maxBytes: textOnly.byteLength + 500 }, t.db))!;
    expect((await documentXml(none)).media).toHaveLength(0);

    expect(await buildNotebookDocxWithin(data, { ...opts, maxBytes: 1_000 }, t.db)).toBeNull();
    const res = await notebookDocxResponse(data, TEST_TZ, TEST_NOW, t.db, 1_000);
    expect(res.status).toBe(413);
    expect(await res.text()).toMatch(/^This page has too much text for one Word file\./);
    await t.db.notebook.delete({ where: { id: notebook.id } });
  });
});
