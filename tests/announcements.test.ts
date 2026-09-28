import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Subteam } from "@/generated/prisma/enums";
import {
  announcementCountText,
  announcementFocusHref,
  announcementsHref,
  audienceLabel,
  audienceValue,
  isNewAnnouncement,
  mergeAnnouncementEdits,
  parseAnnouncementFilters,
  submittedAnnouncementValues,
} from "@/lib/announcements";
import type { Actor } from "@/server/actor";
import type { Db } from "@/server/db";
import { ConflictError, ForbiddenError, NotFoundError, RateLimitError, ValidationError } from "@/server/errors";
import { announcementAudiences, canEditAnnouncement, canPostAnnouncement } from "@/server/permissions";
import {
  ANNOUNCEMENTS_PAGE_SIZE,
  announcementsForYouWhere,
  countUnreadAnnouncements,
  getAnnouncement,
  getAnnouncementFormValues,
  getAnnouncementsSeenSince,
  isAnnouncementForYou,
  listAnnouncements,
  listUnreadAnnouncements,
} from "@/server/queries/announcements";
import {
  ANNOUNCEMENT_BUSY,
  ANNOUNCEMENT_CHANGED,
  ANNOUNCEMENT_CHANGED_BEFORE_REMOVE,
  ANNOUNCEMENT_RATE_LIMIT,
  ANNOUNCEMENTS_SEEN_MARGIN_MS,
  createAnnouncement,
  deleteAnnouncement,
  markAnnouncementsSeen,
  setAnnouncementPinned,
  updateAnnouncement,
} from "@/server/services/announcements";
import { createTestDb, type TestDb } from "./helpers/db";
import { contextFor, makeUser, TEST_NOW } from "./helpers/factories";

type Who =
  | "owner"
  | "captain"
  | "mentor"
  | "teacher"
  | "swLead"
  | "buildLead"
  | "buildLead2"
  | "bizLead"
  | "swMember"
  | "buildMember"
  | "bizMember"
  | "noSubteam"
  | "pendingLead"
  | "disabledMentor";

let t: TestDb;
let p: Record<Who, Actor>;

const HOUR = 60 * 60 * 1000;
const ago = (hours: number) => new Date(TEST_NOW.getTime() - hours * HOUR);

async function makePeople(db: Db): Promise<Record<Who, Actor>> {
  return {
    owner: await makeUser(db, { role: "MEMBER", subteam: "SOFTWARE", isAdmin: true, name: "Olive Owner" }),
    captain: await makeUser(db, { role: "CAPTAIN", name: "Casey Captain" }),
    mentor: await makeUser(db, { role: "MENTOR", name: "Mia Mentor" }),
    teacher: await makeUser(db, { role: "TEACHER", name: "Theo Teacher" }),
    swLead: await makeUser(db, { role: "SOFTWARE_LEADER", name: "Sam Lead" }),
    buildLead: await makeUser(db, { role: "BUILD_LEADER", name: "Blake Lead" }),
    buildLead2: await makeUser(db, { role: "BUILD_LEADER", name: "Bea Lead" }),
    bizLead: await makeUser(db, { role: "BUSINESS_LEADER", name: "Amara Lead" }),
    swMember: await makeUser(db, { role: "MEMBER", subteam: "SOFTWARE", name: "Maya Software" }),
    buildMember: await makeUser(db, { role: "MEMBER", subteam: "BUILD", name: "Ethan Build" }),
    bizMember: await makeUser(db, { role: "MEMBER", subteam: "BUSINESS", name: "Gwen Business" }),
    noSubteam: await makeUser(db, { role: "MEMBER", subteam: null, name: "Nia Nosubteam" }),
    pendingLead: await makeUser(db, { role: "BUILD_LEADER", status: "PENDING", name: "Pat Pending" }),
    disabledMentor: await makeUser(db, { role: "MENTOR", status: "DISABLED", name: "Dana Disabled" }),
  };
}

beforeAll(async () => {
  t = await createTestDb();
  p = await makePeople(t.db);
  // Everyone joined a month before the test clock (unread counts fall back to when the account was created).
  await t.db.user.updateMany({ data: { createdAt: ago(24 * 30) } });
});

afterAll(async () => {
  await t?.drop();
});

beforeEach(async () => {
  await t.db.rateLimit.deleteMany();
});

const ctxFor = (a: Actor, now: Date = TEST_NOW) => ({ ...contextFor(t.db, a), now });

const input = (over: Record<string, unknown> = {}) => ({
  title: "No meeting on Thursday",
  body: "The school is closed for the holiday. See you Monday!",
  audience: "team",
  ...over,
});

/** An announcement straight in the DB (bypassing the service). */
async function makeAnnouncement(
  author: Actor | null,
  opts: { subteam?: Subteam | null; createdAt?: Date; pinned?: boolean; title?: string; body?: string } = {},
) {
  const createdAt = opts.createdAt ?? ago(1);
  return t.db.announcement.create({
    data: {
      title: opts.title ?? "Heads up",
      body: opts.body ?? "Something the team should know.",
      subteam: opts.subteam ?? null,
      pinned: opts.pinned ?? false,
      authorId: author?.id ?? null,
      createdAt,
      updatedAt: createdAt,
    },
  });
}

/** The edit form's fields for an announcement as it is now (plus overrides). */
async function editInput(id: string, over: Record<string, unknown> = {}) {
  const row = await t.db.announcement.findUniqueOrThrow({ where: { id } });
  return {
    announcementId: id,
    version: row.updatedAt.toISOString(),
    title: row.title,
    body: row.body,
    audience: row.subteam ?? "team",
    ...(row.pinned ? { pinned: "on" } : {}),
    ...over,
  };
}

async function fieldError(promise: Promise<unknown>, field: string): Promise<string | undefined> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ValidationError);
  return (err as ValidationError).fieldErrors[field];
}

async function setSeen(who: Actor, at: Date | null) {
  await t.db.user.update({ where: { id: who.id }, data: { announcementsSeenAt: at } });
}

// ── Permissions ──────────────────────────────────────────────────────────────

describe("who can post", () => {
  it("every leader, the captain, mentors, teachers, and owners post; members don't", () => {
    for (const who of ["owner", "captain", "mentor", "teacher", "swLead", "buildLead", "bizLead"] as const) {
      expect(canPostAnnouncement(p[who]), who).toBe(true);
    }
    for (const who of ["swMember", "buildMember", "bizMember", "noSubteam"] as const) {
      expect(canPostAnnouncement(p[who]), who).toBe(false);
      expect(announcementAudiences(p[who]), who).toEqual([]);
    }
    expect(announcementAudiences(p.captain)).toEqual([null, "SOFTWARE", "BUILD", "BUSINESS"]);
    expect(announcementAudiences(p.owner)).toEqual([null, "SOFTWARE", "BUILD", "BUSINESS"]);
    expect(announcementAudiences(p.buildLead)).toEqual([null, "BUILD"]);
    expect(announcementAudiences(p.swLead)).toEqual([null, "SOFTWARE"]);
  });

  it("posts for the whole team (the author, time, and pin come from the server)", async () => {
    const { id } = await createAnnouncement(ctxFor(p.buildLead), input({ title: "  Safety glasses  ", pinned: "on", authorId: p.captain.id }));
    const row = await t.db.announcement.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({
      title: "Safety glasses",
      subteam: null,
      pinned: true,
      authorId: p.buildLead.id,
      editedAt: null,
      createdAt: TEST_NOW,
      updatedAt: TEST_NOW,
    });
  });

  it("lets a subteam leader post for the whole team or their own subteam only", async () => {
    await expect(createAnnouncement(ctxFor(p.buildLead), input({ audience: "BUILD" }))).resolves.toHaveProperty("id");
    for (const audience of ["SOFTWARE", "BUSINESS"]) {
      await expect(createAnnouncement(ctxFor(p.buildLead), input({ audience }))).rejects.toThrow(
        "You can post for the whole team or Build.",
      );
    }
    await expect(createAnnouncement(ctxFor(p.swLead), input({ audience: "BUILD" }))).rejects.toThrow(ForbiddenError);
    await expect(createAnnouncement(ctxFor(p.bizLead), input({ audience: "BUSINESS" }))).resolves.toHaveProperty("id");
  });

  it("lets the captain, mentors, teachers, and owners post for anyone", async () => {
    for (const who of ["captain", "mentor", "teacher", "owner"] as const) {
      for (const audience of ["team", "SOFTWARE", "BUILD", "BUSINESS"]) {
        const { id } = await createAnnouncement(ctxFor(p[who]), input({ audience, title: `${who} → ${audience}` }));
        const row = await t.db.announcement.findUniqueOrThrow({ where: { id } });
        expect(row.subteam, `${who} ${audience}`).toBe(audience === "team" ? null : audience);
      }
    }
  });

  it("refuses members, and pending or disabled accounts (whatever their position)", async () => {
    for (const who of ["swMember", "buildMember", "bizMember", "noSubteam"] as const) {
      await expect(createAnnouncement(ctxFor(p[who]), input()), who).rejects.toThrow(ForbiddenError);
    }
    await expect(createAnnouncement(ctxFor(p.pendingLead), input())).rejects.toThrow("Your account isn't active.");
    await expect(createAnnouncement(ctxFor(p.disabledMentor), input())).rejects.toThrow("Your account isn't active.");
  });

  it("is rate limited per person (only posts that pass the checks count)", async () => {
    const busy = await makeUser(t.db, { role: "CAPTAIN", name: "Busy Captain" });
    await t.db.rateLimit.create({
      data: { key: `announcement:${busy.id}`, count: ANNOUNCEMENT_RATE_LIMIT.limit - 1, windowStart: TEST_NOW },
    });
    await expect(createAnnouncement(ctxFor(busy), input({ title: "" }))).rejects.toThrow(ValidationError);
    await expect(createAnnouncement(ctxFor(busy), input())).resolves.toHaveProperty("id");
    await expect(createAnnouncement(ctxFor(busy), input())).rejects.toThrow(RateLimitError);
    expect(await t.db.announcement.count({ where: { authorId: busy.id } })).toBe(1);
    // A new hour, a new allowance.
    await expect(createAnnouncement(ctxFor(busy, new Date(TEST_NOW.getTime() + HOUR + 1)), input())).resolves.toHaveProperty("id");
    expect(ANNOUNCEMENT_RATE_LIMIT.limit).toBe(20);
  });
});

describe("announcement fields", () => {
  const ctx = () => ctxFor(p.captain);

  it("needs a title and a message, within their limits", async () => {
    expect(await fieldError(createAnnouncement(ctx(), input({ title: "   " })), "title")).toBe("Title is required.");
    expect(await fieldError(createAnnouncement(ctx(), input({ title: undefined })), "title")).toBe("Title is required.");
    expect(await fieldError(createAnnouncement(ctx(), input({ title: "x".repeat(161) })), "title")).toBe("Title must be at most 160 characters.");
    expect(await fieldError(createAnnouncement(ctx(), input({ body: " \n " })), "body")).toBe("Message is required.");
    expect(await fieldError(createAnnouncement(ctx(), input({ body: "x".repeat(10001) })), "body")).toBe(
      "Message must be at most 10000 characters.",
    );
    await expect(createAnnouncement(ctx(), input({ title: "x".repeat(160), body: "y".repeat(10000) }))).resolves.toHaveProperty("id");
  });

  it("needs who it's for", async () => {
    expect(await fieldError(createAnnouncement(ctx(), input({ audience: undefined })), "audience")).toBe("Pick who it's for.");
    expect(await fieldError(createAnnouncement(ctx(), input({ audience: "" })), "audience")).toBe("Pick who it's for.");
    expect(await fieldError(createAnnouncement(ctx(), input({ audience: "ROBOTS" })), "audience")).toBe("Pick who it's for.");
  });

  it("reports every problem at once", async () => {
    const err = await createAnnouncement(ctx(), input({ title: "", body: "", audience: "x" })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).userMessage).toBe("Please fix the highlighted fields.");
    expect(Object.keys((err as ValidationError).fieldErrors).sort()).toEqual(["audience", "body", "title"]);
  });

  it("counts a line break as one character (browsers send \\r\\n), stores \\n, and drops NUL characters", async () => {
    const body = "ab\r\n".repeat(3333) + "c"; // 10,000 characters with \n
    const { id } = await createAnnouncement(ctx(), input({ body, title: "Tab\u0000le" }));
    const row = await t.db.announcement.findUniqueOrThrow({ where: { id } });
    expect(row.body).toHaveLength(10000);
    expect(row.body).not.toContain("\r");
    expect(row.title).toBe("Table");
    expect(await fieldError(createAnnouncement(ctx(), input({ body: "\u0000" })), "body")).toBe("Message is required.");
  });

  it("pins only when the box is ticked", async () => {
    const a = await createAnnouncement(ctx(), input());
    const b = await createAnnouncement(ctx(), input({ pinned: "on" }));
    const rows = await t.db.announcement.findMany({ where: { id: { in: [a.id, b.id] } }, select: { id: true, pinned: true } });
    expect(Object.fromEntries(rows.map((r) => [r.id, r.pinned]))).toEqual({ [a.id]: false, [b.id]: true });
  });
});

// ── Editing, pinning, removing ───────────────────────────────────────────────

describe("editing", () => {
  it("is for whoever posted it and all-scope staff", async () => {
    const mine = await makeAnnouncement(p.buildLead, { subteam: "BUILD" });
    expect(canEditAnnouncement(p.buildLead, mine)).toBe(true);
    for (const who of ["captain", "mentor", "teacher", "owner"] as const) expect(canEditAnnouncement(p[who], mine), who).toBe(true);
    for (const who of ["buildLead2", "swLead", "bizLead", "buildMember", "swMember"] as const) {
      expect(canEditAnnouncement(p[who], mine), who).toBe(false);
      await expect(updateAnnouncement(ctxFor(p[who]), await editInput(mine.id, { title: "Hacked" })), who).rejects.toThrow(ForbiddenError);
      await expect(setAnnouncementPinned(ctxFor(p[who]), { announcementId: mine.id, pinned: "on" }), who).rejects.toThrow(ForbiddenError);
      await expect(deleteAnnouncement(ctxFor(p[who]), { announcementId: mine.id }), who).rejects.toThrow(ForbiddenError);
    }
    // Nobody edits one whose author's account was deleted, except all-scope staff.
    const orphan = await makeAnnouncement(null);
    expect(canEditAnnouncement(p.buildLead, orphan)).toBe(false);
    expect(canEditAnnouncement(p.captain, orphan)).toBe(true);
    // Pending or disabled accounts change nothing, even their own.
    const byMentor = await makeAnnouncement(p.disabledMentor);
    await expect(updateAnnouncement(ctxFor(p.disabledMentor), await editInput(byMentor.id, { title: "x" }))).rejects.toThrow(ForbiddenError);
    await expect(deleteAnnouncement(ctxFor(p.pendingLead), { announcementId: byMentor.id })).rejects.toThrow(ForbiddenError);
    expect(await t.db.announcement.findUniqueOrThrow({ where: { id: mine.id } })).toMatchObject({ title: "Heads up", pinned: false });
  });

  it("stops when the author can't post anymore (a leader who became a member)", async () => {
    const lead = await makeUser(t.db, { role: "BUILD_LEADER", name: "Demi Demoted" });
    const { id } = await createAnnouncement(ctxFor(lead), input({ title: "Whole team, from a leader" }));
    expect(canEditAnnouncement(lead, { authorId: lead.id })).toBe(true);
    const member = { ...lead, role: "MEMBER" as const, subteam: "BUILD" as const };
    await t.db.user.update({ where: { id: lead.id }, data: { role: "MEMBER", subteam: "BUILD" } });
    expect(canEditAnnouncement(member, { authorId: lead.id })).toBe(false);
    await expect(updateAnnouncement(ctxFor(member), await editInput(id, { title: "Rewritten" }))).rejects.toThrow(ForbiddenError);
    await expect(setAnnouncementPinned(ctxFor(member), { announcementId: id, pinned: "on" })).rejects.toThrow(ForbiddenError);
    await expect(deleteAnnouncement(ctxFor(member), { announcementId: id })).rejects.toThrow(ForbiddenError);
    expect(await t.db.announcement.findUniqueOrThrow({ where: { id } })).toMatchObject({ title: "Whole team, from a leader", pinned: false });
    // The list and the edit page agree: no Edit / Pin / Remove for them. The captain still can.
    expect(await getAnnouncement(member, id, t.db)).toMatchObject({ mine: true, canEdit: false });
    expect(await getAnnouncementFormValues(member, id, t.db)).toBeNull();
    expect(await getAnnouncementFormValues(p.captain, id, t.db)).toMatchObject({ id, title: "Whole team, from a leader", audience: "team", pinned: false });
  });

  it("marks it edited only when the title or text changes", async () => {
    const a = await makeAnnouncement(p.buildLead, { subteam: "BUILD", createdAt: ago(5) });
    const later = new Date(TEST_NOW.getTime() + 10 * 60 * 1000);

    // Moving it and pinning it isn't an edit of what it says.
    let res = await updateAnnouncement(ctxFor(p.buildLead), await editInput(a.id, { audience: "team", pinned: "on" }));
    expect(res).toEqual({ id: a.id, changed: true });
    let row = await t.db.announcement.findUniqueOrThrow({ where: { id: a.id } });
    expect(row).toMatchObject({ subteam: null, pinned: true, editedAt: null });

    // Saving it unchanged writes nothing.
    const before = row.updatedAt;
    res = await updateAnnouncement(ctxFor(p.buildLead), await editInput(a.id));
    expect(res).toEqual({ id: a.id, changed: false });
    expect((await t.db.announcement.findUniqueOrThrow({ where: { id: a.id } })).updatedAt).toEqual(before);
    // Only whitespace around it: unchanged too (it's trimmed).
    res = await updateAnnouncement(ctxFor(p.buildLead), await editInput(a.id, { title: "  Heads up " }));
    expect(res.changed).toBe(false);

    // The text.
    res = await updateAnnouncement(ctxFor(p.buildLead, later), await editInput(a.id, { body: "New details." }));
    expect(res.changed).toBe(true);
    row = await t.db.announcement.findUniqueOrThrow({ where: { id: a.id } });
    expect(row).toMatchObject({ body: "New details.", editedAt: later, createdAt: ago(5), authorId: p.buildLead.id });

    // The captain fixes the title: still the leader's announcement.
    await updateAnnouncement(ctxFor(p.captain), await editInput(a.id, { title: "Heads up!" }));
    row = await t.db.announcement.findUniqueOrThrow({ where: { id: a.id } });
    expect(row).toMatchObject({ title: "Heads up!", authorId: p.buildLead.id });
  });

  it("moves it only to someone the editor can post for (keeping it where it is is fine)", async () => {
    const a = await makeAnnouncement(p.buildLead, { subteam: "BUILD" });
    await expect(updateAnnouncement(ctxFor(p.buildLead), await editInput(a.id, { audience: "SOFTWARE" }))).rejects.toThrow(ForbiddenError);
    await updateAnnouncement(ctxFor(p.captain), await editInput(a.id, { audience: "SOFTWARE" }));
    expect((await t.db.announcement.findUniqueOrThrow({ where: { id: a.id } })).subteam).toBe("SOFTWARE");
    // Now it's for Software (the captain moved it): its Build author can still fix the text without moving it back.
    await expect(updateAnnouncement(ctxFor(p.buildLead), await editInput(a.id, { title: "Typo fixed" }))).resolves.toEqual({
      id: a.id,
      changed: true,
    });
    await expect(updateAnnouncement(ctxFor(p.buildLead), await editInput(a.id, { audience: "BUSINESS" }))).rejects.toThrow(ForbiddenError);
    await expect(updateAnnouncement(ctxFor(p.buildLead), await editInput(a.id, { audience: "BUILD" }))).resolves.toHaveProperty("changed", true);
  });

  it("refuses a save based on an older version (optimistic concurrency)", async () => {
    const a = await makeAnnouncement(p.swLead, { subteam: "SOFTWARE" });
    const stale = await editInput(a.id, { body: "Mine" });
    await updateAnnouncement(ctxFor(p.captain), await editInput(a.id, { body: "Captain's" }));
    await expect(updateAnnouncement(ctxFor(p.swLead), stale)).rejects.toThrow(ANNOUNCEMENT_CHANGED);
    // Checked before the fields: a stale form with a problem hears about the other change first.
    await expect(updateAnnouncement(ctxFor(p.swLead), { ...stale, title: "" })).rejects.toThrow(ConflictError);
    await expect(updateAnnouncement(ctxFor(p.swLead), { ...stale, version: "not a date" })).rejects.toThrow(ConflictError);
    expect((await t.db.announcement.findUniqueOrThrow({ where: { id: a.id } })).body).toBe("Captain's");
    // With the newest version (the page refreshed), saving again replaces it.
    await updateAnnouncement(ctxFor(p.swLead), await editInput(a.id, { body: "Mine" }));
    expect((await t.db.announcement.findUniqueOrThrow({ where: { id: a.id } })).body).toBe("Mine");
  });

  it("gives every save a new version, even two in the same millisecond", async () => {
    const a = await makeAnnouncement(p.captain);
    const first = await editInput(a.id, { body: "One" });
    await updateAnnouncement(ctxFor(p.captain), first);
    const second = await editInput(a.id, { body: "Two" });
    expect(second.version).not.toBe(first.version);
    await updateAnnouncement(ctxFor(p.captain), second);
    // A form loaded before the second save can't save over it.
    await expect(updateAnnouncement(ctxFor(p.captain), { ...second, body: "Three" })).rejects.toThrow(ConflictError);
  });

  it("says when it was removed meanwhile", async () => {
    const a = await makeAnnouncement(p.captain);
    const form = await editInput(a.id, { body: "Late" });
    await t.db.announcement.delete({ where: { id: a.id } });
    await expect(updateAnnouncement(ctxFor(p.captain), form)).rejects.toThrow(NotFoundError);
    await expect(updateAnnouncement(ctxFor(p.captain), { ...form, announcementId: "" })).rejects.toThrow(ValidationError);
  });
});

describe("pinning", () => {
  it("is for whoever can edit it, isn't an edit, and moves the version", async () => {
    const a = await makeAnnouncement(p.bizLead, { subteam: "BUSINESS" });
    const form = await editInput(a.id, { body: "Edited while someone pinned it" });
    await expect(setAnnouncementPinned(ctxFor(p.bizLead), { announcementId: a.id, pinned: "on" })).resolves.toEqual({
      pinned: true,
      changed: true,
    });
    let row = await t.db.announcement.findUniqueOrThrow({ where: { id: a.id } });
    expect(row).toMatchObject({ pinned: true, editedAt: null });
    // An edit form opened before the pin doesn't quietly unpin it.
    await expect(updateAnnouncement(ctxFor(p.bizLead), form)).rejects.toThrow(ConflictError);
    // Pinning it again changes nothing.
    await expect(setAnnouncementPinned(ctxFor(p.bizLead), { announcementId: a.id, pinned: "on" })).resolves.toEqual({
      pinned: true,
      changed: false,
    });
    // The captain unpins it (no `pinned` field = unticked).
    await expect(setAnnouncementPinned(ctxFor(p.captain), { announcementId: a.id })).resolves.toEqual({ pinned: false, changed: true });
    row = await t.db.announcement.findUniqueOrThrow({ where: { id: a.id } });
    expect(row).toMatchObject({ pinned: false, editedAt: null });
    await expect(setAnnouncementPinned(ctxFor(p.captain), { announcementId: "missing", pinned: "on" })).rejects.toThrow(NotFoundError);
    await expect(setAnnouncementPinned(ctxFor(p.bizMember), { announcementId: a.id, pinned: "on" })).rejects.toThrow(ForbiddenError);
  });
});

describe("pinning while someone edits", () => {
  /** The DB, but an edit by `editor` lands right after the pin reads the announcement (the first `times` reads). */
  function racingDb(id: string, editor: Actor, editAt: Date, times = 1): Db {
    let left = times;
    return new Proxy(t.db, {
      get(target, prop, recv) {
        if (prop !== "announcement") return Reflect.get(target, prop, recv);
        const model = target.announcement;
        return new Proxy(model, {
          get(m, key, r) {
            if (key !== "findUnique") return Reflect.get(m, key, r);
            return async (args: Parameters<typeof model.findUnique>[0]) => {
              const row = await model.findUnique(args);
              if (left > 0) {
                left--;
                await updateAnnouncement(ctxFor(editor, editAt), await editInput(id, { body: `Edited ${left}` }));
              }
              return row;
            };
          },
        });
      },
    }) as Db;
  }

  it("never reuses the version an edit just wrote (an edit form opened in between can't quietly unpin it)", async () => {
    const a = await makeAnnouncement(p.captain, { createdAt: ago(3) });
    const at = new Date(TEST_NOW.getTime() + 10);
    // Both requests' clocks read the same millisecond.
    const res = await setAnnouncementPinned({ ...ctxFor(p.captain, at), db: racingDb(a.id, p.mentor, at) }, { announcementId: a.id, pinned: "on" });
    expect(res).toEqual({ pinned: true, changed: true });
    const row = await t.db.announcement.findUniqueOrThrow({ where: { id: a.id } });
    expect(row).toMatchObject({ pinned: true, body: "Edited 0" });
    expect(row.updatedAt.getTime()).toBeGreaterThan(at.getTime());
    // A form holding the edit's version (pin unticked) hears about the pin.
    const stale = await editInput(a.id, { version: at.toISOString(), body: "Mine" });
    delete (stale as Record<string, unknown>).pinned;
    await expect(updateAnnouncement(ctxFor(p.mentor, new Date(TEST_NOW.getTime() + 20)), stale)).rejects.toThrow(ConflictError);
    expect((await t.db.announcement.findUniqueOrThrow({ where: { id: a.id } })).pinned).toBe(true);
  });

  it("asks to try again when it keeps changing underneath", async () => {
    const a = await makeAnnouncement(p.captain, { createdAt: ago(3) });
    const racing = racingDb(a.id, p.mentor, new Date(TEST_NOW.getTime() + 5), 2);
    await expect(setAnnouncementPinned({ ...ctxFor(p.captain), db: racing }, { announcementId: a.id, pinned: "on" })).rejects.toThrow(
      ANNOUNCEMENT_BUSY,
    );
    expect((await t.db.announcement.findUniqueOrThrow({ where: { id: a.id } })).pinned).toBe(false);
  });
});

describe("removing", () => {
  it("is for whoever can edit it", async () => {
    const a = await makeAnnouncement(p.buildLead);
    const b = await makeAnnouncement(p.buildLead);
    await expect(deleteAnnouncement(ctxFor(p.buildLead2), { announcementId: a.id })).rejects.toThrow(ForbiddenError);
    await expect(deleteAnnouncement(ctxFor(p.buildLead), { announcementId: a.id })).resolves.toEqual({ id: a.id });
    await expect(deleteAnnouncement(ctxFor(p.mentor), { announcementId: b.id })).resolves.toEqual({ id: b.id });
    expect(await t.db.announcement.count({ where: { id: { in: [a.id, b.id] } } })).toBe(0);
    await expect(deleteAnnouncement(ctxFor(p.buildLead), { announcementId: a.id })).rejects.toThrow(NotFoundError);
  });

  it("doesn't remove one that changed since the page showed it", async () => {
    const a = await makeAnnouncement(p.captain);
    const seen = (await t.db.announcement.findUniqueOrThrow({ where: { id: a.id } })).updatedAt.toISOString();
    await updateAnnouncement(ctxFor(p.mentor), await editInput(a.id, { body: "Updated" }));
    await expect(deleteAnnouncement(ctxFor(p.captain), { announcementId: a.id, version: seen })).rejects.toThrow(
      ANNOUNCEMENT_CHANGED_BEFORE_REMOVE,
    );
    expect(await t.db.announcement.count({ where: { id: a.id } })).toBe(1);
    const now = (await t.db.announcement.findUniqueOrThrow({ where: { id: a.id } })).updatedAt.toISOString();
    await expect(deleteAnnouncement(ctxFor(p.captain), { announcementId: a.id, version: now })).resolves.toEqual({ id: a.id });
  });
});

// ── Reading ──────────────────────────────────────────────────────────────────

describe("who it's for", () => {
  it("is the whole team's plus your subteam's (all-scope staff: all of them)", () => {
    const cases: [Who, (Subteam | null)[]][] = [
      ["buildMember", [null, "BUILD"]],
      ["swMember", [null, "SOFTWARE"]],
      ["bizMember", [null, "BUSINESS"]],
      ["noSubteam", [null]],
      ["buildLead", [null, "BUILD"]],
      ["swLead", [null, "SOFTWARE"]],
      ["captain", [null, "SOFTWARE", "BUILD", "BUSINESS"]],
      ["mentor", [null, "SOFTWARE", "BUILD", "BUSINESS"]],
      ["teacher", [null, "SOFTWARE", "BUILD", "BUSINESS"]],
      // An owner is all-scope, whatever their own subteam.
      ["owner", [null, "SOFTWARE", "BUILD", "BUSINESS"]],
    ];
    for (const [who, forYou] of cases) {
      const got = ([null, "SOFTWARE", "BUILD", "BUSINESS"] as (Subteam | null)[]).filter((s) => isAnnouncementForYou(p[who], s));
      expect(got, who).toEqual(forYou);
    }
    expect(announcementsForYouWhere(p.captain)).toEqual({});
  });
});

describe("the list", () => {
  let ids: Record<string, string>;
  beforeAll(async () => {
    await t.db.announcement.deleteMany();
    const make = async (key: string, author: Actor | null, opts: Parameters<typeof makeAnnouncement>[1]) => {
      const row = await makeAnnouncement(author, { title: key, ...opts });
      return [key, row.id] as const;
    };
    ids = Object.fromEntries([
      await make("old team", p.captain, { createdAt: ago(100) }),
      await make("pinned old", p.mentor, { createdAt: ago(90), pinned: true }),
      await make("build", p.buildLead, { subteam: "BUILD", createdAt: ago(10) }),
      await make("software", p.swLead, { subteam: "SOFTWARE", createdAt: ago(8) }),
      await make("business", p.bizLead, { subteam: "BUSINESS", createdAt: ago(6) }),
      await make("pinned new", p.captain, { subteam: "BUILD", createdAt: ago(4), pinned: true }),
      await make("newest team", null, { createdAt: ago(2) }),
    ]);
  });

  const titles = async (who: Actor, opts: Parameters<typeof listAnnouncements>[1] = {}) =>
    (await listAnnouncements(who, opts, t.db))!.items.map((a) => a.title);

  it("shows everyone everything, pinned first, then the newest", async () => {
    const order = ["pinned new", "pinned old", "newest team", "business", "software", "build", "old team"];
    for (const who of ["buildMember", "swMember", "noSubteam", "captain"] as const) {
      expect(await titles(p[who]), who).toEqual(order);
    }
    const list = (await listAnnouncements(p.buildMember, {}, t.db))!;
    expect(list).toMatchObject({ total: 7, page: 1, pageCount: 1, anyAtAll: true, audiences: [] });
    const newest = list.items.find((a) => a.title === "newest team")!;
    expect(newest).toMatchObject({ author: null, subteam: null, mine: false, canEdit: false, forYou: true, editedAt: null });
    const build = list.items.find((a) => a.title === "build")!;
    expect(build.author).toMatchObject({ id: p.buildLead.id, name: "Blake Lead", role: "BUILD_LEADER", subteam: "BUILD", isAdmin: false });
    expect(list.items.find((a) => a.title === "software")!.forYou).toBe(false);
    // The Build leader can change their own, not the others.
    const lead = (await listAnnouncements(p.buildLead, {}, t.db))!;
    expect(lead.audiences).toEqual([null, "BUILD"]);
    expect(lead.items.filter((a) => a.canEdit).map((a) => a.title)).toEqual(["build"]);
    expect(lead.items.filter((a) => a.mine).map((a) => a.title)).toEqual(["build"]);
    expect((await listAnnouncements(p.teacher, {}, t.db))!.items.every((a) => a.canEdit)).toBe(true);
  });

  it("filters: For you, Whole team, one subteam", async () => {
    expect(await titles(p.buildMember, { for: "you" })).toEqual(["pinned new", "pinned old", "newest team", "build", "old team"]);
    expect(await titles(p.swMember, { for: "you" })).toEqual(["pinned old", "newest team", "software", "old team"]);
    expect(await titles(p.noSubteam, { for: "you" })).toEqual(["pinned old", "newest team", "old team"]);
    expect(await titles(p.captain, { for: "you" })).toHaveLength(7);
    expect(await titles(p.swMember, { for: "team" })).toEqual(["pinned old", "newest team", "old team"]);
    expect(await titles(p.swMember, { for: "BUILD" })).toEqual(["pinned new", "build"]);
    expect(await titles(p.swMember, { for: "BUSINESS" })).toEqual(["business"]);
    const none = (await listAnnouncements(p.swMember, { for: "BUSINESS", page: 1 }, t.db))!;
    expect(none.anyAtAll).toBe(true);
  });

  it("isn't shown to accounts that aren't active", async () => {
    expect(await listAnnouncements(p.pendingLead, {}, t.db)).toBeNull();
    expect(await listAnnouncements(p.disabledMentor, {}, t.db)).toBeNull();
    expect(await getAnnouncement(p.disabledMentor, ids.build, t.db)).toBeNull();
    expect(await getAnnouncement(p.buildMember, ids.build, t.db)).toMatchObject({ title: "build", canEdit: false });
    expect(await getAnnouncement(p.buildMember, "missing", t.db)).toBeNull();
  });
});

describe("pages", () => {
  beforeAll(async () => {
    await t.db.announcement.deleteMany();
    // 2 pinned + 45 others, one an hour apart (newest first after the pinned ones).
    await makeAnnouncement(p.captain, { title: "pin A", pinned: true, createdAt: ago(500) });
    await makeAnnouncement(p.captain, { title: "pin B", pinned: true, createdAt: ago(600) });
    for (let i = 1; i <= 45; i++) await makeAnnouncement(p.captain, { title: `n${i}`, createdAt: ago(i) });
  });

  it("pages 20 at a time and clamps the page", async () => {
    expect(ANNOUNCEMENTS_PAGE_SIZE).toBe(20);
    const one = (await listAnnouncements(p.buildMember, { page: 1 }, t.db))!;
    expect(one).toMatchObject({ total: 47, page: 1, pageCount: 3 });
    expect(one.items.map((a) => a.title).slice(0, 4)).toEqual(["pin A", "pin B", "n1", "n2"]);
    expect(one.items).toHaveLength(20);
    const three = (await listAnnouncements(p.buildMember, { page: 3 }, t.db))!;
    expect(three.items.map((a) => a.title)).toEqual(["n39", "n40", "n41", "n42", "n43", "n44", "n45"]);
    expect((await listAnnouncements(p.buildMember, { page: 99 }, t.db))!.page).toBe(3);
    expect((await listAnnouncements(p.buildMember, { page: 0 }, t.db))!.page).toBe(1);
  });

  it("opens the page that has the announcement to focus", async () => {
    const find = async (title: string) => (await t.db.announcement.findFirstOrThrow({ where: { title } })).id;
    expect((await listAnnouncements(p.buildMember, { focusId: await find("pin B") }, t.db))!.page).toBe(1);
    expect((await listAnnouncements(p.buildMember, { focusId: await find("n18") }, t.db))!.page).toBe(1);
    expect((await listAnnouncements(p.buildMember, { focusId: await find("n19") }, t.db))!.page).toBe(2);
    expect((await listAnnouncements(p.buildMember, { focusId: await find("n45") }, t.db))!.page).toBe(3);
    // An explicit page wins; an unknown id opens page 1.
    expect((await listAnnouncements(p.buildMember, { page: 2, focusId: await find("n45") }, t.db))!.page).toBe(2);
    expect((await listAnnouncements(p.buildMember, { focusId: "nope" }, t.db))!.page).toBe(1);
    // Same createdAt: the order (and so the page) still holds (ties go by id).
    const tie = ago(18);
    const twin = await makeAnnouncement(p.captain, { title: "twin", createdAt: tie });
    const list = (await listAnnouncements(p.buildMember, { focusId: twin.id }, t.db))!;
    const all = [...(await listAnnouncements(p.buildMember, { page: 1 }, t.db))!.items, ...(await listAnnouncements(p.buildMember, { page: 2 }, t.db))!.items];
    const index = all.findIndex((a) => a.id === twin.id);
    expect(list.page).toBe(Math.floor(index / 20) + 1);
  });

  it("says when nothing has been posted at all", async () => {
    await t.db.announcement.deleteMany();
    const empty = (await listAnnouncements(p.buildMember, { for: "you" }, t.db))!;
    expect(empty).toMatchObject({ total: 0, page: 1, pageCount: 1, anyAtAll: false, items: [] });
  });
});

// ── Unread ───────────────────────────────────────────────────────────────────

describe("unread and seen", () => {
  beforeEach(async () => {
    await t.db.announcement.deleteMany();
    await t.db.user.updateMany({ data: { announcementsSeenAt: null } });
  });

  it("counts announcements for you, not your own, since you last opened the list", async () => {
    await makeAnnouncement(p.captain, { title: "team", createdAt: ago(5) });
    await makeAnnouncement(p.buildLead, { title: "build", subteam: "BUILD", createdAt: ago(4) });
    await makeAnnouncement(p.swLead, { title: "software", subteam: "SOFTWARE", createdAt: ago(3) });
    await makeAnnouncement(null, { title: "orphan", createdAt: ago(2) });

    expect(await countUnreadAnnouncements(p.buildMember, t.db)).toBe(3); // team, build, orphan
    expect(await countUnreadAnnouncements(p.swMember, t.db)).toBe(3); // team, software, orphan
    expect(await countUnreadAnnouncements(p.noSubteam, t.db)).toBe(2); // team, orphan
    expect(await countUnreadAnnouncements(p.buildLead, t.db)).toBe(2); // not their own
    expect(await countUnreadAnnouncements(p.captain, t.db)).toBe(3); // everything but their own
    expect(await countUnreadAnnouncements(p.mentor, t.db)).toBe(4);
    expect(await countUnreadAnnouncements(p.owner, t.db)).toBe(4);
    expect(await countUnreadAnnouncements(p.pendingLead, t.db)).toBe(0);
    expect(await countUnreadAnnouncements(p.disabledMentor, t.db)).toBe(0);

    // Opened the list 3.5 hours ago: only the ones after that.
    await setSeen(p.buildMember, ago(3.5));
    expect(await countUnreadAnnouncements(p.buildMember, t.db)).toBe(1); // orphan
    await setSeen(p.mentor, ago(2));
    expect(await countUnreadAnnouncements(p.mentor, t.db)).toBe(0); // exactly then: seen
  });

  it("falls back to when the account was created", async () => {
    const newbie = await makeUser(t.db, { role: "MEMBER", subteam: "BUILD", name: "New Nora" });
    await t.db.user.update({ where: { id: newbie.id }, data: { createdAt: ago(3) } });
    await makeAnnouncement(p.captain, { createdAt: ago(10) });
    await makeAnnouncement(p.captain, { createdAt: ago(1) });
    expect(await getAnnouncementsSeenSince(newbie, t.db)).toEqual(ago(3));
    expect(await countUnreadAnnouncements(newbie, t.db)).toBe(1);
    await setSeen(newbie, ago(0.5));
    expect(await getAnnouncementsSeenSince(newbie, t.db)).toEqual(ago(0.5));
    expect(await countUnreadAnnouncements(newbie, t.db)).toBe(0);
    expect(await getAnnouncementsSeenSince({ id: "missing" }, t.db)).toBeNull();
  });

  it("lists the newest unread ones for Today", async () => {
    for (let i = 5; i >= 1; i--) await makeAnnouncement(p.captain, { title: `team ${i}`, createdAt: ago(i) });
    await makeAnnouncement(p.swLead, { title: "software", subteam: "SOFTWARE", createdAt: ago(0.5) });
    await makeAnnouncement(p.buildMember, { title: "mine?", createdAt: ago(0.2) }); // (a member can't post, but anyway: own)
    const today = await listUnreadAnnouncements(p.buildMember, 3, t.db);
    expect(today.total).toBe(5);
    expect(today.items.map((a) => a.title)).toEqual(["team 1", "team 2", "team 3"]);
    expect(today.items[0]).toMatchObject({ authorName: "Casey Captain", subteam: null, createdAt: ago(1) });
    await setSeen(p.buildMember, ago(1.5));
    expect(await listUnreadAnnouncements(p.buildMember, 3, t.db)).toMatchObject({ total: 1, items: [{ title: "team 1" }] });
    await setSeen(p.buildMember, TEST_NOW);
    expect(await listUnreadAnnouncements(p.buildMember, 3, t.db)).toEqual({ items: [], total: 0 });
    expect(await listUnreadAnnouncements(p.disabledMentor, 3, t.db)).toEqual({ items: [], total: 0 });
    // The same ones the badge counts: a mentor gets every subteam's, someone without a subteam only the team's.
    await makeAnnouncement(null, { title: "orphan", subteam: "BUSINESS", createdAt: ago(0.1) });
    const mentor = await listUnreadAnnouncements(p.mentor, 3, t.db);
    expect(mentor.total).toBe(await countUnreadAnnouncements(p.mentor, t.db));
    expect(mentor.items[0]).toMatchObject({ title: "orphan", authorName: null, subteam: "BUSINESS" });
    const none = await listUnreadAnnouncements(p.noSubteam, 3, t.db);
    expect(none.total).toBe(await countUnreadAnnouncements(p.noSubteam, t.db));
    expect(none.items.map((a) => a.title)).toEqual(["mine?", "team 1", "team 2"]);
  });

  const minusMargin = (d: Date) => new Date(d.getTime() - ANNOUNCEMENTS_SEEN_MARGIN_MS);

  it("opening the list marks everything up to when it loaded as seen", async () => {
    await makeAnnouncement(p.captain, { title: "before", createdAt: ago(2) });
    await makeAnnouncement(p.captain, { title: "while loading", createdAt: ago(0.5) });
    // The page loaded an hour ago; "while loading" came after it, so it stays unread.
    const loadedAt = ago(1);
    expect(await markAnnouncementsSeen(ctxFor(p.buildMember), { upTo: loadedAt.toISOString() })).toEqual({ cleared: 1 });
    expect(await getAnnouncementsSeenSince(p.buildMember, t.db)).toEqual(minusMargin(loadedAt));
    expect(await countUnreadAnnouncements(p.buildMember, t.db)).toBe(1);
    // Opening it again marks the rest.
    expect(await markAnnouncementsSeen(ctxFor(p.buildMember), { upTo: TEST_NOW.toISOString() })).toEqual({ cleared: 1 });
    expect(await countUnreadAnnouncements(p.buildMember, t.db)).toBe(0);
    // Nothing new: nothing to clear (no refresh needed).
    expect(await markAnnouncementsSeen(ctxFor(p.buildMember), { upTo: TEST_NOW.toISOString() })).toEqual({ cleared: 0 });
  });

  it("only moves forward, never past now, and ignores a bad time", async () => {
    await setSeen(p.swMember, ago(1));
    await markAnnouncementsSeen(ctxFor(p.swMember), { upTo: ago(5).toISOString() });
    expect(await getAnnouncementsSeenSince(p.swMember, t.db)).toEqual(ago(1));
    await markAnnouncementsSeen(ctxFor(p.swMember), { upTo: new Date(TEST_NOW.getTime() + 24 * HOUR).toISOString() });
    expect(await getAnnouncementsSeenSince(p.swMember, t.db)).toEqual(minusMargin(TEST_NOW));
    await markAnnouncementsSeen(ctxFor(p.bizMember), { upTo: "yesterday-ish" });
    expect(await getAnnouncementsSeenSince(p.bizMember, t.db)).toEqual(minusMargin(TEST_NOW));
    await markAnnouncementsSeen(ctxFor(p.noSubteam), { upTo: 12345 });
    expect(await getAnnouncementsSeenSince(p.noSubteam, t.db)).toEqual(minusMargin(TEST_NOW));
    await expect(markAnnouncementsSeen(ctxFor(p.disabledMentor), {})).rejects.toThrow(ForbiddenError);
  });

  it("never goes back before the account was created (never opened: that's where it starts)", async () => {
    const newbie = await makeUser(t.db, { role: "MEMBER", subteam: "BUSINESS", name: "Nell New" });
    await t.db.user.update({ where: { id: newbie.id }, data: { createdAt: ago(1) } });
    await makeAnnouncement(p.bizLead, { title: "before they joined", createdAt: ago(3) });
    expect(await countUnreadAnnouncements(newbie, t.db)).toBe(0);
    expect(await markAnnouncementsSeen(ctxFor(newbie), { upTo: new Date(0).toISOString() })).toEqual({ cleared: 0 });
    expect(await t.db.user.findUniqueOrThrow({ where: { id: newbie.id }, select: { announcementsSeenAt: true } })).toEqual({
      announcementsSeenAt: null,
    });
    expect(await getAnnouncementsSeenSince(newbie, t.db)).toEqual(ago(1));
    expect(await countUnreadAnnouncements(newbie, t.db)).toBe(0);
  });

  it("leaves unread what was posted just before the list loaded (it may still have been saving)", async () => {
    await setSeen(p.bizMember, ago(1));
    const loadedAt = ago(0.5);
    // Stamped a moment before the page loaded, but maybe not saved yet when its list was read.
    await makeAnnouncement(p.bizLead, { title: "just posted", subteam: "BUSINESS", createdAt: new Date(loadedAt.getTime() - 500) });
    await makeAnnouncement(p.bizLead, { title: "a bit earlier", subteam: "BUSINESS", createdAt: new Date(loadedAt.getTime() - 60_000) });
    expect(await markAnnouncementsSeen(ctxFor(p.bizMember), { upTo: loadedAt.toISOString() })).toEqual({ cleared: 1 });
    expect(await listUnreadAnnouncements(p.bizMember, 3, t.db)).toMatchObject({ total: 1, items: [{ title: "just posted" }] });
    // The next visit clears it.
    expect(await markAnnouncementsSeen(ctxFor(p.bizMember), {})).toEqual({ cleared: 1 });
    expect(await countUnreadAnnouncements(p.bizMember, t.db)).toBe(0);
  });

  it("counts only what's for you when clearing (the menu badge)", async () => {
    await makeAnnouncement(p.swLead, { subteam: "SOFTWARE", createdAt: ago(1) });
    expect(await markAnnouncementsSeen(ctxFor(p.buildMember), {})).toEqual({ cleared: 0 });
    expect(await markAnnouncementsSeen(ctxFor(p.swMember), {})).toEqual({ cleared: 1 });
  });
});

// ── Client-safe helpers ──────────────────────────────────────────────────────

describe("helpers", () => {
  it("reads the list's filters from the URL, dropping anything else", () => {
    const parse = (q: string) => {
      const sp = new URLSearchParams(q);
      return parseAnnouncementFilters((k) => sp.get(k) ?? undefined);
    };
    expect(parse("")).toEqual({});
    expect(parse("for=you&page=2")).toEqual({ for: "you", page: 2 });
    expect(parse("for=team")).toEqual({ for: "team" });
    expect(parse("for=BUILD&page=1")).toEqual({ for: "BUILD" });
    expect(parse("for=build&page=-3")).toEqual({});
    expect(parse("for=ADMIN&page=2.5")).toEqual({});
    expect(parse("page=999999")).toEqual({ page: 10000 });
  });

  it("builds links", () => {
    expect(announcementsHref({})).toBe("/announcements");
    expect(announcementsHref({ for: "SOFTWARE", page: 1 })).toBe("/announcements?for=SOFTWARE");
    expect(announcementsHref({ for: "you", page: 3 }, { removed: "1" })).toBe("/announcements?for=you&page=3&removed=1");
    expect(announcementFocusHref("abc")).toBe("/announcements?focus=abc#announcement-abc");
    expect(audienceValue(null)).toBe("team");
    expect(audienceValue("BUILD")).toBe("BUILD");
    expect(audienceLabel(null)).toBe("the whole team");
    expect(audienceLabel("BUSINESS")).toBe("Business");
  });

  it("marks as new what came after the previous visit and is for you (like the badge), never your own", () => {
    const since = ago(2);
    const a = (createdAt: Date | string, over: { mine?: boolean; forYou?: boolean } = {}) => ({ createdAt, mine: false, forYou: true, ...over });
    expect(isNewAnnouncement(a(ago(1)), since)).toBe(true);
    expect(isNewAnnouncement(a(ago(1).toISOString()), since.toISOString())).toBe(true);
    expect(isNewAnnouncement(a(ago(2)), since)).toBe(false);
    expect(isNewAnnouncement(a(ago(3)), since)).toBe(false);
    expect(isNewAnnouncement(a(ago(1), { mine: true }), since)).toBe(false);
    expect(isNewAnnouncement(a(ago(1), { forYou: false }), since)).toBe(false);
    expect(isNewAnnouncement(a(ago(1)), null)).toBe(false);
  });

  it("says what the list shows", () => {
    expect(announcementCountText(1)).toBe("1 announcement");
    expect(announcementCountText(17, "BUILD")).toBe("17 announcements for Build");
    expect(announcementCountText(3, "you")).toBe("3 announcements for you");
    expect(announcementCountText(0, "team")).toBe("0 announcements for the whole team");
  });

  it("after someone else's change, keeps only the fields the person changed", () => {
    const loaded = { id: "a", version: "v1", title: "Old title", body: "Old body", audience: "BUILD" as const, pinned: false };
    const latest = { id: "a", version: "v2", title: "Old title", body: "Captain's body", audience: "team" as const, pinned: true };
    // They changed the title only (and left "Pin to the top" unticked, as it was).
    const submitted = submittedAnnouncementValues({ title: "My title", body: "Old body", audience: "BUILD" });
    expect(submitted).toEqual({ title: "My title", body: "Old body", audience: "BUILD", pinned: false });
    expect(mergeAnnouncementEdits(loaded, submitted, latest)).toEqual({
      id: "a",
      version: "v2",
      title: "My title",
      body: "Captain's body",
      audience: "team",
      pinned: true,
    });
    // What they did change stays theirs, even against a newer value.
    const unpinnedIt = submittedAnnouncementValues({ title: "Old title", body: "My body", audience: "team", pinned: "on" });
    expect(mergeAnnouncementEdits({ ...loaded, pinned: true }, { ...unpinnedIt, pinned: false }, latest)).toMatchObject({
      body: "My body",
      audience: "team",
      pinned: false,
      version: "v2",
    });
  });
});
