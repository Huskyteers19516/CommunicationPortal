import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LIMITS } from "@/lib/constants";
import type { Actor } from "@/server/actor";
import { ConflictError, ForbiddenError, NotFoundError, RateLimitError, ValidationError } from "@/server/errors";
import {
  canDeleteResource,
  canEditResource,
  canManageResources,
  canReviewResources,
  canViewResource,
} from "@/server/permissions";
import { getResourceDetail, getResourceFile, getResourceForEdit, listResources } from "@/server/queries/resources";
import {
  contentDisposition,
  decodeTextPreview,
  FILE_CSP,
  fileExtension,
  fileResponseHeaders,
  PDF_CSP,
  previewKind,
  TEXT_PREVIEW_MAX_BYTES,
} from "@/server/resources/serve";
import {
  cleanFilename,
  createResource,
  deleteResource,
  parseHttpUrl,
  parseLinksText,
  readLinks,
  MEMBER_UNAPPROVED_FILE_BYTES,
  RESOURCE_CHANGED,
  reviewDoneMessage,
  reviewResource,
  updateResource,
  type UploadedFile,
} from "@/server/services/resources";
import { createTestDb, type TestDb } from "./helpers/db";
import { contextFor, makeUser, TEST_NOW } from "./helpers/factories";

let t: TestDb;
let member: Actor;
let member2: Actor;
let leader: Actor;
let buildLeader: Actor;
let mentor: Actor;
let captain: Actor;
let teacher: Actor;
let owner: Actor;
let pendingLeader: Actor;
let disabledMember: Actor;

beforeAll(async () => {
  t = await createTestDb();
  member = await makeUser(t.db, { name: "Maya Chen", role: "MEMBER", subteam: "BUILD" });
  member2 = await makeUser(t.db, { name: "Omar Haddad", role: "MEMBER", subteam: "SOFTWARE" });
  leader = await makeUser(t.db, { name: "Priya Raman", role: "SOFTWARE_LEADER" });
  buildLeader = await makeUser(t.db, { role: "BUILD_LEADER" });
  mentor = await makeUser(t.db, { role: "MENTOR" });
  captain = await makeUser(t.db, { role: "CAPTAIN" });
  teacher = await makeUser(t.db, { role: "TEACHER" });
  owner = await makeUser(t.db, { role: "MEMBER", subteam: "BUSINESS", isAdmin: true });
  pendingLeader = await makeUser(t.db, { role: "BUILD_LEADER", status: "PENDING" });
  disabledMember = await makeUser(t.db, { role: "MEMBER", subteam: "BUILD", status: "DISABLED" });
});
afterAll(async () => {
  await t.drop();
});

const docs = {
  title: "Huskyteers Team Docs",
  url: "https://docs.example.com/team-docs",
  description: "All team materials.",
  type: "DOCUMENT",
  group: "Team Docs",
  pinned: "on",
  links: "Meeting Agenda | https://docs.example.com/team-docs?tab=t.1\nImportant Dates | https://docs.example.com/team-docs?tab=t.2",
};

const JAVA = `package org.firstinspires.ftc.teamcode;\n\npublic class TeleOpMain extends LinearOpMode {\n  // <b>not html</b>\n}\n`;

function upload(name = "TeleOpMain.java", content: string | Uint8Array = JAVA, type = "text/x-java"): UploadedFile {
  return { name, type, bytes: typeof content === "string" ? new TextEncoder().encode(content) : content };
}

/** A file resource form (as the Server Action passes it). */
function fileForm(overrides: Record<string, unknown> = {}) {
  return { title: "TeleOp code", kind: "file", type: "CODE", group: "Code", description: "", pinned: "", links: "", file: upload(), ...overrides };
}

async function errorOf(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => null,
    (e: unknown) => e,
  );
}

async function fieldErrors(p: Promise<unknown>) {
  const err = await errorOf(p);
  expect(err).toBeInstanceOf(ValidationError);
  return (err as ValidationError).fieldErrors;
}

describe("links", () => {
  it("only accepts full http(s) URLs", () => {
    expect(parseHttpUrl("https://example.com/a?b=1")).toBe("https://example.com/a?b=1");
    expect(parseHttpUrl("  http://example.com ")).toBe("http://example.com/");
    expect(parseHttpUrl("javascript:alert(1)")).toBeNull();
    expect(parseHttpUrl("data:text/html,hi")).toBeNull();
    expect(parseHttpUrl("ftp://example.com")).toBeNull();
    expect(parseHttpUrl("/relative")).toBeNull();
    expect(parseHttpUrl("https://user:pass@example.com")).toBeNull();
    expect(parseHttpUrl("")).toBeNull();
  });

  it("parses quick links, one per line, and names the bad line", () => {
    expect(parseLinksText("A | https://a.example\n\n  https://b.example/x  ")).toEqual([
      { label: "A", url: "https://a.example/" },
      { label: "b.example", url: "https://b.example/x" },
    ]);
    expect(() => parseLinksText("Good | https://a.example\nBad | javascript:alert(1)")).toThrow(ValidationError);
    try {
      parseLinksText("Good | https://a.example\nBad | nope");
    } catch (e) {
      expect((e as ValidationError).fieldErrors.links).toContain("Line 2");
    }
  });

  it("reads stored links defensively", () => {
    expect(readLinks([{ label: "Ok", url: "https://a.example" }, { label: "Evil", url: "javascript:alert(1)" }, "junk", null])).toEqual([
      { label: "Ok", url: "https://a.example/" },
    ]);
    expect(readLinks({ not: "an array" })).toEqual([]);
  });
});

describe("permissions", () => {
  it("everyone with admin access manages and reviews; members don't", () => {
    for (const a of [leader, buildLeader, mentor, captain, teacher, owner]) {
      expect(canManageResources(a), a.role).toBe(true);
      expect(canReviewResources(a), a.role).toBe(true);
    }
    expect(canManageResources(member)).toBe(false);
    expect(canReviewResources(member)).toBe(false);
  });

  it("pending and turned-down resources are only for the person who shared them and reviewers", () => {
    for (const status of ["PENDING", "REJECTED"] as const) {
      const r = { status, createdById: member.id };
      expect(canViewResource(member, r)).toBe(true);
      expect(canViewResource(member2, r)).toBe(false);
      expect(canViewResource(leader, r)).toBe(true);
      expect(canEditResource(member, r)).toBe(true);
      expect(canEditResource(member2, r)).toBe(false);
      expect(canDeleteResource(member, r)).toBe(true);
      expect(canDeleteResource(member2, r)).toBe(false);
    }
    const approved = { status: "APPROVED" as const, createdById: member.id };
    expect(canViewResource(member2, approved)).toBe(true);
    expect(canEditResource(member, approved)).toBe(false); // approved: members can't change it any more…
    expect(canDeleteResource(member, approved)).toBe(true); // …but can still take it down
    expect(canEditResource(captain, approved)).toBe(true);
    expect(canDeleteResource(member, { status: "APPROVED", createdById: null })).toBe(false);
  });
});

describe("managing resources", () => {
  it("staff can add a pinned resource with quick links; it's live right away", async () => {
    const ctx = contextFor(t.db, leader);
    const { id } = await createResource(ctx, docs);
    const row = await t.db.resource.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ title: docs.title, url: docs.url, type: "DOCUMENT", group: "Team Docs", pinned: true, createdById: leader.id, status: "APPROVED" });
    expect(readLinks(row.links).map((l) => l.label)).toEqual(["Meeting Agenda", "Important Dates"]);
    expect(ctx.notifier.events).toEqual([]);
  });

  it("not-yet-approved and disabled accounts can't share, and members can't change others' resources", async () => {
    await expect(createResource(contextFor(t.db, pendingLeader), docs)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createResource(contextFor(t.db, disabledMember), docs)).rejects.toBeInstanceOf(ForbiddenError);
    const { id } = await createResource(contextFor(t.db, mentor), { ...docs, title: "Guarded" });
    await expect(updateResource(contextFor(t.db, member), { ...docs, resourceId: id, title: "Hacked" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(deleteResource(contextFor(t.db, member), { resourceId: id })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(updateResource(contextFor(t.db, pendingLeader), { ...docs, resourceId: id, title: "Hacked" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(deleteResource(contextFor(t.db, pendingLeader), { resourceId: id })).rejects.toBeInstanceOf(ForbiddenError);
    expect((await t.db.resource.findUniqueOrThrow({ where: { id } })).title).toBe("Guarded");
  });

  it("validates the form", async () => {
    const ctx = contextFor(t.db, leader);
    expect(await fieldErrors(createResource(ctx, { ...docs, title: "", url: "javascript:alert(1)" }))).toMatchObject({
      title: "Title is required.",
      url: "Enter a full link starting with https://",
    });
    expect(await fieldErrors(createResource(ctx, { ...docs, type: "EXE" }))).toHaveProperty("type");
    expect(await fieldErrors(createResource(ctx, { ...docs, links: "Bad | nope" }))).toHaveProperty("links");
    expect(await fieldErrors(createResource(ctx, { ...docs, kind: "folder" }))).toHaveProperty("kind");
  });

  it("any staff member can edit or remove a resource; missing ones are NotFound", async () => {
    const { id } = await createResource(contextFor(t.db, leader), { ...docs, title: "Inventory tracker", pinned: "", links: "", group: "Project assets", type: "WEBSITE" });
    await updateResource(contextFor(t.db, mentor), { ...docs, resourceId: id, title: "Inventory tracker v2", pinned: "", links: "", group: "Project assets", type: "WEBSITE" });
    expect((await t.db.resource.findUniqueOrThrow({ where: { id } })).title).toBe("Inventory tracker v2");
    await deleteResource(contextFor(t.db, mentor), { resourceId: id });
    await expect(deleteResource(contextFor(t.db, mentor), { resourceId: id })).rejects.toBeInstanceOf(NotFoundError);
    await expect(updateResource(contextFor(t.db, leader), { ...docs, resourceId: id })).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("member submissions", () => {
  it("members can share, but it waits for approval (never pinned) and the reviewers are told", async () => {
    const ctx = contextFor(t.db, member);
    const { id } = await createResource(ctx, { ...docs, title: "Gear ratio calculator", pinned: "on" });
    const row = await t.db.resource.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ status: "PENDING", pinned: false, createdById: member.id, reviewedById: null });
    expect(ctx.notifier.events).toEqual([{ type: "resource.submitted", resourceId: id }]);
  });

  it("pending resources are hidden from other members, but visible to the member and every reviewer", async () => {
    const { id } = await createResource(contextFor(t.db, member), { ...docs, title: "Secret sauce", group: "Build" });
    const asOther = await listResources(member2, t.db);
    expect(asOther.groups.flatMap((g) => g.items).map((i) => i.id)).not.toContain(id);
    expect(asOther.pending).toEqual([]);
    expect(asOther.mine).toEqual([]);
    expect(await getResourceDetail(member2, id, t.db)).toBeNull();
    expect(await getResourceForEdit(member2, id, t.db)).toBeNull();

    const asMember = await listResources(member, t.db);
    expect(asMember.mine.map((i) => i.id)).toContain(id);
    expect(asMember.pending).toEqual([]);
    expect(asMember.groups.flatMap((g) => g.items).map((i) => i.id)).not.toContain(id);
    expect(await getResourceDetail(member, id, t.db)).toMatchObject({
      id,
      status: "PENDING",
      isMine: true,
      canEdit: true,
      canDelete: true,
      canReview: false,
      isReviewer: false,
    });

    for (const reviewer of [leader, buildLeader, mentor, captain, teacher, owner]) {
      const page = await listResources(reviewer, t.db);
      expect(page.canReview, reviewer.role).toBe(true);
      expect(page.pending.find((i) => i.id === id), reviewer.role).toMatchObject({ createdByName: "Maya Chen", status: "PENDING" });
      expect(await getResourceDetail(reviewer, id, t.db), reviewer.role).toMatchObject({
        canReview: true,
        isReviewer: true,
        canEdit: true,
        canDelete: true,
      });
    }
  });

  it("other members can't edit or remove someone's pending resource (it looks missing)", async () => {
    const { id } = await createResource(contextFor(t.db, member), { ...docs, title: "Not yours" });
    await expect(updateResource(contextFor(t.db, member2), { ...docs, resourceId: id })).rejects.toBeInstanceOf(NotFoundError);
    await expect(deleteResource(contextFor(t.db, member2), { resourceId: id })).rejects.toBeInstanceOf(NotFoundError);
    await expect(updateResource(contextFor(t.db, disabledMember), { ...docs, resourceId: id })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("reviewers approve or send back, with an optional note; a second review is a conflict", async () => {
    const a = await createResource(contextFor(t.db, member), { ...docs, title: "Approve me" });
    const ctx = contextFor(t.db, buildLeader);
    const approved = await reviewResource(ctx, { resourceId: a.id, decision: "approve" });
    // What the reviewer's confirmation needs (the card it came from disappears).
    expect(approved).toEqual({ id: a.id, decision: "approve", title: "Approve me", sharedByName: "Maya Chen", withNote: false });
    expect(reviewDoneMessage(approved)).toBe("Approved “Approve me” — the team can see it now.");
    expect(await t.db.resource.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({
      status: "APPROVED",
      reviewedById: buildLeader.id,
      reviewedAt: TEST_NOW,
      reviewNote: null,
    });
    expect(ctx.notifier.events).toEqual([{ type: "resource.reviewed", resourceId: a.id }]);
    const again = await errorOf(reviewResource(contextFor(t.db, mentor), { resourceId: a.id, decision: "reject" }));
    expect(again).toBeInstanceOf(ConflictError);
    expect((again as ConflictError).userMessage).toBe("Someone already reviewed this.");
    // Now everyone sees it. Reviewers can't review it again (their page shows the confirmation instead).
    expect((await listResources(member2, t.db)).groups.flatMap((g) => g.items).map((i) => i.id)).toContain(a.id);
    expect(await getResourceDetail(buildLeader, a.id, t.db)).toMatchObject({ status: "APPROVED", isReviewer: true, canReview: false });

    const b = await createResource(contextFor(t.db, member), { ...docs, title: "Turn me down" });
    const sentBack = await reviewResource(contextFor(t.db, owner), {
      resourceId: b.id,
      decision: "reject",
      note: "  Link is private — share it first.  ",
    });
    expect(reviewDoneMessage(sentBack)).toBe("Sent “Turn me down” back to Maya. They'll see your note.");
    expect(await t.db.resource.findUniqueOrThrow({ where: { id: b.id } })).toMatchObject({
      status: "REJECTED",
      reviewedById: owner.id,
      reviewNote: "Link is private — share it first.",
    });
    expect(await getResourceDetail(member2, b.id, t.db)).toBeNull();
    const mine = (await listResources(member, t.db)).mine.find((i) => i.id === b.id);
    expect(mine).toMatchObject({ status: "REJECTED", reviewNote: "Link is private — share it first." });
  });

  it("reviewDoneMessage: without a note, and when the member's account is gone", () => {
    const base = { id: "r1", title: "Gear calculator", sharedByName: "Ava Thompson", withNote: false };
    expect(reviewDoneMessage({ ...base, decision: "reject" })).toBe("Sent “Gear calculator” back to Ava.");
    expect(reviewDoneMessage({ ...base, decision: "reject", sharedByName: null })).toBe("Sent “Gear calculator” back.");
    expect(reviewDoneMessage({ ...base, decision: "approve", title: "" })).toBe("Approved it — the team can see it now.");
  });

  it("two reviewers at once: exactly one wins (with or without the version they saw)", async () => {
    const { id } = await createResource(contextFor(t.db, member), { ...docs, title: "Race" });
    const results = await Promise.allSettled([
      reviewResource(contextFor(t.db, leader), { resourceId: id, decision: "approve" }),
      reviewResource(contextFor(t.db, captain), { resourceId: id, decision: "reject", note: "No" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const seen = await createResource(contextFor(t.db, member), { ...docs, title: "Race 2" });
    const version = (await getResourceDetail(leader, seen.id, t.db))!.version;
    const both = await Promise.allSettled([
      reviewResource(contextFor(t.db, leader), { resourceId: seen.id, decision: "reject", note: "No", version }),
      reviewResource(contextFor(t.db, captain), { resourceId: seen.id, decision: "approve", version }),
    ]);
    expect(both.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const failed = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(failed.reason).toBeInstanceOf(ConflictError);
  });

  it("only reviewers can review; bad input and missing resources are reported", async () => {
    const { id } = await createResource(contextFor(t.db, member), { ...docs, title: "Review guard" });
    await expect(reviewResource(contextFor(t.db, member), { resourceId: id, decision: "approve" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(reviewResource(contextFor(t.db, member2), { resourceId: id, decision: "approve" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(reviewResource(contextFor(t.db, pendingLeader), { resourceId: id, decision: "approve" })).rejects.toBeInstanceOf(ForbiddenError);
    expect(await fieldErrors(reviewResource(contextFor(t.db, leader), { resourceId: id, decision: "maybe" }))).toHaveProperty("decision");
    expect(await fieldErrors(reviewResource(contextFor(t.db, leader), { resourceId: id, decision: "reject", note: "x".repeat(LIMITS.noteMax + 1) }))).toHaveProperty("note");
    await expect(reviewResource(contextFor(t.db, leader), { resourceId: "nope", decision: "approve" })).rejects.toBeInstanceOf(NotFoundError);
    expect((await t.db.resource.findUniqueOrThrow({ where: { id } })).status).toBe("PENDING");
  });

  it("editing a turned-down resource sends it back for approval; approved ones can't be edited by the member", async () => {
    const { id } = await createResource(contextFor(t.db, member), { ...docs, title: "Try again" });
    await reviewResource(contextFor(t.db, leader), { resourceId: id, decision: "reject", note: "Wrong link" });

    const ctx = contextFor(t.db, member);
    await updateResource(ctx, { ...docs, resourceId: id, title: "Try again (fixed)", url: "https://docs.example.com/fixed", pinned: "on" });
    expect(await t.db.resource.findUniqueOrThrow({ where: { id } })).toMatchObject({
      title: "Try again (fixed)",
      url: "https://docs.example.com/fixed",
      status: "PENDING",
      pinned: false,
      reviewedById: null,
      reviewedAt: null,
      reviewNote: null,
    });
    expect(ctx.notifier.events).toEqual([{ type: "resource.submitted", resourceId: id }]);

    await reviewResource(contextFor(t.db, leader), { resourceId: id, decision: "approve" });
    await expect(updateResource(contextFor(t.db, member), { ...docs, resourceId: id, title: "Sneaky change" })).rejects.toBeInstanceOf(ForbiddenError);
    expect(await getResourceForEdit(member, id, t.db)).toBeNull();
    expect(await getResourceDetail(member, id, t.db)).toMatchObject({ canEdit: false, canDelete: true, canReview: false });
    // …but can still take down what they shared.
    await deleteResource(contextFor(t.db, member), { resourceId: id });
    expect(await t.db.resource.count({ where: { id } })).toBe(0);
  });

  it("staff editing a member's pending resource keep it pending (no new email) and may pin it", async () => {
    const { id } = await createResource(contextFor(t.db, member), { ...docs, title: "Tidy me", pinned: "" });
    const ctx = contextFor(t.db, captain);
    await updateResource(ctx, { ...docs, resourceId: id, title: "Tidied", pinned: "on" });
    expect(await t.db.resource.findUniqueOrThrow({ where: { id } })).toMatchObject({ title: "Tidied", status: "PENDING", pinned: true });
    expect(ctx.notifier.events).toEqual([]);
    // The member editing again can't un-pin or pin; pinned stays as staff left it.
    await updateResource(contextFor(t.db, member), { ...docs, resourceId: id, title: "Tidied by me", pinned: "" });
    expect((await t.db.resource.findUniqueOrThrow({ where: { id } })).pinned).toBe(true);
  });

  it("an approval only applies to the version the reviewer saw", async () => {
    const { id } = await createResource(contextFor(t.db, member), { ...docs, title: "Parts list", pinned: "" });
    const seen = (await getResourceDetail(leader, id, t.db))!.version;
    // The member swaps the link after the reviewer opened it.
    await updateResource(contextFor(t.db, member), { ...docs, resourceId: id, title: "Parts list", url: "https://evil.example.net/login", pinned: "" });
    await expect(reviewResource(contextFor(t.db, leader), { resourceId: id, decision: "approve", version: seen })).rejects.toThrow(RESOURCE_CHANGED);
    expect((await t.db.resource.findUniqueOrThrow({ where: { id } })).status).toBe("PENDING");
    // Looking again (fresh version) and approving works.
    const fresh = (await getResourceDetail(leader, id, t.db))!.version;
    await reviewResource(contextFor(t.db, leader), { resourceId: id, decision: "approve", version: fresh });
    expect((await t.db.resource.findUniqueOrThrow({ where: { id } })).status).toBe("APPROVED");
  });

  it("a member's edits while it's still waiting don't email the reviewers again, and count toward the hourly limit", async () => {
    const eager = await makeUser(t.db, { role: "MEMBER", subteam: "BUILD" });
    const ctx = contextFor(t.db, eager);
    const { id } = await createResource(ctx, { ...docs, title: "Draft 0", pinned: "" });
    for (let i = 1; i < 20; i++) await updateResource(ctx, { ...docs, resourceId: id, title: `Draft ${i}`, pinned: "" });
    expect(ctx.notifier.ofType("resource.submitted")).toHaveLength(1); // just the first share
    await expect(updateResource(ctx, { ...docs, resourceId: id, title: "Draft 20", pinned: "" })).rejects.toBeInstanceOf(RateLimitError);
  });

  it("staff can still approve something they turned down earlier", async () => {
    const { id } = await createResource(contextFor(t.db, member), { ...docs, title: "Second look", pinned: "" });
    await reviewResource(contextFor(t.db, leader), { resourceId: id, decision: "reject", note: "Hmm" });
    // Only from a page showing it as sent back (its current version) — a stale "waiting" page can't flip it.
    await expect(reviewResource(contextFor(t.db, mentor), { resourceId: id, decision: "approve" })).rejects.toBeInstanceOf(ConflictError);
    const version = (await getResourceDetail(mentor, id, t.db))!.version;
    await reviewResource(contextFor(t.db, mentor), { resourceId: id, decision: "approve", version });
    expect((await t.db.resource.findUniqueOrThrow({ where: { id } })).status).toBe("APPROVED");
    await expect(reviewResource(contextFor(t.db, leader), { resourceId: id, decision: "reject" })).rejects.toBeInstanceOf(ConflictError);
  });

  it("members get a tighter hourly limit on sharing", async () => {
    const keen = await makeUser(t.db, { role: "MEMBER", subteam: "SOFTWARE" });
    const ctx = contextFor(t.db, keen);
    for (let i = 0; i < 20; i++) await createResource(ctx, { ...docs, title: `Share ${i}`, pinned: "" });
    await expect(createResource(ctx, { ...docs, title: "One too many", pinned: "" })).rejects.toBeInstanceOf(RateLimitError);
  });
});

describe("uploaded files", () => {
  let uploader: Actor;
  beforeAll(async () => {
    uploader = await makeUser(t.db, { role: "MENTOR" });
  });

  it("stores the file in the database with a cleaned name; url stays empty", async () => {
    const { id } = await createResource(contextFor(t.db, uploader), fileForm({ file: upload("C:\\Users\\maya\\Desktop\\TeleOpMain.java", JAVA, "text/x-java; charset=utf-8") }));
    const row = await t.db.resource.findUniqueOrThrow({ where: { id }, include: { file: true } });
    expect(row).toMatchObject({ url: "", status: "APPROVED", type: "CODE" });
    expect(row.file).toMatchObject({ filename: "TeleOpMain.java", contentType: "text/x-java", size: new TextEncoder().encode(JAVA).length });
    expect(new TextDecoder().decode(row.file!.data)).toBe(JAVA);
  });

  it("cleans file names", () => {
    expect(cleanFilename("C:\\Users\\maya\\Auto.java")).toBe("Auto.java");
    expect(cleanFilename("../../etc/passwd")).toBe("passwd");
    expect(cleanFilename("a\u0000b\u202Etxt.exe")).toBe("abtxt.exe");
    expect(cleanFilename("  spaced \t name.java. . ")).toBe("spaced name.java");
    expect(cleanFilename("")).toBe("file");
    expect(cleanFilename("..")).toBe("file");
    expect(cleanFilename("folder/")).toBe("file");
    const long = cleanFilename(`${"x".repeat(300)}.java`);
    expect(long).toHaveLength(LIMITS.resourceFilenameMax);
    expect(long.endsWith(".java")).toBe(true);
    expect(fileExtension("Robot.JAVA")).toBe("java");
    expect(fileExtension(".gitignore")).toBe("gitignore");
    expect(fileExtension("README")).toBe("");
  });

  it("rejects missing, empty, too-big, and runnable files, together with other field errors", async () => {
    const ctx = contextFor(t.db, uploader);
    expect((await fieldErrors(createResource(ctx, fileForm({ file: undefined })))).file).toBe("Choose a file to upload.");
    expect((await fieldErrors(createResource(ctx, fileForm({ file: "TeleOpMain.java" })))).file).toBe("Choose a file to upload.");
    expect((await fieldErrors(createResource(ctx, fileForm({ file: upload("empty.txt", "") })))).file).toMatch(/empty/);
    const big = await fieldErrors(createResource(ctx, fileForm({ file: upload("robot.step", new Uint8Array(LIMITS.resourceFileMaxBytes + 1)) })));
    expect(big.file).toContain("up to 4 MB");
    expect(big.file).toContain("share a link");
    for (const name of ["setup.exe", "Install.MSI", "run.bat", "x.cmd", "a.com", "s.scr", "p.ps1", "v.vbs", "Shortcut.lnk", "invoice\u202Egpj.exe", "trailing.exe. "]) {
      const errors = await fieldErrors(createResource(ctx, fileForm({ file: upload(name, "MZ") })));
      expect(errors.file, name).toMatch(/can't be uploaded/);
    }
    const both = await fieldErrors(createResource(ctx, fileForm({ title: "", file: upload("x.exe", "MZ") })));
    expect(Object.keys(both).sort()).toEqual(["file", "title"]);
    // A link resource ignores any file.
    const { id } = await createResource(ctx, { ...docs, title: "Just a link", file: upload("x.exe", "MZ") });
    expect(await t.db.resourceFile.count({ where: { resourceId: id } })).toBe(0);
  });

  it("a member can only have so many bytes of files waiting for approval", async () => {
    const hoarder = await makeUser(t.db, { role: "MEMBER", subteam: "BUSINESS" });
    const ctx = contextFor(t.db, hoarder);
    const chunk = new Uint8Array(LIMITS.resourceFileMaxBytes).fill(65);
    const n = Math.floor(MEMBER_UNAPPROVED_FILE_BYTES / LIMITS.resourceFileMaxBytes);
    for (let i = 0; i < n; i++) await createResource(ctx, fileForm({ title: `Chunk ${i}`, file: upload(`c${i}.txt`, chunk) }));
    const errs = await fieldErrors(createResource(ctx, fileForm({ title: "One more", file: upload("more.txt", "x") })));
    expect(errs.file).toMatch(/waiting for approval/);
    // Staff aren't limited this way (theirs go live right away).
    await createResource(contextFor(t.db, leader), fileForm({ title: "Staff file", file: upload("staff.txt", "ok") }));
    await t.db.resource.deleteMany({ where: { createdById: { in: [hoarder.id, leader.id] }, title: { in: ["Staff file", ...Array.from({ length: n }, (_, i) => `Chunk ${i}`)] } } });
  });

  it("refuses JavaScript and Java archives (they run when double-clicked on Windows)", async () => {
    for (const name of ["tool.js", "Robot.jar", "TOOL.JS"]) {
      const errs = await fieldErrors(createResource(contextFor(t.db, leader), fileForm({ file: upload(name, "x") })));
      expect(errs.file, name).toMatch(/can't be uploaded/);
    }
  });

  it("keeps every file together under the storage cap (replacing a file frees its space)", async () => {
    const ctx = contextFor(t.db, uploader);
    const holder = await t.db.resource.create({
      data: { title: "Big old CAD export", file: { create: { filename: "big.step", contentType: "application/octet-stream", size: 0, data: new Uint8Array([1]) } } },
    });
    const used = (await t.db.resourceFile.aggregate({ _sum: { size: true } }))._sum.size ?? 0;
    // Leave exactly 30 bytes free.
    await t.db.resourceFile.update({ where: { resourceId: holder.id }, data: { size: LIMITS.resourceStorageMaxBytes - used - 30 } });

    const b = await createResource(ctx, fileForm({ file: upload("b.txt", "x".repeat(20)) })); // 10 bytes left
    await updateResource(ctx, fileForm({ resourceId: b.id, file: upload("b.txt", "x".repeat(25)) })); // 20 freed, 25 used: 5 left
    const full = await fieldErrors(createResource(ctx, fileForm({ file: upload("c.txt", "x".repeat(6)) })));
    expect(full.file).toMatch(/storage is full/);
    await createResource(ctx, fileForm({ file: upload("d.txt", "x".repeat(5)) })); // exactly full is fine

    await t.db.resource.deleteMany({ where: { id: { in: [holder.id] } } });
  });

  it("editing keeps the file unless a new one is chosen, and switches between link and file", async () => {
    const ctx = contextFor(t.db, uploader);
    const { id } = await createResource(ctx, fileForm());
    const fileOf = () => t.db.resourceFile.findUnique({ where: { resourceId: id } });

    await updateResource(ctx, fileForm({ resourceId: id, title: "TeleOp code v2", file: undefined }));
    expect((await fileOf())?.filename).toBe("TeleOpMain.java");
    expect((await t.db.resource.findUniqueOrThrow({ where: { id } })).title).toBe("TeleOp code v2");

    await updateResource(ctx, fileForm({ resourceId: id, file: upload("AutoBlue.java", "class AutoBlue {}") }));
    expect(await fileOf()).toMatchObject({ filename: "AutoBlue.java", size: 17 });

    await updateResource(ctx, { ...docs, resourceId: id, kind: "link", url: "https://github.com/huskyteers/robot" });
    expect(await fileOf()).toBeNull();
    expect((await t.db.resource.findUniqueOrThrow({ where: { id } })).url).toBe("https://github.com/huskyteers/robot");

    expect((await fieldErrors(updateResource(ctx, fileForm({ resourceId: id, file: undefined })))).file).toBe("Choose a file to upload.");
    await updateResource(ctx, fileForm({ resourceId: id }));
    expect((await fileOf())?.filename).toBe("TeleOpMain.java");
    expect((await t.db.resource.findUniqueOrThrow({ where: { id } })).url).toBe("");
  });

  it("members' files wait for approval and are only served to them and reviewers", async () => {
    const { id } = await createResource(contextFor(t.db, member), fileForm({ title: "My intake code" }));
    expect((await t.db.resource.findUniqueOrThrow({ where: { id } })).status).toBe("PENDING");
    expect(await getResourceFile(member2, id, t.db)).toBeNull();
    expect((await getResourceFile(member, id, t.db))?.filename).toBe("TeleOpMain.java");
    expect(new TextDecoder().decode((await getResourceFile(leader, id, t.db))!.data)).toBe(JAVA);
    await reviewResource(contextFor(t.db, leader), { resourceId: id, decision: "approve" });
    expect((await getResourceFile(member2, id, t.db))?.filename).toBe("TeleOpMain.java");
    expect(await getResourceFile(member2, "missing", t.db)).toBeNull();
  });
});

describe("listing", () => {
  it("everyone sees resources grouped: pinned sections first, 'Other' last; only staff can manage", async () => {
    await t.db.resource.deleteMany();
    const ctx = contextFor(t.db, leader);
    await createResource(ctx, { ...docs, pinned: "on" });
    await createResource(ctx, { title: "Game manual", url: "https://ftc.example/manual.pdf", type: "DOCUMENT", group: "", pinned: "" });
    await createResource(ctx, { title: "Inventory tracker", url: "https://inventory.example.com/", type: "WEBSITE", group: "Project assets", pinned: "" });
    await t.db.resource.create({ data: { title: "Broken links", url: "https://x.example", links: [{ label: "x", url: "javascript:1" }] } });

    const asMember = await listResources(member, t.db);
    expect(asMember.canManage).toBe(false);
    expect(asMember.canReview).toBe(false);
    expect(asMember.groups.map((g) => g.name)).toEqual(["Team Docs", "Project assets", "Other"]);
    const tracker = asMember.groups[1].items[0];
    expect(tracker).toMatchObject({ title: "Inventory tracker", host: "inventory.example.com", type: "WEBSITE", kind: "link", href: "https://inventory.example.com/", file: null });
    expect(asMember.groups[0].items[0].links).toHaveLength(2);
    expect(asMember.groups[2].items.find((i) => i.title === "Broken links")?.links).toEqual([]);

    expect((await listResources(leader, t.db)).canManage).toBe(true);
    const any = asMember.groups[0].items[0];
    expect(await getResourceForEdit(member, any.id, t.db)).toBeNull();
    expect((await getResourceForEdit(leader, any.id, t.db))?.linksText).toContain("Meeting Agenda | https://");
  });

  it("splits approved, waiting (for reviewers, oldest first), and the member's own submissions", async () => {
    await t.db.resource.deleteMany();
    const staff = contextFor(t.db, mentor);
    const file = await createResource(staff, fileForm({ title: "TeleOp code", group: "Code" }));
    const first = await createResource(contextFor(t.db, member), { ...docs, title: "First waiting", group: "Build" });
    await t.db.resource.update({ where: { id: first.id }, data: { createdAt: new Date(TEST_NOW.getTime() - 60_000) } });
    const second = await createResource(contextFor(t.db, member2), fileForm({ title: "Second waiting" }));
    await t.db.resource.update({ where: { id: second.id }, data: { createdAt: TEST_NOW } });
    const turnedDown = await createResource(contextFor(t.db, member), { ...docs, title: "Turned down" });
    await reviewResource(staff, { resourceId: turnedDown.id, decision: "reject", note: "Duplicate of Team Docs" });

    const asMember = await listResources(member, t.db);
    expect(asMember.total).toBe(1);
    expect(asMember.groups.flatMap((g) => g.items.map((i) => i.title))).toEqual(["TeleOp code"]);
    const item = asMember.groups[0].items[0];
    expect(item).toMatchObject({
      kind: "file",
      url: "",
      host: "",
      href: `/resources/files/${file.id}`,
      file: { filename: "TeleOpMain.java", contentType: "text/x-java" },
      status: "APPROVED",
      reviewNote: null,
    });
    expect(item.file).not.toHaveProperty("data");
    expect(asMember.pending).toEqual([]);
    expect(asMember.mine.map((i) => [i.title, i.status, i.reviewNote]).sort()).toEqual([
      ["First waiting", "PENDING", null],
      ["Turned down", "REJECTED", "Duplicate of Team Docs"],
    ]);

    const asLeader = await listResources(leader, t.db);
    expect(asLeader.canReview).toBe(true);
    expect(asLeader.pending.map((i) => i.title)).toEqual(["First waiting", "Second waiting"]);
    expect(asLeader.pending[1]).toMatchObject({ kind: "file", createdByName: "Omar Haddad" });
    expect(asLeader.mine).toEqual([]);
    expect(asLeader.total).toBe(1);
  });
});

describe("edge cases from review", () => {
  it("quick-link URLs and labels may contain '|'", () => {
    expect(parseLinksText("A | B | https://a.example/a|b")).toEqual([{ label: "A | B", url: "https://a.example/a|b" }]);
  });

  it("rejects URLs that would be too long once normalised", () => {
    const long = `https://a.example/${"é".repeat(400)}`; // 418 chars typed, ~2400 once percent-encoded
    expect(long.length).toBeLessThan(2000);
    expect(parseHttpUrl(long)).toBeNull();
  });

  it("hides rows whose main link isn't http(s), even if written straight to the database", async () => {
    await t.db.resource.deleteMany();
    await t.db.resource.create({ data: { title: "Sneaky", url: "data:text/html,<script>alert(1)</script>" } });
    await t.db.resource.create({ data: { title: "Fine", url: "https://ok.example/" } });
    const { groups, total } = await listResources(member, t.db);
    expect(total).toBe(1);
    expect(groups.flatMap((g) => g.items.map((i) => i.title))).toEqual(["Fine"]);
  });
});

describe("resource page", () => {
  async function fileResource(name: string, content: string | Uint8Array, type = "application/octet-stream") {
    const { id } = await createResource(contextFor(t.db, mentor), fileForm({ title: name, file: upload(name, content, type) }));
    return id;
  }

  it("previews small, clean text files; not binaries or big ones", async () => {
    const javaId = await fileResource("Drive.java", "class Drive {\r\n}\r\n");
    const java = await getResourceDetail(member, javaId, t.db);
    expect(java?.preview).toEqual({ kind: "text", text: "class Drive {\n}\n", lineCount: 2 });
    expect(java?.fileViewHref).toBe(`/resources/files/${javaId}`);
    expect(java?.fileDownloadHref).toBe(`/resources/files/${javaId}?download=1`);

    const withNul = await getResourceDetail(member, await fileResource("weird.txt", new Uint8Array([104, 105, 0, 33])), t.db);
    expect(withNul?.preview).toEqual({ kind: "none", reason: "binary" });
    const badUtf8 = await getResourceDetail(member, await fileResource("latin1.txt", new Uint8Array([0x63, 0x61, 0x66, 0xe9])), t.db);
    expect(badUtf8?.preview).toEqual({ kind: "none", reason: "binary" });
    const big = await getResourceDetail(member, await fileResource("huge.log", "x".repeat(TEXT_PREVIEW_MAX_BYTES + 1)), t.db);
    expect(big?.preview).toEqual({ kind: "none", reason: "too-big" });
  });

  it("shows images and PDFs through the file route, and nothing inline for other types", async () => {
    expect((await getResourceDetail(member, await fileResource("robot.PNG", "png"), t.db))?.preview).toEqual({ kind: "image" });
    expect((await getResourceDetail(member, await fileResource("manual.pdf", "%PDF"), t.db))?.preview).toEqual({ kind: "pdf" });
    const html = await getResourceDetail(member, await fileResource("page.html", "<script>alert(1)</script>", "text/html"), t.db);
    expect(html?.preview).toEqual({ kind: "none", reason: "type" });
    expect(html?.fileViewHref).toBeNull();
    expect(html?.fileDownloadHref).toMatch(/\?download=1$/);
  });

  it("link resources have no file preview", async () => {
    const { id } = await createResource(contextFor(t.db, mentor), { ...docs, title: "Docs page" });
    const d = await getResourceDetail(member, id, t.db);
    expect(d).toMatchObject({ kind: "link", href: docs.url, preview: null, fileViewHref: null, fileDownloadHref: null, canEdit: false, canDelete: false });
    expect(await getResourceDetail(member, "missing", t.db)).toBeNull();
  });

  it("edit form data respects who may edit", async () => {
    const { id } = await createResource(contextFor(t.db, member), fileForm({ title: "Edit me" }));
    expect(await getResourceForEdit(member, id, t.db)).toMatchObject({ kind: "file", file: { filename: "TeleOpMain.java" }, status: "PENDING", canDelete: true });
    expect(await getResourceForEdit(member2, id, t.db)).toBeNull();
    expect(await getResourceForEdit(teacher, id, t.db)).toMatchObject({ id });
  });
});

describe("serving files", () => {
  it("decides what the browser may show by extension", () => {
    expect(previewKind("TeleOp.java", "")).toBe("text");
    expect(previewKind("config.XML", "text/xml")).toBe("text");
    expect(previewKind("Makefile", "")).toBe("text");
    expect(previewKind("notes", "text/plain")).toBe("text");
    expect(previewKind("photo.JPG", "image/jpeg")).toBe("image");
    expect(previewKind("rules.pdf", "application/pdf")).toBe("pdf");
    expect(previewKind("logo.svg", "image/svg+xml")).toBe("other");
    expect(previewKind("page.html", "text/plain")).toBe("other");
    expect(previewKind("robot.zip", "application/zip")).toBe("other");
  });

  it("sends text as text/plain with locked-down headers", () => {
    const h = fileResponseHeaders({ filename: "TeleOp.java", contentType: "text/x-java", byteLength: 42 });
    expect(h).toMatchObject({
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Length": "42",
      "Content-Disposition": `inline; filename="TeleOp.java"; filename*=UTF-8''TeleOp.java`,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": FILE_CSP,
      "Cache-Control": "private, no-store",
    });
    expect(FILE_CSP.startsWith("sandbox;")).toBe(true);
    expect(FILE_CSP).toContain("default-src 'none'");
  });

  it("downloads markup, unknown types, and anything with ?download=1", () => {
    for (const [filename, contentType] of [
      ["logo.svg", "image/svg+xml"],
      ["page.html", "text/html"],
      ["robot.zip", "application/zip"],
    ]) {
      const h = fileResponseHeaders({ filename, contentType, byteLength: 1 });
      expect(h["Content-Type"], filename).toBe("application/octet-stream");
      expect(h["Content-Disposition"], filename).toMatch(/^attachment;/);
      expect(h["Content-Security-Policy"]).toBe(FILE_CSP);
    }
    const forced = fileResponseHeaders({ filename: "TeleOp.java", contentType: "", byteLength: 1 }, { download: true });
    expect(forced).toMatchObject({ "Content-Type": "application/octet-stream", "Content-Security-Policy": FILE_CSP });
    expect(forced["Content-Disposition"]).toMatch(/^attachment;/);
  });

  it("shows images and PDFs inline with their own type", () => {
    expect(fileResponseHeaders({ filename: "a.webp", contentType: "", byteLength: 1 })["Content-Type"]).toBe("image/webp");
    const png = fileResponseHeaders({ filename: "a.png", contentType: "text/html", byteLength: 1 });
    expect(png).toMatchObject({ "Content-Type": "image/png", "Content-Security-Policy": FILE_CSP });
    const pdf = fileResponseHeaders({ filename: "rules.pdf", contentType: "", byteLength: 1 });
    // Chrome's PDF viewer won't render sandboxed documents, so inline PDFs drop only `sandbox`.
    expect(pdf).toMatchObject({ "Content-Type": "application/pdf", "Content-Security-Policy": PDF_CSP });
    expect(pdf["Content-Disposition"]).toMatch(/^inline;/);
    expect(PDF_CSP).not.toContain("sandbox");
    expect(PDF_CSP).toContain("default-src 'none'");
    expect(fileResponseHeaders({ filename: "rules.pdf", contentType: "", byteLength: 1 }, { download: true })["Content-Security-Policy"]).toBe(FILE_CSP);
  });

  it("builds Content-Disposition with an ASCII fallback and a UTF-8 name", () => {
    expect(contentDisposition("attachment", `Téléop "v2".java`)).toBe(
      `attachment; filename="T_l_op _v2_.java"; filename*=UTF-8''T%C3%A9l%C3%A9op%20%22v2%22.java`,
    );
    expect(contentDisposition("inline", "it's (1).txt")).toBe(`inline; filename="it's (1).txt"; filename*=UTF-8''it%27s%20%281%29.txt`);
    expect(contentDisposition("inline", "日本.txt")).toBe(`inline; filename="__.txt"; filename*=UTF-8''%E6%97%A5%E6%9C%AC.txt`);
  });

  it("decodes text previews strictly", () => {
    expect(decodeTextPreview(new TextEncoder().encode("a\r\nb\rc"))).toBe("a\nb\nc");
    expect(decodeTextPreview(new Uint8Array([0xff, 0xfe, 0x00]))).toBeNull();
    expect(decodeTextPreview(new Uint8Array([0x61, 0x00]))).toBeNull();
  });
});
