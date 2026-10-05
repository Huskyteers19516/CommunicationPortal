// The Workshop: projects (services/workshop.ts), who sees and changes them (permissions.ts, queries/workshop.ts), the
// way to the team website (DRAFT → PENDING → APPROVED / REJECTED, and back to PENDING after a non-reviewer's change),
// photo and design-file checks, and the public answer the team website reads (public-workshop.ts).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { DEFAULT_PUBLIC_PROGRESS_SETTINGS, PUBLIC_PROGRESS_KEY, serializePublicProgressSettings, TEAM_SITE_ORIGIN } from "@/lib/public-progress";
import {
  WORKSHOP_FILE_TYPES_MESSAGE,
  WORKSHOP_LIMITS,
  WORKSHOP_PHOTO_HEIC_MESSAGE,
  WORKSHOP_PHOTO_TYPES_MESSAGE,
  WORKSHOP_PHOTO_UNREADABLE_MESSAGE,
  workshopFileFormat,
  workshopFileProblem,
  workshopPhotoProblem,
  type PublicWorkshop,
} from "@/lib/workshop";
import { proxy } from "@/proxy";
import type { Actor } from "@/server/actor";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import { imageOrientation } from "@/server/files/image-metadata";
import { fileStorageUsage } from "@/server/files/storage";
import { canDeleteWorkshopProject, canEditWorkshopProject, canReviewWorkshop, canViewWorkshopProject } from "@/server/permissions";
import {
  PUBLIC_CACHE_CONTROL,
  PUBLIC_FILE_IMMUTABLE_CACHE,
  publicWorkshopFileResponse,
  publicWorkshopPhotoResponse,
  publicWorkshopResponse,
} from "@/server/public-api";
import { getPublicWorkshop, publicCredit } from "@/server/queries/public-workshop";
import {
  countPendingWorkshop,
  getWorkshopDownloadFile,
  getWorkshopPeople,
  getWorkshopPhotoFile,
  getWorkshopProject,
  listWorkshopProjects,
  splitExtraCredits,
} from "@/server/queries/workshop";
import {
  addWorkshopFile,
  addWorkshopPhoto,
  createWorkshopProject,
  deleteWorkshopProject,
  moveWorkshopPhoto,
  removeWorkshopFile,
  removeWorkshopPhoto,
  reviewWorkshopProject,
  setWorkshopCover,
  setWorkshopFeatured,
  submitWorkshopProject,
  unpublishWorkshopProject,
  updateWorkshopPhoto,
  updateWorkshopProject,
  WORKSHOP_CANT_DELETE,
  WORKSHOP_CANT_EDIT,
  WORKSHOP_CANT_REVIEW,
  WORKSHOP_CHANGED,
  WORKSHOP_FILE_BYTES_PER_PERSON,
  WORKSHOP_INACTIVE,
  WORKSHOP_LAST_PHOTO,
  WORKSHOP_NEEDS_PHOTO,
  WORKSHOP_NOT_PENDING,
} from "@/server/services/workshop";
import { createTestDb, type TestDb } from "./helpers/db";
import { contextFor, makeUser, TEST_NOW, TEST_TZ } from "./helpers/factories";
import { startFakeS3 } from "./helpers/fake-s3";

let t: TestDb;
let ethan: Actor; // Build member (designs parts)
let isabella: Actor; // Build member (credited on Ethan's parts)
let maya: Actor; // Software member
let marcus: Actor; // Build leader (reviewer)
let jordan: Actor; // Captain (reviewer)
let elena: Actor; // Mentor (reviewer)
let pending: Actor;
let disabled: Actor;

beforeAll(async () => {
  t = await createTestDb();
  ethan = await makeUser(t.db, { name: "Ethan Chen", role: "MEMBER", subteam: "BUILD" });
  isabella = await makeUser(t.db, { name: "Isabella Rossi", role: "MEMBER", subteam: "BUILD" });
  maya = await makeUser(t.db, { name: "Maya Patel", role: "MEMBER", subteam: "SOFTWARE" });
  marcus = await makeUser(t.db, { name: "Marcus Johnson", role: "BUILD_LEADER" });
  jordan = await makeUser(t.db, { name: "Jordan Lee", role: "CAPTAIN" });
  elena = await makeUser(t.db, { name: "Elena Petrova", role: "MENTOR" });
  pending = await makeUser(t.db, { name: "Pat Pending", role: "MEMBER", subteam: "BUILD", status: "PENDING" });
  disabled = await makeUser(t.db, { name: "Dana Gone", role: "MEMBER", subteam: "BUILD", status: "DISABLED" });
});
afterAll(async () => {
  await t.drop();
});
// Every context shares TEST_NOW, so rate-limit windows never roll over within this file: start each test fresh.
beforeEach(async () => {
  await t.db.rateLimit.deleteMany();
});

const ctx = (actor: Actor) => contextFor(t.db, actor);

// ── Fixtures ─────────────────────────────────────────────────────────────────

const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0));
const be16 = (n: number) => [(n >> 8) & 0xff, n & 0xff];
const be32 = (n: number) => [(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** A PNG header claiming `width` × `height` (only the header is read). */
const pngOf = (width: number, height: number) =>
  Uint8Array.from([...PNG_SIG, 0, 0, 0, 13, ...ascii("IHDR"), ...be32(width), ...be32(height), 8, 2, 0, 0, 0, 0, 0, 0, 0]);
const jpegOf = (width: number, height: number) =>
  Uint8Array.from([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x10, ...ascii("JFIF"), 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x11, 0x08, ...be16(height), ...be16(width), 0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
    0xff, 0xd9,
  ]);
const PNG = pngOf(1600, 1200);
const GIF = Uint8Array.from([...ascii("GIF89a"), 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x3b]);
const HEIC = Uint8Array.from([0x00, 0x00, 0x00, 0x18, ...ascii("ftypheic"), 0x00, 0x00, 0x00, 0x00, ...ascii("mif1heic")]);
const PDF = new TextEncoder().encode("%PDF-1.4\n% drawing\n");
const STL = new TextEncoder().encode("solid mount\nendsolid mount\n");
const ZIP = Uint8Array.from([...ascii("PK"), 0x03, 0x04, 0, 0, 0, 0]);

function picked(name: string, bytes: Uint8Array, type = "") {
  return { name, type, bytes };
}

function form(over: Record<string, unknown> = {}) {
  return {
    kind: "PART",
    title: "Claw servo mount",
    summary: "Holds the claw servo on the arm.",
    material: "PETG",
    season: "2025–26",
    extraCredits: "",
    link: "",
    codeLink: "",
    ...over,
  };
}

async function errorOf(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => null,
    (e: unknown) => e,
  );
}

async function fieldError(p: Promise<unknown>, field: string): Promise<string> {
  const e = await errorOf(p);
  expect(e).toBeInstanceOf(ValidationError);
  return (e as ValidationError).fieldErrors[field];
}

/** A project by `who` with one photo (so it can be sent for approval). */
async function projectWithPhoto(who: Actor, over: Record<string, unknown> = {}) {
  const { id } = await createWorkshopProject(ctx(who), form(over));
  const { photoId } = await addWorkshopPhoto(ctx(who), { projectId: id, label: "Version 1", note: "", file: picked("v1.png", PNG) });
  return { id, photoId };
}

/** A project of Ethan's (Isabella credited) that's on the website. */
async function approvedProject(over: Record<string, unknown> = {}) {
  const p = await projectWithPhoto(ethan, { creditIds: [ethan.id, isabella.id], ...over });
  await submitWorkshopProject(ctx(ethan), { projectId: p.id });
  await reviewWorkshopProject(ctx(marcus), { projectId: p.id, decision: "approve" });
  return p;
}

const statusOf = async (id: string) => (await t.db.workshopProject.findUniqueOrThrow({ where: { id }, select: { status: true } })).status;

// ── Projects ─────────────────────────────────────────────────────────────────

describe("adding a project", () => {
  it("starts as a draft, credits people in the order picked, and tidies links", async () => {
    const { id } = await createWorkshopProject(ctx(ethan), {
      ...form({ link: "cad.onshape.com/documents/abc", extraCredits: "Alex Park (2024 alum), Sam" }),
      creditIds: [isabella.id, ethan.id, isabella.id],
    });
    const p = await t.db.workshopProject.findUniqueOrThrow({
      where: { id },
      include: { credits: { orderBy: { position: "asc" } } },
    });
    expect(p).toMatchObject({ status: "DRAFT", kind: "PART", createdById: ethan.id, link: "https://cad.onshape.com/documents/abc", material: "PETG" });
    expect(p.credits.map((c) => c.userId)).toEqual([isabella.id, ethan.id]);
    expect(splitExtraCredits(p.extraCredits)).toEqual(["Alex Park (2024 alum)", "Sam"]);
  });

  it("checks the fields", async () => {
    expect(await fieldError(createWorkshopProject(ctx(ethan), form({ title: "  " })), "title")).toBe("Name is required.");
    expect(await fieldError(createWorkshopProject(ctx(ethan), form({ summary: "" })), "summary")).toBe("What it does is required.");
    expect(await fieldError(createWorkshopProject(ctx(ethan), form({ kind: "ROBOT" })), "kind")).toBe("Pick what kind of project it is.");
    expect(await fieldError(createWorkshopProject(ctx(ethan), form({ link: "javascript:alert(1)" })), "link")).toMatch(/web link/);
    expect(await fieldError(createWorkshopProject(ctx(ethan), form({ codeLink: "not a link" })), "codeLink")).toMatch(/github/);
    expect(await fieldError(createWorkshopProject(ctx(ethan), form({ title: "x".repeat(WORKSHOP_LIMITS.titleMax + 1) })), "title")).toMatch(/at most/);
  });

  it("only credits people on the team, and up to the limit", async () => {
    expect(await fieldError(createWorkshopProject(ctx(ethan), { ...form(), creditIds: [disabled.id] }), "creditIds")).toMatch(/isn't on the team/);
    expect(await fieldError(createWorkshopProject(ctx(ethan), { ...form(), creditIds: [pending.id] }), "creditIds")).toMatch(/isn't on the team/);
    const many = Array.from({ length: WORKSHOP_LIMITS.creditsMax + 1 }, (_, i) => `id${i}`);
    expect(await fieldError(createWorkshopProject(ctx(ethan), { ...form(), creditIds: many }), "creditIds")).toMatch(/Other people/);
  });

  it("needs an active account", async () => {
    for (const who of [pending, disabled]) {
      const e = await errorOf(createWorkshopProject(ctx(who), form()));
      expect(e).toBeInstanceOf(ForbiddenError);
      expect((e as ForbiddenError).userMessage).toBe(WORKSHOP_INACTIVE);
    }
  });
});

describe("who sees and changes a project", () => {
  it("permissions: whoever added it and the people credited change it; reviewers change and approve any", () => {
    const p = { createdById: ethan.id, creditUserIds: [isabella.id] };
    expect(canEditWorkshopProject(ethan, p)).toBe(true);
    expect(canEditWorkshopProject(isabella, p)).toBe(true);
    expect(canEditWorkshopProject(maya, p)).toBe(false);
    for (const reviewer of [marcus, jordan, elena]) {
      expect(canEditWorkshopProject(reviewer, p)).toBe(true);
      expect(canReviewWorkshop(reviewer)).toBe(true);
      expect(canDeleteWorkshopProject(reviewer, p)).toBe(true);
    }
    expect(canReviewWorkshop(ethan)).toBe(false);
    expect(canDeleteWorkshopProject(ethan, p)).toBe(true);
    expect(canDeleteWorkshopProject(isabella, p)).toBe(false);
    expect(canViewWorkshopProject(maya, { ...p, status: "DRAFT" })).toBe(false);
    expect(canViewWorkshopProject(maya, { ...p, status: "APPROVED" })).toBe(true);
  });

  it("drafts are only seen by the people who can change them; approved ones by everyone", async () => {
    const { id, photoId } = await projectWithPhoto(ethan, { creditIds: [isabella.id] });
    expect(await getWorkshopProject(maya, id, t.db)).toBeNull();
    expect(await getWorkshopPhotoFile(maya, photoId, t.db)).toBeNull();
    expect((await getWorkshopProject(isabella, id, t.db))?.canEdit).toBe(true);
    const asReviewer = await getWorkshopProject(marcus, id, t.db);
    expect(asReviewer).toMatchObject({ canEdit: true, canDelete: true, canReview: true, status: "DRAFT" });
    expect(asReviewer!.photos).toEqual([expect.objectContaining({ id: photoId, label: "Version 1", isCover: true, width: 1600, height: 1200 })]);

    await submitWorkshopProject(ctx(jordan), { projectId: id }); // a reviewer publishes it
    const asMaya = await getWorkshopProject(maya, id, t.db);
    expect(asMaya).toMatchObject({ canEdit: false, canDelete: false, canReview: false, status: "APPROVED" });
    expect(await getWorkshopPhotoFile(maya, photoId, t.db)).not.toBeNull();
    expect(await getWorkshopProject(pending, id, t.db)).toBeNull();
  });

  it("someone else can't change, remove, or add to it", async () => {
    const { id, photoId } = await projectWithPhoto(ethan);
    // One at a time (each started only when it's checked).
    for (const attempt of [
      () => updateWorkshopProject(ctx(maya), { ...form(), projectId: id }),
      () => addWorkshopPhoto(ctx(maya), { projectId: id, file: picked("x.png", PNG) }),
      () => addWorkshopFile(ctx(maya), { projectId: id, file: picked("x.stl", STL) }),
      () => updateWorkshopPhoto(ctx(maya), { photoId, label: "Hacked" }),
      () => moveWorkshopPhoto(ctx(maya), { photoId, direction: "down" }),
      () => setWorkshopCover(ctx(maya), { photoId }),
      () => removeWorkshopPhoto(ctx(maya), { photoId }),
      () => submitWorkshopProject(ctx(maya), { projectId: id }),
      () => unpublishWorkshopProject(ctx(maya), { projectId: id }),
    ]) {
      const e = await errorOf(attempt());
      expect(e).toBeInstanceOf(ForbiddenError);
      expect((e as ForbiddenError).userMessage).toBe(WORKSHOP_CANT_EDIT);
    }
    const del = await errorOf(deleteWorkshopProject(ctx(maya), { projectId: id }));
    expect((del as ForbiddenError).userMessage).toBe(WORKSHOP_CANT_DELETE);
  });

  it("people credited change it but can't remove it; whoever added it removes it with its photos and files", async () => {
    const { id } = await projectWithPhoto(ethan, { creditIds: [ethan.id, isabella.id] });
    await addWorkshopFile(ctx(ethan), { projectId: id, file: picked("mount.stl", STL) });
    await updateWorkshopProject(ctx(isabella), { ...form({ title: "Claw servo mount v2" }), projectId: id, creditIds: [ethan.id, isabella.id] });
    expect((await t.db.workshopProject.findUniqueOrThrow({ where: { id } })).title).toBe("Claw servo mount v2");
    expect(await errorOf(deleteWorkshopProject(ctx(isabella), { projectId: id }))).toBeInstanceOf(ForbiddenError);
    expect(await deleteWorkshopProject(ctx(ethan), { projectId: id })).toEqual({ title: "Claw servo mount v2" });
    expect(await t.db.workshopPhoto.count({ where: { projectId: id } })).toBe(0);
    expect(await t.db.workshopFile.count({ where: { projectId: id } })).toBe(0);
    expect(await errorOf(deleteWorkshopProject(ctx(ethan), { projectId: id }))).toBeInstanceOf(NotFoundError);
  });

  it("keeps a credited person who has since left, but doesn't let anyone add one", async () => {
    const gone = await makeUser(t.db, { name: "Riley Graduated", role: "MEMBER", subteam: "BUILD" });
    const { id } = await createWorkshopProject(ctx(ethan), { ...form(), creditIds: [gone.id] });
    await t.db.user.update({ where: { id: gone.id }, data: { status: "DISABLED" } });
    await updateWorkshopProject(ctx(ethan), { ...form({ title: "Renamed" }), projectId: id, creditIds: [gone.id, ethan.id] });
    const credits = await t.db.workshopCredit.findMany({ where: { projectId: id }, orderBy: { position: "asc" } });
    expect(credits.map((c) => c.userId)).toEqual([gone.id, ethan.id]);
    expect(await getWorkshopPeople(ethan, t.db)).not.toContainEqual(expect.objectContaining({ id: gone.id }));
  });
});

// ── On its way to the website ────────────────────────────────────────────────

describe("approval", () => {
  it("needs a photo before it can be sent", async () => {
    const { id } = await createWorkshopProject(ctx(ethan), form());
    const e = await errorOf(submitWorkshopProject(ctx(ethan), { projectId: id }));
    expect(e).toBeInstanceOf(ConflictError);
    expect((e as ConflictError).userMessage).toBe(WORKSHOP_NEEDS_PHOTO);
    expect(await errorOf(submitWorkshopProject(ctx(marcus), { projectId: id }))).toBeInstanceOf(ConflictError);
  });

  it("a member sends it; a reviewer approves it (on the website, published now) or sends it back with a note", async () => {
    const { id } = await projectWithPhoto(ethan);
    expect(await submitWorkshopProject(ctx(ethan), { projectId: id })).toEqual({ status: "PENDING" });
    expect(await errorOf(submitWorkshopProject(ctx(ethan), { projectId: id }))).toBeInstanceOf(ConflictError);
    expect(await countPendingWorkshop(marcus, t.db)).toBeGreaterThan(0);
    expect(await countPendingWorkshop(ethan, t.db)).toBe(0);

    const notReviewer = await errorOf(reviewWorkshopProject(ctx(ethan), { projectId: id, decision: "approve" }));
    expect((notReviewer as ForbiddenError).userMessage).toBe(WORKSHOP_CANT_REVIEW);
    expect(await fieldError(reviewWorkshopProject(ctx(marcus), { projectId: id, decision: "reject" }), "note")).toMatch(/what needs to change/);

    await reviewWorkshopProject(ctx(marcus), { projectId: id, decision: "reject", note: "Add a photo of the finished part." });
    let p = await t.db.workshopProject.findUniqueOrThrow({ where: { id } });
    expect(p).toMatchObject({ status: "REJECTED", reviewNote: "Add a photo of the finished part.", reviewedById: marcus.id, publishedAt: null });
    expect((await getWorkshopProject(ethan, id, t.db))?.reviewedByName).toBe("Marcus Johnson");

    const late = await errorOf(reviewWorkshopProject(ctx(jordan), { projectId: id, decision: "approve" }));
    expect((late as ConflictError).userMessage).toBe(WORKSHOP_NOT_PENDING);

    await submitWorkshopProject(ctx(ethan), { projectId: id });
    expect(await reviewWorkshopProject(ctx(jordan), { projectId: id, decision: "approve" })).toMatchObject({ status: "APPROVED" });
    p = await t.db.workshopProject.findUniqueOrThrow({ where: { id } });
    expect(p).toMatchObject({ status: "APPROVED", reviewNote: "", reviewedById: jordan.id });
    expect(p.publishedAt).toEqual(TEST_NOW);
  });

  it("reviewers publish their own straight away; anyone who can change it takes it off the website", async () => {
    const { id } = await projectWithPhoto(marcus);
    expect(await submitWorkshopProject(ctx(marcus), { projectId: id })).toEqual({ status: "APPROVED" });
    expect(await errorOf(submitWorkshopProject(ctx(marcus), { projectId: id }))).toBeInstanceOf(ConflictError);
    await unpublishWorkshopProject(ctx(marcus), { projectId: id });
    expect(await statusOf(id)).toBe("DRAFT");
    expect(await errorOf(unpublishWorkshopProject(ctx(marcus), { projectId: id }))).toBeInstanceOf(ConflictError);

    const mine = await projectWithPhoto(ethan);
    await submitWorkshopProject(ctx(ethan), { projectId: mine.id });
    await unpublishWorkshopProject(ctx(ethan), { projectId: mine.id }); // withdraws it
    expect(await statusOf(mine.id)).toBe("DRAFT");
  });

  it("featuring is for reviewers", async () => {
    const { id } = await approvedProject();
    expect(await errorOf(setWorkshopFeatured(ctx(ethan), { projectId: id, featured: "on" }))).toBeInstanceOf(ForbiddenError);
    expect(await setWorkshopFeatured(ctx(elena), { projectId: id, featured: "on" })).toEqual({ featured: true });
    expect(await setWorkshopFeatured(ctx(elena), { projectId: id })).toEqual({ featured: false });
  });
});

describe("changes to a project on the website", () => {
  it("adding or rewriting by a member sends it back for approval", async () => {
    const a = await approvedProject();
    const r = await updateWorkshopProject(ctx(isabella), { ...form({ summary: "Now holds two servos." }), projectId: a.id, creditIds: [ethan.id, isabella.id] });
    expect(r.sentForApproval).toBe(true);
    expect(await statusOf(a.id)).toBe("PENDING");

    const b = await approvedProject();
    expect((await addWorkshopPhoto(ctx(ethan), { projectId: b.id, label: "Version 2", file: picked("v2.png", PNG) })).sentForApproval).toBe(true);

    const c = await approvedProject();
    expect((await updateWorkshopPhoto(ctx(ethan), { photoId: c.photoId, label: "Version 1", note: "Cracked at the screw holes." })).sentForApproval).toBe(true);

    const d = await approvedProject();
    expect((await addWorkshopFile(ctx(ethan), { projectId: d.id, file: picked("mount.step", STL) })).sentForApproval).toBe(true);
    expect(await statusOf(d.id)).toBe("PENDING");
  });

  it("saving it unchanged, removing, reordering, or picking the cover keeps it on the website", async () => {
    const a = await approvedProject();
    const same = await updateWorkshopProject(ctx(ethan), { ...form(), projectId: a.id, creditIds: [ethan.id, isabella.id] });
    expect(same.sentForApproval).toBe(false);
    const unchangedCaption = await updateWorkshopPhoto(ctx(ethan), { photoId: a.photoId, label: "Version 1", note: "" });
    expect(unchangedCaption.sentForApproval).toBe(false);

    // A reviewer's additions don't need approval.
    const { photoId: second } = await addWorkshopPhoto(ctx(marcus), { projectId: a.id, label: "Version 2", file: picked("v2.png", PNG) });
    const { fileId } = await addWorkshopFile(ctx(marcus), { projectId: a.id, file: picked("mount.stl", STL) });
    expect(await statusOf(a.id)).toBe("APPROVED");

    await moveWorkshopPhoto(ctx(ethan), { photoId: second, direction: "up" });
    await setWorkshopCover(ctx(ethan), { photoId: second });
    await removeWorkshopFile(ctx(ethan), { fileId });
    await removeWorkshopPhoto(ctx(isabella), { photoId: a.photoId });
    expect(await statusOf(a.id)).toBe("APPROVED");
  });

  it("keeps at least one photo while it's on the website or waiting for approval", async () => {
    const waiting = await projectWithPhoto(ethan);
    await submitWorkshopProject(ctx(ethan), { projectId: waiting.id });
    const pendingError = await errorOf(removeWorkshopPhoto(ctx(ethan), { photoId: waiting.photoId }));
    expect((pendingError as ConflictError).userMessage).toBe(WORKSHOP_LAST_PHOTO);

    const a = await approvedProject();
    const e = await errorOf(removeWorkshopPhoto(ctx(ethan), { photoId: a.photoId }));
    expect((e as ConflictError).userMessage).toBe(WORKSHOP_LAST_PHOTO);
    await unpublishWorkshopProject(ctx(ethan), { projectId: a.id });
    await removeWorkshopPhoto(ctx(ethan), { photoId: a.photoId });
    expect(await t.db.workshopPhoto.count({ where: { projectId: a.id } })).toBe(0);
  });
});

// ── Photos ───────────────────────────────────────────────────────────────────

describe("photos", () => {
  it("are PNG, JPG, or WebP by their contents, with a readable size; the stored name and type match", async () => {
    const { id } = await createWorkshopProject(ctx(ethan), form());
    const add = (file: unknown) => addWorkshopPhoto(ctx(ethan), { projectId: id, file });
    const { photoId } = await add(picked("IMG_0001.HEIC", jpegOf(4032, 3024), "image/heic"));
    expect(await t.db.workshopPhoto.findUniqueOrThrow({ where: { id: photoId } })).toMatchObject({
      filename: "IMG_0001.jpg",
      contentType: "image/jpeg",
      width: 4032,
      height: 3024,
      uploadedById: ethan.id,
      position: 0,
    });
    expect(await fieldError(add(picked("anim.gif", GIF, "image/gif")), "file")).toBe(WORKSHOP_PHOTO_TYPES_MESSAGE);
    expect(await fieldError(add(picked("flyer.pdf", PDF)), "file")).toBe(WORKSHOP_PHOTO_TYPES_MESSAGE);
    expect(await fieldError(add(picked("photo.heic", HEIC)), "file")).toBe(WORKSHOP_PHOTO_HEIC_MESSAGE);
    expect(await fieldError(add(picked("x.png", Uint8Array.from(PNG_SIG))), "file")).toBe(WORKSHOP_PHOTO_UNREADABLE_MESSAGE);
    expect(await fieldError(add(picked("huge.png", pngOf(30_000, 30_000))), "file")).toMatch(/too big to show on phones/);
    expect(await fieldError(add(undefined), "file")).toBe("Choose a photo to add.");
    expect(await fieldError(add(picked("big.png", new Uint8Array(5 * 1024 * 1024))), "file")).toMatch(/Photos can be up to 4 MB/);
  });

  it("go in story order, move up and down; without a pick, a part's cover is its newest version", async () => {
    const { id } = await createWorkshopProject(ctx(ethan), form());
    const ids: string[] = [];
    for (const label of ["Version 1", "Version 2", "Version 3"]) {
      ids.push((await addWorkshopPhoto(ctx(ethan), { projectId: id, label, file: picked(`${label}.png`, PNG) })).photoId);
    }
    const order = async () => (await getWorkshopProject(ethan, id, t.db))!.photos.map((p) => p.label);
    expect(await order()).toEqual(["Version 1", "Version 2", "Version 3"]);
    await moveWorkshopPhoto(ctx(ethan), { photoId: ids[2], direction: "up" });
    expect(await order()).toEqual(["Version 1", "Version 3", "Version 2"]);
    await moveWorkshopPhoto(ctx(ethan), { photoId: ids[0], direction: "up" }); // already first: nothing happens
    await moveWorkshopPhoto(ctx(ethan), { photoId: ids[1], direction: "down" }); // already last
    expect(await order()).toEqual(["Version 1", "Version 3", "Version 2"]);

    const cover = async () => (await getWorkshopProject(ethan, id, t.db))!.photos.find((p) => p.isCover)?.label;
    expect(await cover()).toBe("Version 2"); // the last one
    await setWorkshopCover(ctx(ethan), { photoId: ids[0] });
    expect(await cover()).toBe("Version 1");
    await removeWorkshopPhoto(ctx(ethan), { photoId: ids[0] });
    expect(await cover()).toBe("Version 2"); // the pick is gone: the newest again
    await updateWorkshopProject(ctx(ethan), { ...form({ kind: "SOFTWARE" }), projectId: id });
    expect(await cover()).toBe("Version 3"); // software: the first photo
    expect(await errorOf(setWorkshopCover(ctx(ethan), { photoId: ids[0] }))).toBeInstanceOf(NotFoundError);
  });

  it("a project has at most the limit", async () => {
    const { id } = await createWorkshopProject(ctx(marcus), form());
    await t.db.workshopPhoto.createMany({
      data: Array.from({ length: WORKSHOP_LIMITS.photosPerProject }, (_, i) => ({
        projectId: id,
        position: i,
        filename: `p${i}.png`,
        contentType: "image/png",
        size: PNG.byteLength,
        data: PNG,
        width: 1,
        height: 1,
      })),
    });
    expect(await fieldError(addWorkshopPhoto(ctx(marcus), { projectId: id, file: picked("one-more.png", PNG) }), "file")).toMatch(
      new RegExp(`up to ${WORKSHOP_LIMITS.photosPerProject} photos`),
    );
  });

  it("each person's uploads stay under their allowance (admin access isn't limited)", async () => {
    const who = await makeUser(t.db, { name: "Big Uploader", role: "MEMBER", subteam: "BUILD" });
    const { id } = await createWorkshopProject(ctx(who), form());
    await t.db.workshopFile.create({
      data: { projectId: id, filename: "huge.zip", contentType: "application/octet-stream", size: WORKSHOP_FILE_BYTES_PER_PERSON - 10, data: ZIP, uploadedById: who.id },
    });
    expect(await fieldError(addWorkshopPhoto(ctx(who), { projectId: id, file: picked("v1.png", PNG) }), "file")).toMatch(/each person can have up to 60 MB/);
    expect(await fieldError(addWorkshopFile(ctx(who), { projectId: id, file: picked("a.stl", STL) }), "file")).toMatch(/each person can have up to 60 MB/);

    // Someone with admin access who has uploaded just as much themselves isn't limited.
    const { id: theirs } = await createWorkshopProject(ctx(marcus), form());
    await t.db.workshopFile.create({
      data: { projectId: theirs, filename: "huge.zip", contentType: "application/octet-stream", size: WORKSHOP_FILE_BYTES_PER_PERSON - 10, data: ZIP, uploadedById: marcus.id },
    });
    await addWorkshopPhoto(ctx(marcus), { projectId: theirs, file: picked("v1.png", PNG) });
    expect((await fileStorageUsage(t.db, false)).workshop).toBeGreaterThan(2 * (WORKSHOP_FILE_BYTES_PER_PERSON - 10));
  });
});

// ── Design files ─────────────────────────────────────────────────────────────

describe("design files", () => {
  it("take CAD, printing, PDF, and ZIP files, stored as downloads", async () => {
    const { id } = await createWorkshopProject(ctx(ethan), form());
    const add = (file: unknown, label = "") => addWorkshopFile(ctx(ethan), { projectId: id, label, file });
    const { fileId } = await add(picked("Mount.STL", STL, "model/stl"), "Print-ready STL");
    expect(await t.db.workshopFile.findUniqueOrThrow({ where: { id: fileId } })).toMatchObject({
      filename: "Mount.STL",
      contentType: "application/octet-stream",
      label: "Print-ready STL",
    });
    const pdf = await add(picked("drawing.pdf", PDF, "application/pdf"));
    expect((await t.db.workshopFile.findUniqueOrThrow({ where: { id: pdf.fileId } })).contentType).toBe("application/pdf");
    await add(picked("plate.3mf", ZIP));
    await add(picked("arm.x_t", STL));

    expect(await fieldError(add(picked("notes.txt", STL)), "file")).toBe(WORKSHOP_FILE_TYPES_MESSAGE);
    expect(await fieldError(add(picked("setup.exe", STL)), "file")).toBe(WORKSHOP_FILE_TYPES_MESSAGE);
    expect(await fieldError(add(picked("page.html", STL)), "file")).toBe(WORKSHOP_FILE_TYPES_MESSAGE);
    expect(await fieldError(add(picked("fake.pdf", STL)), "file")).toMatch(/isn't a real PDF/);
    expect(await fieldError(add(picked("fake.zip", STL)), "file")).toMatch(/isn't a real \.zip/);
    expect(await fieldError(add(picked("big.stl", new Uint8Array(5 * 1024 * 1024))), "file")).toMatch(/with a link instead/);
  });

  it("a project has at most the limit; removing one frees a place", async () => {
    const { id } = await createWorkshopProject(ctx(marcus), form());
    const ids: string[] = [];
    for (let i = 0; i < WORKSHOP_LIMITS.filesPerProject; i++) {
      ids.push((await addWorkshopFile(ctx(marcus), { projectId: id, file: picked(`part${i}.stl`, STL) })).fileId);
    }
    expect(await fieldError(addWorkshopFile(ctx(marcus), { projectId: id, file: picked("more.stl", STL) }), "file")).toMatch(/Zip some together/);
    await removeWorkshopFile(ctx(marcus), { fileId: ids[0] });
    await addWorkshopFile(ctx(marcus), { projectId: id, file: picked("more.stl", STL) });
    expect(await errorOf(removeWorkshopFile(ctx(marcus), { fileId: ids[0] }))).toBeInstanceOf(NotFoundError);
  });

  it("the browser checks match", () => {
    expect(workshopFileFormat("bracket.stl")).toBe("STL");
    expect(workshopFileFormat("README")).toBe("FILE");
    expect(workshopFileProblem({ name: "a.step", size: 10 }, 100)).toBeNull();
    expect(workshopFileProblem({ name: "a.step", size: 200 }, 100)).toMatch(/with a link instead/);
    expect(workshopFileProblem({ name: "a.exe", size: 10 }, 100)).toBe(WORKSHOP_FILE_TYPES_MESSAGE);
    expect(workshopPhotoProblem({ name: "IMG.HEIC", type: "", size: 10 })).toBe(WORKSHOP_PHOTO_HEIC_MESSAGE);
    expect(workshopPhotoProblem({ name: "a.gif", type: "image/gif", size: 10 })).toBe(WORKSHOP_PHOTO_TYPES_MESSAGE);
    expect(workshopPhotoProblem({ name: "a.jpg", type: "image/jpeg", size: 10 })).toBeNull();
  });
});

// ── Lists ────────────────────────────────────────────────────────────────────

describe("the Workshop page's lists", () => {
  it("split what's on the website from the rest, and show reviewers what's waiting", async () => {
    const who = await makeUser(t.db, { name: "List Tester", role: "MEMBER", subteam: "SOFTWARE" });
    const live = await projectWithPhoto(who, { kind: "SOFTWARE", title: "Inventory program", material: "Python" });
    await submitWorkshopProject(ctx(jordan), { projectId: live.id });
    const waiting = await projectWithPhoto(who, { kind: "SOFTWARE", title: "Scouting app" });
    await submitWorkshopProject(ctx(who), { projectId: waiting.id });
    await createWorkshopProject(ctx(who), form({ kind: "SOFTWARE", title: "Draft idea" }));

    const mine = (view: "website" | "drafts" | "review", actor: Actor = who) =>
      listWorkshopProjects(actor, { view, kind: "SOFTWARE", mine: actor.id === who.id }, t.db);
    const website = await mine("website");
    expect(website.items.map((p) => p.title)).toEqual(["Inventory program"]);
    expect(website.items[0]).toMatchObject({ photoCount: 1, fileCount: 0, designers: [], cover: { width: 1600, height: 1200 } });
    expect(website.counts).toEqual({ website: 1, drafts: 2, review: 0 });
    expect(website.reviewer).toBe(false);
    expect((await mine("review")).items.map((p) => p.title)).toEqual(["Inventory program"]); // not a reviewer: the website tab

    // Maya sees only what's on the website.
    const other = await listWorkshopProjects(maya, { view: "drafts", kind: "SOFTWARE", mine: false }, t.db);
    expect(other.items.map((p) => p.title)).not.toContain("Draft idea");
    expect(other.items.map((p) => p.title)).not.toContain("Scouting app");

    const reviewer = await listWorkshopProjects(marcus, { view: "review", kind: "SOFTWARE", mine: false }, t.db);
    expect(reviewer.reviewer).toBe(true);
    expect(reviewer.items.map((p) => p.title)).toContain("Scouting app");
    expect(reviewer.items.every((p) => p.status === "PENDING")).toBe(true);
  });
});

// ── The team website ─────────────────────────────────────────────────────────

describe("the public answer", () => {
  it("lists only approved projects, featured first, with names, photos in story order, and downloads", async () => {
    const draft = await projectWithPhoto(ethan, { title: "Secret draft" });
    const waiting = await projectWithPhoto(ethan, { title: "Waiting part" });
    await submitWorkshopProject(ctx(ethan), { projectId: waiting.id });

    const part = await approvedProject({
      title: "Intake roller",
      link: "https://cad.onshape.com/documents/xyz",
      extraCredits: "Alex Park",
    });
    const v2 = await addWorkshopPhoto(ctx(marcus), { projectId: part.id, label: "Version 2", note: "PETG, with fillets.", file: picked("v2.png", pngOf(800, 600)) });
    await setWorkshopCover(ctx(marcus), { photoId: v2.photoId });
    await addWorkshopFile(ctx(marcus), { projectId: part.id, label: "Print-ready STL", file: picked("roller.stl", STL) });
    const featured = await approvedProject({ title: "Featured bracket" });
    await setWorkshopFeatured(ctx(marcus), { projectId: featured.id, featured: "on" });

    const answer = await getPublicWorkshop(t.db, { now: TEST_NOW });
    expect(answer.updatedAt).toBe(TEST_NOW.toISOString());
    const titles = answer.projects.map((p) => p.title);
    expect(titles[0]).toBe("Featured bracket");
    expect(titles).toContain("Intake roller");
    expect(titles).not.toContain("Secret draft");
    expect(titles).not.toContain("Waiting part");
    expect(answer.projects.every((p) => p.id !== draft.id && p.id !== waiting.id)).toBe(true);

    const roller = answer.projects.find((p) => p.id === part.id)!;
    expect(roller).toMatchObject({
      kind: "PART",
      material: "PETG",
      season: "2025–26",
      designers: ["Ethan Chen", "Isabella Rossi", "Alex Park"],
      link: "https://cad.onshape.com/documents/xyz",
      codeLink: null,
      featured: false,
      publishedAt: TEST_NOW.toISOString(),
    });
    expect(roller.photos.map((p) => p.label)).toEqual(["Version 1", "Version 2"]);
    expect(roller.cover).toEqual({ id: v2.photoId, path: `/api/public/workshop/photos/${v2.photoId}`, width: 800, height: 600, label: "Version 2", note: "PETG, with fillets." });
    expect(roller.downloads).toEqual([
      { id: expect.any(String), path: expect.stringMatching(/^\/api\/public\/workshop\/files\//), filename: "roller.stl", format: "STL", size: STL.byteLength, label: "Print-ready STL" },
    ]);
  });

  it("never carries emails, account ids, review notes, or who added or reviewed it", async () => {
    const p = await approvedProject({ title: "Privacy check" });
    const json = JSON.stringify(await getPublicWorkshop(t.db, { now: TEST_NOW }));
    for (const who of [ethan, isabella, marcus]) {
      expect(json).not.toContain(who.email);
      expect(json).not.toContain(who.id);
    }
    const project = (JSON.parse(json) as PublicWorkshop).projects.find((x) => x.id === p.id)!;
    expect(Object.keys(project).sort()).toEqual(
      ["codeLink", "cover", "designers", "downloads", "featured", "id", "kind", "link", "material", "photos", "publishedAt", "season", "summary", "title", "updatedAt"].sort(),
    );
  });

  it("shows names the way the team website's settings say", async () => {
    const p = await approvedProject({ title: "Name style check", extraCredits: "Alex Park" });
    const designers = async () => (await getPublicWorkshop(t.db, { now: TEST_NOW })).projects.find((x) => x.id === p.id)!.designers;
    const setStyle = (nameStyle: "full" | "first-initial" | "initials" | "hidden") =>
      t.db.teamNote.upsert({
        where: { key: PUBLIC_PROGRESS_KEY },
        create: { key: PUBLIC_PROGRESS_KEY, body: serializePublicProgressSettings({ ...DEFAULT_PUBLIC_PROGRESS_SETTINGS, nameStyle }) },
        update: { body: serializePublicProgressSettings({ ...DEFAULT_PUBLIC_PROGRESS_SETTINGS, nameStyle }) },
      });
    await setStyle("first-initial");
    expect(await designers()).toEqual(["Ethan C.", "Isabella R.", "Alex P."]);
    await setStyle("hidden");
    expect(await designers()).toEqual([]);
    await setStyle("full");
    expect(await designers()).toEqual(["Ethan Chen", "Isabella Rossi", "Alex Park"]);
  });
});

describe("GET /api/public/workshop", () => {
  const url = "https://communication-portal-iota.vercel.app/api/public/workshop";
  const call = (init: RequestInit & { origin?: string } = {}, extraOrigins?: string) => {
    const headers = new Headers(init.headers);
    if (init.origin) headers.set("origin", init.origin);
    return publicWorkshopResponse(new Request(url, { ...init, headers }), { db: t.db, now: TEST_NOW, teamTimezone: TEST_TZ, extraOrigins });
  };

  it("lets the team website read it, cached briefly and never sniffed", async () => {
    await approvedProject({ title: "Endpoint check" });
    const res = await call({ origin: TEAM_SITE_ORIGIN });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(TEAM_SITE_ORIGIN);
    expect(res.headers.get("vary")).toBe("Origin");
    expect(res.headers.get("cache-control")).toBe(PUBLIC_CACHE_CONTROL);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
    expect(((await res.json()) as PublicWorkshop).projects.length).toBeGreaterThan(0);
    expect((await call({ origin: "https://evil.example" })).headers.get("access-control-allow-origin")).toBe(TEAM_SITE_ORIGIN);
    expect((await call({ origin: "http://localhost:4321" }, "http://localhost:4321")).headers.get("access-control-allow-origin")).toBe("http://localhost:4321");
  });

  it("answers HEAD and the preflight, refuses other methods, and a 503 when the database fails", async () => {
    const head = await call({ method: "HEAD" });
    expect([head.status, await head.text()]).toEqual([200, ""]);
    const preflight = await call({ method: "OPTIONS", origin: TEAM_SITE_ORIGIN });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-methods")).toBe("GET, HEAD, OPTIONS");
    expect((await call({ method: "POST", body: "{}" })).status).toBe(405);

    const broken = new Proxy(t.db, { get: (target, key) => (key === "workshopProject" ? undefined : Reflect.get(target, key, target)) });
    const failed = await publicWorkshopResponse(new Request(url), { db: broken, now: TEST_NOW, teamTimezone: TEST_TZ });
    expect(failed.status).toBe(503);
    expect(failed.headers.get("cache-control")).toBe("no-store");
  });

  it("gets through the proxy without a session", () => {
    const visit = (path: string) => proxy(new NextRequest(`http://localhost${path}`));
    expect(visit("/api/public/workshop").headers.get("x-middleware-next")).toBe("1");
    expect(visit("/api/public/workshop/photos/abc").headers.get("x-middleware-next")).toBe("1");
    expect(visit("/api/public/workshop/files/abc").headers.get("x-middleware-next")).toBe("1");
  });
});

describe("public photos and design files", () => {
  const get = (what: "photo" | "file", id: string, query = "") => {
    const request = new NextRequest(`http://localhost/api/public/workshop/${what}s/${id}${query}`);
    return (what === "photo" ? publicWorkshopPhotoResponse : publicWorkshopFileResponse)(request, { db: t.db, id, store: null });
  };

  it("are served for approved projects only: photos inline for the website, design files as downloads", async () => {
    const p = await approvedProject({ title: "Served part" });
    const { fileId } = await addWorkshopFile(ctx(marcus), { projectId: p.id, file: picked("served.stl", STL) });

    const photo = await get("photo", p.photoId);
    expect(photo.status).toBe(200);
    expect(photo.headers.get("content-type")).toBe("image/png");
    expect(photo.headers.get("content-disposition")).toMatch(/^inline; filename="workshop-photo.png"/); // never the uploaded name
    expect(photo.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
    expect(photo.headers.get("cache-control")).toBe(PUBLIC_FILE_IMMUTABLE_CACHE);
    expect(photo.headers.get("x-content-type-options")).toBe("nosniff");
    expect(photo.headers.get("content-security-policy")).toMatch(/sandbox/);
    expect(new Uint8Array(await photo.arrayBuffer())).toEqual(PNG);

    const file = await get("file", fileId);
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toBe("application/octet-stream");
    expect(file.headers.get("content-disposition")).toMatch(/^attachment; filename="served.stl"/);
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(STL);

    // A query string goes to the bare address first (one CDN copy per file), before anything is read.
    const busted = await get("photo", p.photoId, "?cb=1");
    expect([busted.status, busted.headers.get("location")]).toEqual([308, `/api/public/workshop/photos/${p.photoId}`]);
    // A photo id served as a file (and the other way round) isn't found.
    expect((await get("file", p.photoId)).status).toBe(404);
    expect((await get("photo", fileId)).status).toBe(404);

    await unpublishWorkshopProject(ctx(ethan), { projectId: p.id });
    const gone = await get("photo", p.photoId);
    expect(gone.status).toBe(404);
    expect(gone.headers.get("cache-control")).toBe("private, no-store");
    expect((await get("file", fileId)).status).toBe(404);
    expect((await get("photo", "x".repeat(65))).status).toBe(404);
  });

  it("the signed-in file routes' queries follow who can see the project", async () => {
    const { id, photoId } = await projectWithPhoto(ethan);
    const { fileId } = await addWorkshopFile(ctx(ethan), { projectId: id, file: picked("draft.stl", STL) });
    expect(await getWorkshopDownloadFile(ethan, fileId, t.db)).not.toBeNull();
    expect(await getWorkshopDownloadFile(maya, fileId, t.db)).toBeNull();
    expect(await getWorkshopDownloadFile(elena, fileId, t.db)).not.toBeNull();
    expect(await getWorkshopPhotoFile(disabled, photoId, t.db)).toBeNull();
    expect((await get("photo", photoId)).status).toBe(404); // a draft is never public
  });
});

// ── Review fixes ─────────────────────────────────────────────────────────────

describe("approving what the reviewer saw", () => {
  it("refuses Approve and Publish when the project changed since the reviewer opened it", async () => {
    const { id } = await projectWithPhoto(ethan);
    await submitWorkshopProject(ctx(ethan), { projectId: id });
    const seen = (await t.db.workshopProject.findUniqueOrThrow({ where: { id } })).updatedAt.toISOString();

    // Ethan adds a file after sending it, while Marcus is looking at the old page.
    const later = { ...ctx(ethan), now: new Date(TEST_NOW.getTime() + 60_000) };
    await addWorkshopFile(later, { projectId: id, file: picked("late.zip", ZIP) });
    const e = await errorOf(reviewWorkshopProject(ctx(marcus), { projectId: id, decision: "approve", version: seen }));
    expect((e as ConflictError).userMessage).toBe(WORKSHOP_CHANGED);
    expect(await statusOf(id)).toBe("PENDING");

    const fresh = (await t.db.workshopProject.findUniqueOrThrow({ where: { id } })).updatedAt.toISOString();
    expect(await reviewWorkshopProject(ctx(marcus), { projectId: id, decision: "approve", version: fresh })).toMatchObject({ status: "APPROVED" });

    // A reviewer's Publish of a draft someone is still changing.
    const draft = await projectWithPhoto(ethan);
    const old = (await t.db.workshopProject.findUniqueOrThrow({ where: { id: draft.id } })).updatedAt.toISOString();
    await updateWorkshopPhoto(later, { photoId: draft.photoId, label: "Version 1", note: "Changed" });
    expect(await errorOf(submitWorkshopProject(ctx(jordan), { projectId: draft.id, version: old }))).toBeInstanceOf(ConflictError);
    expect(await fieldError(reviewWorkshopProject(ctx(marcus), { projectId: id, decision: "approve", version: "yesterday" }), "version")).toMatch(/Refresh/);
  });
});

describe("taking your own name off", () => {
  it("says whether you can still see the project afterwards", async () => {
    const draft = await projectWithPhoto(ethan, { creditIds: [ethan.id, isabella.id] });
    const off = await updateWorkshopProject(ctx(isabella), { ...form(), projectId: draft.id, creditIds: [ethan.id] });
    expect(off.stillVisible).toBe(false);
    expect(await getWorkshopProject(isabella, draft.id, t.db)).toBeNull();

    const stays = await updateWorkshopProject(ctx(ethan), { ...form({ title: "Renamed" }), projectId: draft.id, creditIds: [] });
    expect(stays.stillVisible).toBe(true); // he added it
  });
});

describe("parts and source code", () => {
  it("a part never keeps a source code link, and the website never shows one for a part", async () => {
    const { id } = await createWorkshopProject(ctx(ethan), form({ kind: "SOFTWARE", codeLink: "github.com/huskyteers/inventory" }));
    expect((await t.db.workshopProject.findUniqueOrThrow({ where: { id } })).codeLink).toBe("https://github.com/huskyteers/inventory");
    await updateWorkshopProject(ctx(ethan), { ...form({ kind: "PART", codeLink: "https://github.com/huskyteers/inventory" }), projectId: id });
    expect((await t.db.workshopProject.findUniqueOrThrow({ where: { id } })).codeLink).toBe("");

    const p = await approvedProject({ title: "Part with an old code link" });
    await t.db.workshopProject.update({ where: { id: p.id }, data: { codeLink: "https://github.com/x/y" } });
    const shown = (await getPublicWorkshop(t.db, { now: TEST_NOW })).projects.find((x) => x.id === p.id)!;
    expect(shown.codeLink).toBeNull();
  });
});

describe("names on the website", () => {
  it("keeps different people apart and notes in brackets readable, whatever the name style", async () => {
    expect(publicCredit("Alex Park (2024 alum)", "first-initial")).toBe("Alex P. (2024 alum)");
    expect(publicCredit("Alex Park (2024 alum)", "initials")).toBe("A.P. (2024 alum)");
    expect(publicCredit("Alex Park (2024 alum)", "full")).toBe("Alex Park (2024 alum)");
    expect(publicCredit("Alex Park (2024 alum)", "hidden")).toBeNull();
    expect(publicCredit("Sam", "first-initial")).toBe("Sam");

    const sam1 = await makeUser(t.db, { name: "Sam Lee", role: "MEMBER", subteam: "BUILD" });
    const sam2 = await makeUser(t.db, { name: "Sam Li", role: "MEMBER", subteam: "BUILD" });
    const p = await approvedProject({ title: "Two Sams", creditIds: [sam1.id, sam2.id], extraCredits: "Sam Lee" });
    await t.db.teamNote.upsert({
      where: { key: PUBLIC_PROGRESS_KEY },
      create: { key: PUBLIC_PROGRESS_KEY, body: serializePublicProgressSettings({ ...DEFAULT_PUBLIC_PROGRESS_SETTINGS, nameStyle: "first-initial" }) },
      update: { body: serializePublicProgressSettings({ ...DEFAULT_PUBLIC_PROGRESS_SETTINGS, nameStyle: "first-initial" }) },
    });
    try {
      const shown = (await getPublicWorkshop(t.db, { now: TEST_NOW })).projects.find((x) => x.id === p.id)!;
      expect(shown.designers).toEqual(["Sam L.", "Sam L."]); // two people (the repeated "Sam Lee" once)
    } finally {
      await t.db.teamNote.deleteMany({ where: { key: PUBLIC_PROGRESS_KEY } });
    }
  });
});

// ── Photo metadata ───────────────────────────────────────────────────────────

/** A JPEG segment: marker + length + payload. */
const seg = (marker: number, payload: number[]) => [0xff, marker, ...be16(payload.length + 2), ...payload];
/** An EXIF APP1 payload (little-endian TIFF) with Orientation and a GPS pointer, plus GPS-looking text. */
function exifPayload(orientation: number): number[] {
  return [
    ...ascii("Exif\0\0"),
    ...ascii("II"), 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, // TIFF header, IFD0 at 8
    0x02, 0x00, // two entries
    0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, orientation, 0x00, 0x00, 0x00, // Orientation
    0x25, 0x88, 0x04, 0x00, 0x01, 0x00, 0x00, 0x00, 0x26, 0x00, 0x00, 0x00, // GPS IFD pointer
    0x00, 0x00, 0x00, 0x00,
    ...ascii("GPS 33.8366 N 117.9143 W"),
  ];
}
/** A photo-like JPEG: APP0, EXIF (with orientation and "GPS"), XMP, a comment, a frame of w × h, a scan, EOI, then a second picture. */
function phoneJpeg(width: number, height: number, orientation: number): Uint8Array {
  return Uint8Array.from([
    0xff, 0xd8,
    ...seg(0xe0, [...ascii("JFIF"), 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]),
    ...seg(0xe1, exifPayload(orientation)),
    ...seg(0xe1, [...ascii("http://ns.adobe.com/xap/1.0/\0"), ...ascii("<x:xmpmeta>Anaheim</x:xmpmeta>")]),
    ...seg(0xe2, [...ascii("ICC_PROFILE\0"), 0x01, 0x01, 0x00]),
    ...seg(0xfe, ascii("shot on a phone")),
    ...seg(0xc0, [0x08, ...be16(height), ...be16(width), 0x01, 0x01, 0x11, 0x00]),
    ...seg(0xda, [0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]),
    0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd0, 0x78, // entropy data with a stuffed FF and a restart marker
    0xff, 0xd9,
    // A second picture appended after the end (phones do this), with its own EXIF.
    0xff, 0xd8, ...seg(0xe1, exifPayload(1)), 0xff, 0xd9,
  ]);
}
const has = (bytes: Uint8Array, text: string) => Buffer.from(bytes).includes(Buffer.from(text, "latin1"));

describe("photo metadata", () => {
  it("photos are stored without their metadata, with the size they're shown at", async () => {
    const { id } = await createWorkshopProject(ctx(ethan), form());
    const { photoId } = await addWorkshopPhoto(ctx(ethan), { projectId: id, file: picked("IMG_0042.jpg", phoneJpeg(4032, 3024, 6), "image/jpeg") });
    const row = await t.db.workshopPhoto.findUniqueOrThrow({ where: { id: photoId } });
    expect(has(row.data!, "GPS 33.8366")).toBe(false);
    expect([row.width, row.height]).toEqual([3024, 4032]); // held upright: taller than wide
    expect(imageOrientation(row.data!, "jpg")).toBe(6); // kept, so it still shows the right way up
    for (const secret of ["Anaheim", "shot on a phone", "xap/1.0"]) expect(has(row.data!, secret), secret).toBe(false);
    expect(row.size).toBe(row.data!.byteLength);
  });
});

describe("with Cloudflare R2", () => {
  it("a project's photo and file limits are checked before anything is uploaded", async () => {
    const s3 = await startFakeS3();
    try {
      const r2 = { ...ctx(marcus), objectStore: s3.store() };
      const { id } = await createWorkshopProject(r2, form());
      await t.db.workshopPhoto.createMany({
        data: Array.from({ length: WORKSHOP_LIMITS.photosPerProject }, (_, i) => ({
          projectId: id, position: i, filename: `p${i}.png`, contentType: "image/png", size: PNG.byteLength, data: PNG, width: 1, height: 1,
        })),
      });
      await t.db.workshopFile.createMany({
        data: Array.from({ length: WORKSHOP_LIMITS.filesPerProject }, (_, i) => ({
          projectId: id, filename: `f${i}.stl`, contentType: "application/octet-stream", size: STL.byteLength, data: STL,
        })),
      });
      expect(await fieldError(addWorkshopPhoto(r2, { projectId: id, file: picked("x.png", PNG) }), "file")).toMatch(/up to 12 photos/);
      expect(await fieldError(addWorkshopFile(r2, { projectId: id, file: picked("x.stl", STL) }), "file")).toMatch(/up to 8 files/);
      expect(s3.requests.filter((r) => r.method === "PUT")).toHaveLength(0);
    } finally {
      await s3.close();
    }
  });
});
