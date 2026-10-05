import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LIMITS } from "@/lib/constants";
import { addDays, dateOnlyToDb } from "@/lib/dates";
import { NextRequest } from "next/server";
import {
  canShrinkPosterFile,
  fitWithin,
  jpgName,
  POSTER_FILE_TYPES_MESSAGE,
  POSTER_HEIC_MESSAGE,
  POSTER_UNREADABLE_MESSAGE,
  posterFileProblem,
  posterFileTooBigMessage,
  posterImageTooLargeMessage,
} from "@/lib/posters";
import type { Actor } from "@/server/actor";
import { ForbiddenError, NotFoundError, RateLimitError, ValidationError } from "@/server/errors";
import { sendStoredFile } from "@/server/files/respond";
import { fileStorageUsage, posterCleanupSentence, storageFullSentence, usedFileStorageBytes } from "@/server/files/storage";
import { canEditPoster } from "@/server/permissions";
import { getFileStorageUsage } from "@/server/queries/files";
import {
  getPosterDetail,
  getPosterFile,
  getPosterForEdit,
  listPosters,
  POSTERS_PAGE_SIZE,
  posterFileHref,
} from "@/server/queries/posters";
import { FILE_CSP, fileResponseHeaders, IMMUTABLE_FILE_CACHE, PDF_CSP } from "@/server/resources/serve";
import {
  createPoster,
  deletePoster,
  POSTER_CANT_EDIT,
  POSTER_FILE_BYTES_PER_PERSON,
  POSTER_INACTIVE,
  POSTER_NEEDS_FILE_OR_LINK,
  POSTER_NOT_FOUND,
  POSTER_RATE_LIMIT,
  posterImageSize,
  sniffPosterFile,
  updatePoster,
} from "@/server/services/posters";
import { createResource } from "@/server/services/resources";
import { uploadSponsorshipFile } from "@/server/services/sponsorship-files";
import { createTestDb, type TestDb } from "./helpers/db";
import { contextFor, makeUser, TEST_NOW, TEST_TODAY } from "./helpers/factories";

let t: TestDb;
let gwen: Actor; // Business member (asked for the page)
let ava: Actor; // Business member
let maya: Actor; // Software member
let ethan: Actor; // Build member
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
  gwen = await makeUser(t.db, { name: "Gwen Byers", role: "MEMBER", subteam: "BUSINESS" });
  ava = await makeUser(t.db, { name: "Ava Thompson", role: "MEMBER", subteam: "BUSINESS" });
  maya = await makeUser(t.db, { name: "Maya Patel", role: "MEMBER", subteam: "SOFTWARE" });
  ethan = await makeUser(t.db, { name: "Ethan Chen", role: "MEMBER", subteam: "BUILD" });
  priya = await makeUser(t.db, { name: "Priya Raman", role: "SOFTWARE_LEADER" });
  marcus = await makeUser(t.db, { name: "Marcus Johnson", role: "BUILD_LEADER" });
  amara = await makeUser(t.db, { name: "Amara Okafor", role: "BUSINESS_LEADER" });
  jordan = await makeUser(t.db, { name: "Jordan Lee", role: "CAPTAIN" });
  elena = await makeUser(t.db, { name: "Elena Petrova", role: "MENTOR" });
  david = await makeUser(t.db, { name: "David Kim", role: "TEACHER" });
  olivia = await makeUser(t.db, { name: "Olivia Stone", role: "MEMBER", subteam: "BUILD", isAdmin: true });
  pending = await makeUser(t.db, { name: "Pat Pending", role: "MEMBER", subteam: "BUSINESS", status: "PENDING" });
  disabled = await makeUser(t.db, { name: "Dana Gone", role: "MEMBER", subteam: "BUILD", status: "DISABLED" });
  rejected = await makeUser(t.db, { name: "Rex Rejected", role: "MEMBER", subteam: "SOFTWARE", status: "REJECTED" });
  pendingLeader = await makeUser(t.db, { name: "Quinn Waiting", role: "BUILD_LEADER", status: "PENDING" });
});
afterAll(async () => {
  await t.drop();
});

const ctx = (actor: Actor) => contextFor(t.db, actor);

// ── Files ────────────────────────────────────────────────────────────────────

/** A real 1×1 PNG. */
const PNG = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"));
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** The PNG's signature and IHDR chunk (1×1): enough to pad out into a file of any size (`sized`). */
const PNG_HEAD = PNG.subarray(0, 33);
const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0));
const be16 = (n: number) => [(n >> 8) & 0xff, n & 0xff];
const le16 = (n: number) => [n & 0xff, (n >> 8) & 0xff];
const be32 = (n: number) => [(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
/** A PNG header claiming `width` × `height`. */
const pngOf = (width: number, height: number) =>
  Uint8Array.from([...PNG_SIG, 0, 0, 0, 13, ...ascii("IHDR"), ...be32(width), ...be32(height), 8, 2, 0, 0, 0, 0, 0, 0, 0]);
/** A JPEG: SOI, a JFIF segment, anything in `extra`, then a baseline start-of-frame of `width` × `height`. */
const jpegOf = (width: number, height: number, extra: number[] = []) =>
  Uint8Array.from([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x10, ...ascii("JFIF"), 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    ...extra,
    0xff, 0xc0, 0x00, 0x11, 0x08, ...be16(height), ...be16(width), 0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
    0xff, 0xd9,
  ]);
const JPEG = jpegOf(1, 1);
const GIF = Uint8Array.from([...ascii("GIF89a"), 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x3b]);
/** A lossless WebP header of 1×1. */
const WEBP = Uint8Array.from([...ascii("RIFF"), 0x1a, 0x00, 0x00, 0x00, ...ascii("WEBPVP8L"), 0x0d, 0x00, 0x00, 0x00, 0x2f, 0x00, 0x00, 0x00, 0x00]);
const PDF = new TextEncoder().encode("%PDF-1.4\n% library demo flyer\n");
const HEIC = Uint8Array.from([0x00, 0x00, 0x00, 0x18, ...ascii("ftypheic"), 0x00, 0x00, 0x00, 0x00, ...ascii("mif1heic")]);

/** `size` bytes starting with `prefix` (only the first bytes decide the kind). */
function sized(prefix: ArrayLike<number>, size: number): Uint8Array {
  const out = new Uint8Array(size).fill(0x20);
  out.set(Array.from(prefix).slice(0, size));
  return out;
}

/** A picked file, as the Server Action passes it to the service. */
function file(name = "flyer.png", bytes: Uint8Array | string = PNG, type = "image/png") {
  return { name, type, bytes: typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes };
}

function form(over: Record<string, unknown> = {}) {
  return { title: "Library demo flyer", description: "", link: "", event: "", eventDate: "", ...over };
}

async function create(actor: Actor, over: Record<string, unknown> = {}, picked: unknown = file()) {
  return createPoster(ctx(actor), { ...form(over), file: picked });
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

async function fileErrorOf(p: Promise<unknown>): Promise<string | undefined> {
  return (await validationOf(p)).fieldErrors.file;
}

/** Makes it look like `who` already has `bytes` of poster files (only the size column counts). */
async function alreadyUploaded(who: Actor | null, bytes: number) {
  return t.db.poster.create({
    data: {
      title: "Old poster",
      createdById: who?.id ?? null,
      file: { create: { filename: "old.png", contentType: "image/png", size: bytes, data: new Uint8Array(PNG_SIG) } },
    },
    include: { file: true },
  });
}

// ── Who can do what ────────────────────────────────────────────────────────────

describe("who can add, change, and remove posters", () => {
  it("everyone active can add one (every subteam and role); it's stored with who added it", async () => {
    for (const a of [gwen, maya, ethan, priya, marcus, amara, jordan, elena, david, olivia]) {
      const { id } = await create(a, { title: `Flyer from ${a.name}` }, file(`${a.name}.png`));
      const row = await t.db.poster.findUniqueOrThrow({ where: { id }, include: { file: true } });
      expect(row).toMatchObject({ title: `Flyer from ${a.name}`, createdById: a.id, link: "", event: "", eventDate: null, createdAt: TEST_NOW });
      expect(row.file).toMatchObject({ filename: `${a.name}.png`, contentType: "image/png", size: PNG.byteLength, createdAt: TEST_NOW });
      expect(Buffer.from(row.file!.data!).equals(Buffer.from(PNG))).toBe(true);
    }
  });

  it("accounts that aren't active can't add, change, or remove posters, or see them", async () => {
    const { id } = await create(gwen);
    const fileId = (await t.db.posterFile.findUniqueOrThrow({ where: { posterId: id } })).id;
    for (const a of [pending, disabled, rejected, pendingLeader]) {
      const err = await errorOf(create(a));
      expect(err, a.name).toBeInstanceOf(ForbiddenError);
      expect((err as ForbiddenError).userMessage).toBe(POSTER_INACTIVE);
      await expect(updatePoster(ctx(a), { posterId: id, ...form({ title: "Hijacked" }) }), a.name).rejects.toBeInstanceOf(ForbiddenError);
      await expect(deletePoster(ctx(a), { posterId: id }), a.name).rejects.toBeInstanceOf(ForbiddenError);
      expect(await listPosters(a, { view: "upcoming", mine: false, today: TEST_TODAY }, t.db), a.name).toBeNull();
      expect(await getPosterDetail(a, id, t.db), a.name).toBeNull();
      expect(await getPosterFile(a, fileId, t.db), a.name).toBeNull();
    }
    expect(await t.db.poster.count({ where: { createdById: { in: [pending.id, disabled.id, rejected.id, pendingLeader.id] } } })).toBe(0);
    expect((await t.db.poster.findUniqueOrThrow({ where: { id } })).title).toBe("Library demo flyer");
  });

  it("canEditPoster: whoever added it, plus everyone with admin access", () => {
    const mine = { createdById: gwen.id };
    expect(canEditPoster(gwen, mine)).toBe(true);
    for (const a of [ava, maya, ethan]) expect(canEditPoster(a, mine), a.name).toBe(false);
    for (const a of [priya, marcus, amara, jordan, elena, david, olivia]) expect(canEditPoster(a, mine), a.name).toBe(true);
    // Its author's account is gone: only admin access.
    expect(canEditPoster(gwen, { createdById: null })).toBe(false);
    expect(canEditPoster(priya, { createdById: null })).toBe(true);
  });

  it("other members can't change or remove someone else's poster; nothing changes", async () => {
    const { id } = await create(gwen, { title: "Gwen's flyer" });
    for (const a of [ava, maya, ethan]) {
      const err = await errorOf(updatePoster(ctx(a), { posterId: id, ...form({ title: "Mine now", link: "https://example.com" }) }));
      expect(err, a.name).toBeInstanceOf(ForbiddenError);
      expect((err as ForbiddenError).userMessage).toBe(POSTER_CANT_EDIT);
      await expect(deletePoster(ctx(a), { posterId: id }), a.name).rejects.toBeInstanceOf(ForbiddenError);
      expect(await getPosterForEdit(a, id, t.db), a.name).toBeNull();
    }
    const row = await t.db.poster.findUniqueOrThrow({ where: { id }, include: { file: true } });
    expect(row.title).toBe("Gwen's flyer");
    expect(row.file).not.toBeNull();
  });

  it("the author and every leader, the captain, mentors, teachers, and owners can change and remove any poster", async () => {
    for (const a of [gwen, priya, marcus, amara, jordan, elena, david, olivia]) {
      const { id } = await create(gwen, { title: "Before" });
      await updatePoster(ctx(a), { posterId: id, ...form({ title: `Fixed by ${a.name}` }) });
      expect((await t.db.poster.findUniqueOrThrow({ where: { id } })).title).toBe(`Fixed by ${a.name}`);
      expect((await getPosterForEdit(a, id, t.db))?.id, a.name).toBe(id);
      expect(await deletePoster(ctx(a), { posterId: id })).toEqual({ title: `Fixed by ${a.name}` });
      expect(await t.db.poster.count({ where: { id } }), a.name).toBe(0);
    }
  });

  it("a missing poster is NotFound; bad input is a ValidationError", async () => {
    for (const p of [
      updatePoster(ctx(jordan), { posterId: "missing", ...form() }),
      deletePoster(ctx(jordan), { posterId: "missing" }),
      deletePoster(ctx(gwen), { posterId: "missing" }),
    ]) {
      const err = await errorOf(p);
      expect(err).toBeInstanceOf(NotFoundError);
      expect((err as NotFoundError).userMessage).toBe(POSTER_NOT_FOUND);
    }
    await expect(deletePoster(ctx(jordan), {})).rejects.toBeInstanceOf(ValidationError);
    await expect(updatePoster(ctx(jordan), form())).rejects.toBeInstanceOf(ValidationError);
    await expect(deletePoster(ctx(jordan), null)).rejects.toBeInstanceOf(ValidationError);
  });
});

// ── Validation ────────────────────────────────────────────────────────────────

describe("checking the form", () => {
  let who: Actor;
  beforeAll(async () => {
    who = await makeUser(t.db, { name: "Form Checker", role: "MEMBER", subteam: "BUSINESS" });
  });

  it("needs a title (up to the limit), and keeps the optional fields", async () => {
    const e = await validationOf(create(who, { title: "   " }));
    expect(e.fieldErrors.title).toBe("Title is required.");
    expect((await validationOf(create(who, { title: "x".repeat(LIMITS.posterTitleMax + 1) }))).fieldErrors.title).toMatch(/at most/);
    expect((await validationOf(create(who, { event: "x".repeat(LIMITS.posterEventMax + 1) }))).fieldErrors.event).toMatch(/at most/);
    expect((await validationOf(create(who, { description: "x".repeat(LIMITS.posterDescriptionMax + 1) }))).fieldErrors.description).toMatch(/at most/);

    const { id } = await create(who, {
      title: "  Recruiting flyer  ",
      description: "Put one up by the cafeteria.\nPrint in color.",
      event: " Recruiting ",
      eventDate: "2026-10-04",
    });
    expect(await t.db.poster.findUniqueOrThrow({ where: { id } })).toMatchObject({
      title: "Recruiting flyer",
      description: "Put one up by the cafeteria.\nPrint in color.",
      event: "Recruiting",
      eventDate: dateOnlyToDb("2026-10-04"),
    });
  });

  it("needs a picture or PDF, or a link (or both)", async () => {
    const e = await validationOf(create(who, {}, null));
    expect(e.userMessage).toBe(POSTER_NEEDS_FILE_OR_LINK);
    expect(e.fieldErrors).toEqual({ file: POSTER_NEEDS_FILE_OR_LINK });
    // Only a name (what formDataToObject keeps) isn't a file.
    expect(await fileErrorOf(create(who, {}, "flyer.png"))).toBe(POSTER_NEEDS_FILE_OR_LINK);

    const linkOnly = await create(who, { link: "https://www.canva.com/design/DAF123/view" }, null);
    expect(await t.db.poster.findUniqueOrThrow({ where: { id: linkOnly.id }, include: { file: true } })).toMatchObject({
      link: "https://www.canva.com/design/DAF123/view",
      file: null,
    });
    const both = await create(who, { link: "https://drive.google.com/file/d/abc" });
    expect(await t.db.posterFile.count({ where: { posterId: both.id } })).toBe(1);
  });

  it("links must be http(s); a bare address gets https://", async () => {
    const { id } = await create(who, { link: "canva.com/design/DAF456" }, null);
    expect((await t.db.poster.findUniqueOrThrow({ where: { id } })).link).toBe("https://canva.com/design/DAF456");
    for (const link of ["javascript:alert(1)", "ftp://files.example.com/flyer.pdf", "not a link", "data:text/html,hi", "https://user:pw@example.com/"]) {
      const e = await validationOf(create(who, { link }, null));
      expect(e.fieldErrors.link, link).toMatch(/^Enter a web link/);
      // The link's own problem is enough: no "add a file or a link" on top.
      expect(e.fieldErrors.file, link).toBeUndefined();
    }
  });

  it("event dates must be real dates, not too far back or ahead", async () => {
    expect((await validationOf(create(who, { eventDate: "2026-02-30" }))).fieldErrors.eventDate).toBe("Pick a valid date.");
    expect((await validationOf(create(who, { eventDate: "next friday" }))).fieldErrors.eventDate).toBe("Pick a valid date.");
    expect((await validationOf(create(who, { eventDate: addDays(TEST_TODAY, 2 * 365 + 1) }))).fieldErrors.eventDate).toMatch(/more than 2 years away/);
    expect((await validationOf(create(who, { eventDate: addDays(TEST_TODAY, -5 * 365 - 1) }))).fieldErrors.eventDate).toMatch(/more than 5 years ago/);
    await create(who, { eventDate: addDays(TEST_TODAY, 2 * 365) });
    await create(who, { eventDate: addDays(TEST_TODAY, -5 * 365) });
  });

  it("reports every problem at once", async () => {
    const e = await validationOf(create(who, { title: "", link: "nope" }, file("notes.txt", "hello", "text/plain")));
    expect(e.userMessage).toBe("Please fix the highlighted fields.");
    expect(Object.keys(e.fieldErrors).sort()).toEqual(["file", "link", "title"]);
    expect(e.fieldErrors.file).toBe(POSTER_FILE_TYPES_MESSAGE);
  });
});

describe("poster files", () => {
  let who: Actor;
  beforeAll(async () => {
    who = await makeUser(t.db, { name: "File Checker", role: "MEMBER", subteam: "BUSINESS" });
  });

  async function stored(picked: ReturnType<typeof file>) {
    const { id } = await create(who, {}, picked);
    return t.db.posterFile.findUniqueOrThrow({ where: { posterId: id }, select: { filename: true, contentType: true, size: true } });
  }

  it("takes PNG, JPG, GIF, WebP, and PDF, stored with their real type", async () => {
    expect(await stored(file("flyer.png", PNG))).toMatchObject({ filename: "flyer.png", contentType: "image/png" });
    expect(await stored(file("photo.JPEG", JPEG, "image/jpeg"))).toMatchObject({ filename: "photo.JPEG", contentType: "image/jpeg" });
    expect(await stored(file("anim.gif", GIF, "image/gif"))).toMatchObject({ filename: "anim.gif", contentType: "image/gif" });
    expect(await stored(file("banner.webp", WEBP, "image/webp"))).toMatchObject({ filename: "banner.webp", contentType: "image/webp" });
    expect(await stored(file("Library demo.pdf", PDF, "application/pdf"))).toMatchObject({ filename: "Library demo.pdf", contentType: "application/pdf" });
  });

  it("goes by what the file really is, fixing the name to match", async () => {
    // Phones sometimes send names without an extension, or an iPhone photo already turned into a JPEG.
    expect(await stored(file("image", JPEG, ""))).toMatchObject({ filename: "image.jpg", contentType: "image/jpeg" });
    expect(await stored(file("IMG_0412.HEIC", JPEG, "image/heic"))).toMatchObject({ filename: "IMG_0412.jpg", contentType: "image/jpeg" });
    expect(await stored(file("flyer.png", PDF, "image/png"))).toMatchObject({ filename: "flyer.pdf", contentType: "application/pdf" });
    expect(await stored(file("Fall demo v2.5", PDF, "application/pdf"))).toMatchObject({ filename: "Fall demo v2.5.pdf" });
    // The browser's type never wins over the contents.
    expect(await stored(file("x.png", PNG, "text/html"))).toMatchObject({ contentType: "image/png" });
    // PDFs may start with a little junk before the header.
    expect(await stored(file("scan.pdf", new Uint8Array([0x0a, 0x0a, ...PDF]), "application/pdf"))).toMatchObject({ contentType: "application/pdf" });
  });

  it("refuses everything else: SVG, HTML dressed up as a picture, documents, programs", async () => {
    const before = await t.db.poster.count({ where: { createdById: who.id } });
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
    for (const picked of [
      file("logo.svg", svg, "image/svg+xml"),
      file("sneaky.png", "<html><script>alert(1)</script></html>", "image/png"),
      file("flyer.docx", "PK\x03\x04word", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
      file("notes.txt", "Library demo on Saturday", "text/plain"),
      file("setup.exe", "MZ\x90\x00", "application/octet-stream"),
      file("poster.bmp", "BM\x00\x00", "image/bmp"),
    ]) {
      expect(await fileErrorOf(create(who, {}, picked)), picked.name).toBe(POSTER_FILE_TYPES_MESSAGE);
    }
    expect(await fileErrorOf(create(who, {}, file("IMG_0413.HEIC", HEIC, "image/heic")))).toBe(POSTER_HEIC_MESSAGE);
    expect(await t.db.poster.count({ where: { createdById: who.id } })).toBe(before);
  });

  it("files can be up to 4 MB and can't be empty", async () => {
    const tooBig = LIMITS.resourceFileMaxBytes + 1;
    expect(await fileErrorOf(create(who, {}, file("huge.png", sized(PNG_HEAD, tooBig))))).toBe(posterFileTooBigMessage(tooBig));
    expect(posterFileTooBigMessage(tooBig)).toMatch(/^That file is 4\.0 MB\. Posters can be up to 4 MB/);
    await create(who, {}, file("exactly.png", sized(PNG_HEAD, LIMITS.resourceFileMaxBytes)));
    expect(await fileErrorOf(create(who, {}, file("empty.png", new Uint8Array(0))))).toMatch(/empty/);
  });

  it("the browser checks the same things before uploading (by name or type)", () => {
    expect(posterFileProblem({ name: "flyer.png", type: "image/png", size: 10 })).toBeNull();
    expect(posterFileProblem({ name: "image", type: "image/jpeg", size: 10 })).toBeNull();
    expect(posterFileProblem({ name: "Flyer.PDF", type: "", size: 10 })).toBeNull();
    expect(posterFileProblem({ name: "logo.svg", type: "image/svg+xml", size: 10 })).toBe(POSTER_FILE_TYPES_MESSAGE);
    expect(posterFileProblem({ name: "IMG_1.HEIC", type: "image/heic", size: 10 })).toBe(POSTER_HEIC_MESSAGE);
    expect(posterFileProblem({ name: "big.jpg", type: "image/jpeg", size: LIMITS.resourceFileMaxBytes + 1 })).toBe(
      posterFileTooBigMessage(LIMITS.resourceFileMaxBytes + 1),
    );
    expect(posterFileProblem({ name: "empty.png", type: "image/png", size: 0 })).toMatch(/empty/);
  });

  it("sniffPosterFile reads the first bytes", () => {
    expect(sniffPosterFile(PNG)).toBe("png");
    expect(sniffPosterFile(JPEG)).toBe("jpg");
    expect(sniffPosterFile(GIF)).toBe("gif");
    expect(sniffPosterFile(WEBP)).toBe("webp");
    expect(sniffPosterFile(PDF)).toBe("pdf");
    expect(sniffPosterFile(HEIC)).toBeNull();
    expect(sniffPosterFile(new Uint8Array(PNG_SIG.slice(0, 4)))).toBeNull();
    expect(sniffPosterFile(new TextEncoder().encode("RIFF1234WAVE"))).toBeNull();
    expect(sniffPosterFile(new Uint8Array(0))).toBeNull();
  });

  it("a PDF must start with %PDF- (only blank bytes before it): HTML with it tucked in a comment is refused", async () => {
    const html = "<!doctype html><html><body><script>alert(document.domain)</script><!-- %PDF-1.4 --></body></html>";
    expect(sniffPosterFile(new TextEncoder().encode(html))).toBeNull();
    expect(await fileErrorOf(create(who, {}, file("evil.html", html, "text/html")))).toBe(POSTER_FILE_TYPES_MESSAGE);
    expect(await fileErrorOf(create(who, {}, file("evil.pdf", html, "application/pdf")))).toBe(POSTER_FILE_TYPES_MESSAGE);
    expect(sniffPosterFile(new TextEncoder().encode(`junk%PDF-1.4`))).toBeNull();
    expect(sniffPosterFile(new TextEncoder().encode(`\r\n \t\0%PDF-1.7`))).toBe("pdf");
    expect(sniffPosterFile(new TextEncoder().encode(`%PDX-1.4`))).toBeNull();
    // Blank bytes only count near the start (the first 1 KB).
    expect(sniffPosterFile(new TextEncoder().encode(`${" ".repeat(1024)}%PDF-1.4`))).toBeNull();
  });

  it("reads a picture's size from its header", () => {
    expect(posterImageSize(PNG, "png")).toEqual({ width: 1, height: 1 });
    expect(posterImageSize(pngOf(2480, 3508), "png")).toEqual({ width: 2480, height: 3508 });
    expect(posterImageSize(pngOf(0xffffffff, 1), "png")).toEqual({ width: 0xffffffff, height: 1 });
    expect(posterImageSize(Uint8Array.from(PNG_SIG), "png")).toBeNull();
    expect(posterImageSize(jpegOf(3024, 4032), "jpg")).toEqual({ width: 3024, height: 4032 });
    // Skips EXIF (with its own little JPEG inside), fill bytes, and stray bytes the way browsers do.
    const exif = [0xff, 0xe1, 0x00, 0x0c, ...ascii("Exif"), 0x00, 0x00, 0xff, 0xc0, 0x00, 0x00];
    expect(posterImageSize(jpegOf(640, 480, [...exif, 0x12, 0x34, 0xff, 0xff]), "jpg")).toEqual({ width: 640, height: 480 });
    // A progressive JPEG (SOF2).
    const progressive = jpegOf(800, 600);
    progressive[21] = 0xc2;
    expect(posterImageSize(progressive, "jpg")).toEqual({ width: 800, height: 600 });
    // Image data (SOS) or the end (EOI) before any size: unreadable.
    expect(posterImageSize(Uint8Array.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02, 0xff, 0xc0, 0x00, 0x11, 0x08, 0, 1, 0, 1]), "jpg")).toBeNull();
    expect(posterImageSize(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]), "jpg")).toBeNull();
    expect(posterImageSize(GIF, "gif")).toEqual({ width: 1, height: 1 });
    expect(posterImageSize(WEBP, "webp")).toEqual({ width: 1, height: 1 });
    const riff = (chunk: string, body: number[]) =>
      Uint8Array.from([...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WEBP"), ...ascii(chunk), 0, 0, 0, 0, ...body]);
    expect(posterImageSize(riff("VP8 ", [0, 0, 0, 0x9d, 0x01, 0x2a, ...le16(1200), ...le16(1600)]), "webp")).toEqual({ width: 1200, height: 1600 });
    expect(posterImageSize(riff("VP8X", [0, 0, 0, 0, 0xff, 0xff, 0xff, 0x0f, 0x00, 0x00]), "webp")).toEqual({ width: 0x1000000, height: 16 });
    expect(posterImageSize(riff("ALPH", [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), "webp")).toBeNull();
    expect(posterImageSize(PDF, "pdf")).toBeNull();
  });

  it("pictures too big for a phone to draw are refused, whatever the file size", async () => {
    const before = await t.db.poster.count({ where: { createdById: who.id } });
    // A tiny file claiming 65,535 × 65,535 pixels (a "decompression bomb").
    expect(await fileErrorOf(create(who, {}, file("bomb.png", pngOf(65535, 65535))))).toBe(posterImageTooLargeMessage(65535, 65535));
    expect(posterImageTooLargeMessage(65535, 65535)).toMatch(/^That picture is 65,535 × 65,535 pixels — too big to show on phones\./);
    expect(await fileErrorOf(create(who, {}, file("wide.jpg", jpegOf(12_001, 10), "image/jpeg")))).toBe(posterImageTooLargeMessage(12_001, 10));
    expect(await fileErrorOf(create(who, {}, file("huge.jpg", jpegOf(8000, 7000), "image/jpeg")))).toMatch(/too big to show on phones/); // 56 million
    // A GIF whose first frame is far bigger than its "screen": browsers grow the picture to fit the frame.
    const sneakyGif = Uint8Array.from([
      ...ascii("GIF89a"), ...le16(1), ...le16(1), 0x00, 0x00, 0x00,
      0x21, 0xf9, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, // graphic control extension
      0x2c, ...le16(0), ...le16(0), ...le16(30_000), ...le16(30_000), 0x00, 0x02, 0x02, 0x44, 0x01, 0x00,
      0x3b,
    ]);
    expect(await fileErrorOf(create(who, {}, file("sneaky.gif", sneakyGif, "image/gif")))).toBe(posterImageTooLargeMessage(30_000, 30_000));
    expect(await t.db.poster.count({ where: { createdById: who.id } })).toBe(before);
    // Right at the limits is fine: 12,000 on a side, 50 million in all.
    await create(who, {}, file("tall.png", pngOf(4000, 12_000)));
    await create(who, {}, file("big.jpg", jpegOf(10_000, 5000), "image/jpeg"));
  });

  it("a picture whose size can't be read (damaged, or only a header) is refused", async () => {
    expect(await fileErrorOf(create(who, {}, file("cut-off.png", Uint8Array.from(PNG_SIG))))).toBe(POSTER_UNREADABLE_MESSAGE);
    expect(await fileErrorOf(create(who, {}, file("zero.png", pngOf(0, 100))))).toBe(POSTER_UNREADABLE_MESSAGE);
    const noSize = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, ...ascii("JFIF"), 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9]);
    expect(await fileErrorOf(create(who, {}, file("no-size.jpg", noSize, "image/jpeg")))).toBe(POSTER_UNREADABLE_MESSAGE);
    // PDFs have no pixel size to check.
    await create(who, {}, file("flyer.pdf", PDF, "application/pdf"));
  });

  it("the form can shrink big photos (PNG, JPG, WebP; not GIFs or PDFs) into a JPG", () => {
    expect(canShrinkPosterFile({ name: "IMG_1.JPG", type: "image/jpeg" })).toBe(true);
    expect(canShrinkPosterFile({ name: "export.png", type: "image/png" })).toBe(true);
    expect(canShrinkPosterFile({ name: "shot.webp", type: "" })).toBe(true);
    expect(canShrinkPosterFile({ name: "anim.gif", type: "image/gif" })).toBe(false);
    expect(canShrinkPosterFile({ name: "flyer.pdf", type: "application/pdf" })).toBe(false);
    expect(canShrinkPosterFile({ name: "IMG_2.HEIC", type: "image/heic" })).toBe(false);
    expect(fitWithin(8160, 6120, 3000)).toEqual({ width: 3000, height: 2250 });
    expect(fitWithin(1200, 1600, 3000)).toEqual({ width: 1200, height: 1600 }); // never bigger
    expect(fitWithin(40_000, 10, 3000)).toEqual({ width: 3000, height: 1 });
    expect(jpgName("IMG_1234.PNG")).toBe("IMG_1234.jpg");
    expect(jpgName("Fall demo v2.5.png")).toBe("Fall demo v2.5.jpg");
    expect(jpgName("image")).toBe("image.jpg");
    expect(jpgName(".png")).toBe(".png.jpg");
  });

  it(`each person can add ${POSTER_RATE_LIMIT.limit} posters an hour`, async () => {
    const busy = await makeUser(t.db, { role: "MEMBER", subteam: "BUSINESS" });
    for (let i = 0; i < POSTER_RATE_LIMIT.limit; i++) await create(busy, { title: `Flyer ${i}`, link: "https://example.com" }, null);
    await expect(create(busy, { link: "https://example.com" }, null)).rejects.toBeInstanceOf(RateLimitError);
    // Editing without a new file isn't limited.
    const [one] = await t.db.poster.findMany({ where: { createdById: busy.id }, take: 1 });
    await updatePoster(ctx(busy), { posterId: one.id, ...form({ title: "Renamed", link: "https://example.com" }) });
    // An hour later it's fine again.
    const later = { ...ctx(busy), now: new Date(TEST_NOW.getTime() + 61 * 60 * 1000) };
    await createPoster(later, { ...form({ link: "https://example.com" }) });
  });
});

// ── Editing ────────────────────────────────────────────────────────────────────

describe("editing a poster", () => {
  let who: Actor;
  beforeAll(async () => {
    who = await makeUser(t.db, { name: "Edit Person", role: "MEMBER", subteam: "BUSINESS" });
  });

  it("changes the fields; saving without a new file keeps the file", async () => {
    const { id } = await create(who, { title: "Draft", event: "Library demo", eventDate: "2026-10-04" });
    const before = await t.db.posterFile.findUniqueOrThrow({ where: { posterId: id } });
    const later = { ...ctx(who), now: new Date(TEST_NOW.getTime() + 60_000) };
    await updatePoster(later, { posterId: id, ...form({ title: "Final", description: "Two copies.", event: "", eventDate: "" }) });
    const row = await t.db.poster.findUniqueOrThrow({ where: { id }, include: { file: true } });
    expect(row).toMatchObject({ title: "Final", description: "Two copies.", event: "", eventDate: null, createdById: who.id });
    expect(row.file).toMatchObject({ id: before.id, filename: before.filename, size: before.size });
  });

  it("a new file replaces the old one (with a new address)", async () => {
    const { id } = await create(who, {}, file("v1.png"));
    const old = await t.db.posterFile.findUniqueOrThrow({ where: { posterId: id } });
    await updatePoster(ctx(who), { posterId: id, ...form(), file: file("v2.pdf", PDF, "application/pdf") });
    const now = await t.db.posterFile.findUniqueOrThrow({ where: { posterId: id } });
    expect(now).toMatchObject({ filename: "v2.pdf", contentType: "application/pdf", size: PDF.byteLength });
    expect(now.id).not.toBe(old.id);
    expect(await t.db.posterFile.count({ where: { id: old.id } })).toBe(0);
    expect(await getPosterFile(who, old.id, t.db)).toBeNull();
  });

  it("the file can be removed when there's a link; not when it would leave nothing", async () => {
    const { id } = await create(who, {}, file("keep.png"));
    const e = await validationOf(updatePoster(ctx(who), { posterId: id, ...form(), removeFile: "on" }));
    expect(e.fieldErrors.file).toBe(POSTER_NEEDS_FILE_OR_LINK);
    expect(await t.db.posterFile.count({ where: { posterId: id } })).toBe(1);

    await updatePoster(ctx(who), { posterId: id, ...form({ link: "https://www.canva.com/design/x" }), removeFile: "on" });
    expect(await t.db.posterFile.count({ where: { posterId: id } })).toBe(0);
    expect((await getPosterDetail(who, id, t.db))?.file).toBeNull();

    // A link-only poster gets a file later, and then can drop its link.
    await updatePoster(ctx(who), { posterId: id, ...form({ link: "https://www.canva.com/design/x" }), file: file("added.png") });
    await updatePoster(ctx(who), { posterId: id, ...form({ link: "" }) });
    expect(await t.db.poster.findUniqueOrThrow({ where: { id }, include: { file: true } })).toMatchObject({
      link: "",
      file: { filename: "added.png" },
    });
    // Removing the file and picking a new one at once: the new one wins.
    await updatePoster(ctx(who), { posterId: id, ...form(), removeFile: "on", file: file("newest.png") });
    expect((await t.db.posterFile.findUniqueOrThrow({ where: { posterId: id } })).filename).toBe("newest.png");
  });

  it("an old poster can still be fixed: a date kept as it is isn't checked again", async () => {
    const longAgo = addDays(TEST_TODAY, -5 * 365 - 3);
    const old = await t.db.poster.create({
      data: { title: "Old flyr", link: "https://example.com/old", eventDate: dateOnlyToDb(longAgo), createdById: who.id },
    });
    await updatePoster(ctx(who), { posterId: old.id, ...form({ title: "Old flyer", link: "https://example.com/old", eventDate: longAgo }) });
    expect(await t.db.poster.findUniqueOrThrow({ where: { id: old.id } })).toMatchObject({ title: "Old flyer", eventDate: dateOnlyToDb(longAgo) });
    // A new date is checked as usual.
    const e = await validationOf(
      updatePoster(ctx(who), { posterId: old.id, ...form({ link: "https://example.com/old", eventDate: addDays(longAgo, -1) }) }),
    );
    expect(e.fieldErrors.eventDate).toMatch(/more than 5 years ago/);
    expect(
      (await validationOf(updatePoster(ctx(who), { posterId: old.id, ...form({ link: "https://example.com/old", eventDate: addDays(TEST_TODAY, 3 * 365) }) })))
        .fieldErrors.eventDate,
    ).toMatch(/more than 2 years away/);
  });

  it("a link-only poster can't lose its link", async () => {
    const { id } = await create(who, { link: "https://example.com/design" }, null);
    expect(await fileErrorOf(updatePoster(ctx(who), { posterId: id, ...form({ link: "" }) }))).toBe(POSTER_NEEDS_FILE_OR_LINK);
    expect((await t.db.poster.findUniqueOrThrow({ where: { id } })).link).toBe("https://example.com/design");
  });

  it("a bad new file is refused and the old one stays", async () => {
    const { id } = await create(who, {}, file("good.png"));
    expect(await fileErrorOf(updatePoster(ctx(who), { posterId: id, ...form(), file: file("bad.svg", "<svg/>", "image/svg+xml") }))).toBe(
      POSTER_FILE_TYPES_MESSAGE,
    );
    expect((await t.db.posterFile.findUniqueOrThrow({ where: { posterId: id } })).filename).toBe("good.png");
  });
});

// ── Storage ────────────────────────────────────────────────────────────────────

describe("how much one person can upload", () => {
  it(`a member's poster files stay under ${POSTER_FILE_BYTES_PER_PERSON / 1024 / 1024} MB; replacing or removing frees it up`, async () => {
    const member = await makeUser(t.db, { name: "Busy Poster", role: "MEMBER", subteam: "BUSINESS" });
    const old = await alreadyUploaded(member, POSTER_FILE_BYTES_PER_PERSON - 300);
    expect(await fileErrorOf(create(member, {}, file("new.png", sized(PNG_HEAD, 301))))).toBe(
      "Your posters use 50 MB, and each person can have up to 50 MB. Remove old posters you don't need, add a link instead, or ask a leader to add this one.",
    );
    const { id } = await create(member, {}, file("new.png", sized(PNG_HEAD, 300))); // exactly at the limit is fine
    // Link-only posters don't count.
    await create(member, { link: "https://example.com" }, null);
    // Other people's posters don't count toward hers.
    await create(ava, {}, file("ava.png"));
    expect(await fileErrorOf(create(member, {}, file("one more.png", sized(PNG_HEAD, 90))))).toMatch(/^Your posters use 50 MB/);
    // Replacing a file only counts the difference.
    await updatePoster(ctx(member), { posterId: id, ...form(), file: file("smaller.png", sized(PNG_HEAD, 200)) });
    expect(await fileErrorOf(updatePoster(ctx(member), { posterId: id, ...form(), file: file("bigger.png", sized(PNG_HEAD, 301)) }))).toMatch(
      /^Your posters use 50 MB/,
    );
    await deletePoster(ctx(member), { posterId: old.id });
    await create(member, {}, file("one more.png", sized(PNG_HEAD, 90)));
  });

  it("leaders, the captain, mentors, teachers, and owners aren't limited", async () => {
    for (const a of [priya, amara, jordan, elena, david, olivia]) {
      const old = await alreadyUploaded(a, POSTER_FILE_BYTES_PER_PERSON);
      await create(a, {}, file(`from ${a.name}.png`));
      await t.db.poster.delete({ where: { id: old.id } });
    }
  });
});

describe("the team's file storage", () => {
  it("poster files count toward the same cap as Resources and sponsor files", async () => {
    const member = await makeUser(t.db, { name: "Storage Poster", role: "MEMBER", subteam: "BUILD" });
    // A big Resources file that leaves exactly 300 bytes free.
    const holder = await t.db.resource.create({
      data: { title: "Big old CAD export", file: { create: { filename: "big.step", contentType: "application/octet-stream", size: 0, data: new Uint8Array([1]) } } },
    });
    const used = await t.db.$transaction((tx) => usedFileStorageBytes(tx));
    await t.db.resourceFile.update({ where: { resourceId: holder.id }, data: { size: LIMITS.resourceStorageMaxBytes - used - 300 } });

    const almostFull = await t.db.$transaction((tx) => fileStorageUsage(tx));
    expect(almostFull.posters).toBeGreaterThan(0);
    expect(almostFull.used).toBe(almostFull.resources + almostFull.sponsors + almostFull.posters);
    expect(await fileErrorOf(create(member, {}, file("full.png", sized(PNG_HEAD, 301))))).toBe(
      `${storageFullSentence(almostFull)} Add a link to the design instead, or remove old posters you don't need. Leaders, the captain, mentors, and teachers can clear out old posters and Resources files.`,
    );
    // The first sentence says how much is posters.
    expect(storageFullSentence(almostFull)).toMatch(
      /^The team's file storage is full: \d+ MB of Resources files, [\d.]+ (KB|MB|bytes) of sponsor files, and [\d.]+ (KB|MB|bytes) of posters\.$/,
    );
    const { id } = await create(member, {}, file("fits.png", sized(PNG_HEAD, 300))); // exactly full is fine
    // Admin access doesn't get around the team's cap.
    await expect(create(jordan, {}, file("x.png", sized(PNG_HEAD, 90)))).rejects.toBeInstanceOf(ValidationError);
    // Replacing a file with one the same size still fits (the old one is freed).
    await updatePoster(ctx(member), { posterId: id, ...form(), file: file("same size.png", sized(PNG_HEAD, 300)) });

    // Now a Resources upload doesn't fit either: the poster counts, and the message says who can remove posters.
    const resourceForm = { title: "Tiny", kind: "file", type: "OTHER", group: "", description: "", pinned: "", links: "", file: file("tiny.txt", "y", "text/plain") };
    const full = await errorOf(createResource(ctx(elena), resourceForm));
    expect(full).toBeInstanceOf(ValidationError);
    expect((full as ValidationError).fieldErrors.file).toMatch(
      /of posters\. Share a link instead, .* can clear out sponsor files\. Old posters can be removed by whoever added them, or by leaders, the captain, mentors, and teachers\.$/,
    );
    // So does a sponsor file's.
    const sponsor = await t.db.sponsorship.create({ data: { name: "Poster Storage Sponsor", createdById: amara.id } });
    const sponsorFull = await validationOf(
      uploadSponsorshipFile(ctx(amara), { sponsorshipId: sponsor.id, file: file("form.pdf", PDF, "application/pdf") }),
    );
    expect(sponsorFull.fieldErrors.file).toMatch(/of posters\. Remove sponsor files .* Old posters can be removed by whoever added them/);
    await t.db.sponsorship.delete({ where: { id: sponsor.id } });

    // Removing the poster frees its space.
    await deletePoster(ctx(member), { posterId: id });
    await createResource(ctx(elena), resourceForm);
    await t.db.resource.deleteMany({ where: { OR: [{ id: holder.id }, { title: "Tiny" }] } });
  });

  it("the Admin page's usage includes posters", async () => {
    const before = await getFileStorageUsage(priya, t.db);
    expect(before).not.toBeNull();
    await create(priya, {}, file("usage.png", sized(PNG_HEAD, 1000)));
    const after = await getFileStorageUsage(priya, t.db);
    expect(after).toEqual({ ...before, posters: before!.posters + 1000, used: before!.used + 1000 });
    expect(await getFileStorageUsage(maya, t.db)).toBeNull(); // members outside Business don't see it
  });

  it("the full sentence (and who can remove posters) leaves posters out when there are none", () => {
    expect(posterCleanupSentence({ resources: 1, sponsors: 1, posters: 0, notebook: 0, strategy: 0, logos: 0, workshop: 0, used: 2, max: 1 })).toBe("");
    expect(posterCleanupSentence({ resources: 0, sponsors: 0, posters: 1, notebook: 0, strategy: 0, logos: 0, workshop: 0, used: 1, max: 1 })).toBe(
      " Old posters can be removed by whoever added them, or by leaders, the captain, mentors, and teachers.",
    );
    expect(storageFullSentence({ resources: 1024 * 1024, sponsors: 2048, posters: 0, notebook: 0, strategy: 0, logos: 0, workshop: 0, used: 1024 * 1024 + 2048, max: 1 })).toBe(
      "The team's file storage is full: 1.0 MB of Resources files and 2.0 KB of sponsor files.",
    );
    expect(storageFullSentence({ resources: 0, sponsors: 0, posters: 5 * 1024 * 1024, notebook: 0, strategy: 0, logos: 0, workshop: 0, used: 5 * 1024 * 1024, max: 1 })).toBe(
      "The team's file storage is full: 0 bytes of Resources files, 0 bytes of sponsor files, and 5.0 MB of posters.",
    );
    // Notebook pictures, strategy files, and sponsor logos are named too, only when there are some.
    expect(
      storageFullSentence({ resources: 0, sponsors: 0, posters: 0, notebook: 2048, strategy: 1024, logos: 0, workshop: 0, used: 3072, max: 1 }),
    ).toBe(
      "The team's file storage is full: 0 bytes of Resources files, 0 bytes of sponsor files, 2.0 KB of notebook pictures, and 1.0 KB of strategy files.",
    );
    expect(
      storageFullSentence({ resources: 0, sponsors: 0, posters: 0, notebook: 0, strategy: 0, logos: 4096, workshop: 0, used: 4096, max: 1 }),
    ).toBe("The team's file storage is full: 0 bytes of Resources files, 0 bytes of sponsor files, and 4.0 KB of sponsor logos.");
  });
});

// ── Removing ────────────────────────────────────────────────────────────────

describe("removing a poster", () => {
  it("removes its file too", async () => {
    const { id } = await create(gwen, { title: "Gone soon" });
    const fileId = (await t.db.posterFile.findUniqueOrThrow({ where: { posterId: id } })).id;
    expect(await deletePoster(ctx(gwen), { posterId: id })).toEqual({ title: "Gone soon" });
    expect(await t.db.posterFile.count({ where: { id: fileId } })).toBe(0);
    expect(await getPosterFile(gwen, fileId, t.db)).toBeNull();
    await expect(deletePoster(ctx(gwen), { posterId: id })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("a poster stays when its author's account is deleted; then only admin access can change it", async () => {
    const leaving = await makeUser(t.db, { name: "Leaving Soon", role: "MEMBER", subteam: "BUSINESS" });
    const { id } = await create(leaving);
    await t.db.user.delete({ where: { id: leaving.id } });
    const detail = await getPosterDetail(gwen, id, t.db);
    expect(detail).toMatchObject({ createdByName: null, canEdit: false });
    expect((await getPosterDetail(marcus, id, t.db))?.canEdit).toBe(true);
    await expect(deletePoster(ctx(gwen), { posterId: id })).rejects.toBeInstanceOf(ForbiddenError);
    await deletePoster(ctx(marcus), { posterId: id });
  });
});

// ── Pages ────────────────────────────────────────────────────────────────────

describe("the Posters page", () => {
  // Its own database, so the other tests' posters don't get in the way.
  let l: TestDb;
  let me: Actor;
  let other: Actor;
  let leader: Actor;
  const at = (minutes: number) => new Date(TEST_NOW.getTime() + minutes * 60_000);

  beforeAll(async () => {
    l = await createTestDb();
    me = await makeUser(l.db, { name: "Gwen Byers", role: "MEMBER", subteam: "BUSINESS" });
    other = await makeUser(l.db, { name: "Ava Thompson", role: "MEMBER", subteam: "BUSINESS" });
    leader = await makeUser(l.db, { name: "Amara Okafor", role: "BUSINESS_LEADER" });
  });
  afterAll(async () => {
    await l.drop();
  });

  async function add(actor: Actor, minutes: number, over: Record<string, unknown>, picked: unknown = file()) {
    const c = { ...contextFor(l.db, actor), now: at(minutes) };
    return createPoster(c, { ...form(over), file: picked });
  }

  it("Upcoming has today-or-later and undated posters, newest first; Past has the rest, most recent event first", async () => {
    const today = await add(me, 1, { title: "Today", eventDate: TEST_TODAY });
    const undated = await add(other, 2, { title: "Recruiting", event: "Recruiting" });
    const soon = await add(me, 3, { title: "Library demo", event: "Library demo", eventDate: addDays(TEST_TODAY, 10) }, file("demo.pdf", PDF, "application/pdf"));
    const link = await add(other, 4, { title: "Car wash", link: "https://www.canva.com/design/car-wash" }, null);
    const yesterday = await add(other, 5, { title: "Yesterday", eventDate: addDays(TEST_TODAY, -1) });
    const lastMonth = await add(me, 6, { title: "Summer showcase", eventDate: addDays(TEST_TODAY, -30) });

    const upcoming = await listPosters(me, { view: "upcoming", mine: false, today: TEST_TODAY }, l.db);
    expect(upcoming?.items.map((p) => p.title)).toEqual(["Car wash", "Library demo", "Recruiting", "Today"]);
    expect(upcoming?.counts).toEqual({ upcoming: 4, past: 2 });
    const past = await listPosters(me, { view: "past", mine: false, today: TEST_TODAY }, l.db);
    expect(past?.items.map((p) => p.id)).toEqual([yesterday.id, lastMonth.id]);

    // The tiles: pictures show the picture (the file route), PDFs and links get their own tile. Never bytes.
    const byId = new Map(upcoming!.items.map((p) => [p.id, p]));
    const todayFile = await l.db.posterFile.findUniqueOrThrow({ where: { posterId: today.id } });
    expect(byId.get(today.id)).toEqual({
      id: today.id,
      title: "Today",
      event: "",
      eventDate: TEST_TODAY,
      kind: "image",
      imageSrc: `/posters/files/${todayFile.id}`,
      linkHost: "",
      createdByName: "Gwen Byers",
      mine: true,
    });
    expect(byId.get(soon.id)).toMatchObject({ kind: "pdf", imageSrc: null, event: "Library demo", eventDate: addDays(TEST_TODAY, 10) });
    expect(byId.get(link.id)).toMatchObject({ kind: "link", imageSrc: null, linkHost: "canva.com", mine: false });
    expect(byId.get(undated.id)).toMatchObject({ eventDate: null, event: "Recruiting" });
    for (const p of upcoming!.items) expect(Object.keys(p)).not.toContain("data");
    expect(JSON.stringify(upcoming)).not.toContain("PNG");

    // The day after, "Today" is past.
    const tomorrow = await listPosters(me, { view: "past", mine: false, today: addDays(TEST_TODAY, 1) }, l.db);
    expect(tomorrow?.items.map((p) => p.title)).toEqual(["Today", "Yesterday", "Summer showcase"]);
  });

  it("“Added by me” shows only the viewer's posters, and the counts follow it", async () => {
    const mine = await listPosters(me, { view: "upcoming", mine: true, today: TEST_TODAY }, l.db);
    expect(mine?.items.map((p) => p.title)).toEqual(["Library demo", "Today"]);
    expect(mine?.counts).toEqual({ upcoming: 2, past: 1 });
    expect(mine?.items.every((p) => p.mine)).toBe(true);
    const theirs = await listPosters(leader, { view: "past", mine: true, today: TEST_TODAY }, l.db);
    expect(theirs).toMatchObject({ items: [], counts: { upcoming: 0, past: 0 }, page: 1, pageCount: 1 });
  });

  it(`pages hold ${POSTERS_PAGE_SIZE} posters`, async () => {
    await l.db.poster.createMany({
      data: Array.from({ length: POSTERS_PAGE_SIZE }, (_, i) => ({
        title: `Bulk ${i}`,
        link: "https://example.com/bulk",
        createdById: leader.id,
        createdAt: at(100 + i),
      })),
    });
    const first = await listPosters(me, { view: "upcoming", mine: false, today: TEST_TODAY, page: 1 }, l.db);
    expect(first).toMatchObject({ page: 1, pageCount: 2 });
    expect(first?.items).toHaveLength(POSTERS_PAGE_SIZE);
    expect(first?.items[0].title).toBe(`Bulk ${POSTERS_PAGE_SIZE - 1}`);
    const second = await listPosters(me, { view: "upcoming", mine: false, today: TEST_TODAY, page: 2 }, l.db);
    expect(second?.items.map((p) => p.title)).toEqual(["Car wash", "Library demo", "Recruiting", "Today"]);
    // A page past the end shows the last one.
    expect((await listPosters(me, { view: "upcoming", mine: false, today: TEST_TODAY, page: 9 }, l.db))?.page).toBe(2);
    await l.db.poster.deleteMany({ where: { title: { startsWith: "Bulk " } } });
  });

  it("a poster's page has everything about it, and who may change it", async () => {
    const { id } = await add(me, 10, {
      title: "Robot demo at the library",
      description: "Tape it up by the front desk.",
      event: "Library demo",
      eventDate: "2026-10-04",
      link: "https://www.canva.com/design/demo",
    });
    const f = await l.db.posterFile.findUniqueOrThrow({ where: { posterId: id } });
    const forOther = await getPosterDetail(other, id, l.db);
    expect(forOther).toEqual({
      id,
      title: "Robot demo at the library",
      description: "Tape it up by the front desk.",
      link: "https://www.canva.com/design/demo",
      linkHost: "canva.com",
      event: "Library demo",
      eventDate: "2026-10-04",
      file: {
        id: f.id,
        filename: "flyer.png",
        size: PNG.byteLength,
        kind: "image",
        viewHref: `/posters/files/${f.id}`,
        downloadHref: `/posters/files/${f.id}?download=1`,
      },
      createdByName: "Gwen Byers",
      createdAt: at(10),
      updatedAt: expect.any(Date),
      canEdit: false,
    });
    expect((await getPosterDetail(me, id, l.db))?.canEdit).toBe(true);
    expect((await getPosterDetail(leader, id, l.db))?.canEdit).toBe(true);
    expect(await getPosterForEdit(other, id, l.db)).toBeNull();
    expect((await getPosterForEdit(leader, id, l.db))?.id).toBe(id);
    expect(await getPosterDetail(me, "missing", l.db)).toBeNull();
    expect(await getPosterDetail(me, "x".repeat(65), l.db)).toBeNull();
  });

  it("links written outside the app are only shown when they're http(s)", async () => {
    const bad = await l.db.poster.create({ data: { title: "Odd link", link: "javascript:alert(1)", createdById: me.id, createdAt: at(-1000) } });
    expect(await getPosterDetail(me, bad.id, l.db)).toMatchObject({ link: "", linkHost: "" });
    const tile = (await listPosters(me, { view: "upcoming", mine: true, today: TEST_TODAY }, l.db))?.items.find((p) => p.id === bad.id);
    expect(tile).toMatchObject({ kind: "link", linkHost: "" });
    await l.db.poster.delete({ where: { id: bad.id } });
  });
});

describe("the file route", () => {
  it("any active person gets the bytes; the headers show pictures and PDFs inline, safely", async () => {
    const png = await create(gwen, { title: "Route PNG" }, file("route.png"));
    const pdf = await create(gwen, { title: "Route PDF" }, file("route.pdf", PDF, "application/pdf"));
    const pngFile = await t.db.posterFile.findUniqueOrThrow({ where: { posterId: png.id } });
    const pdfFile = await t.db.posterFile.findUniqueOrThrow({ where: { posterId: pdf.id } });

    for (const a of [maya, ethan, priya, jordan, olivia]) {
      const got = await getPosterFile(a, pngFile.id, t.db);
      expect(got?.filename, a.name).toBe("route.png");
      expect(Buffer.from(got!.data!).equals(Buffer.from(PNG)), a.name).toBe(true);
    }
    for (const a of [pending, disabled, rejected]) expect(await getPosterFile(a, pngFile.id, t.db), a.name).toBeNull();
    expect(await getPosterFile(gwen, "missing", t.db)).toBeNull();
    expect(await getPosterFile(gwen, "", t.db)).toBeNull();
    expect(await getPosterFile(gwen, "x".repeat(65), t.db)).toBeNull();
    expect(posterFileHref("a b", true)).toBe("/posters/files/a%20b?download=1");

    const got = (await getPosterFile(gwen, pngFile.id, t.db))!;
    const inline = fileResponseHeaders({ filename: got.filename, contentType: got.contentType, byteLength: got.data!.byteLength });
    expect(inline).toMatchObject({
      "Content-Type": "image/png",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": FILE_CSP,
      "Cache-Control": "private, no-store",
    });
    expect(inline["Content-Disposition"]).toMatch(/^inline; filename="route\.png"/);
    const download = fileResponseHeaders({ filename: got.filename, contentType: got.contentType, byteLength: got.data!.byteLength }, { download: true });
    expect(download["Content-Type"]).toBe("application/octet-stream");
    expect(download["Content-Disposition"]).toMatch(/^attachment; filename="route\.png"/);

    // Poster files never change at their address (a new file gets a new id), so browsers may keep them when shown
    // inline (the grid isn't downloaded again on every visit). Downloads, and every other kind of file, aren't kept.
    const kept = fileResponseHeaders({ filename: got.filename, contentType: got.contentType, byteLength: got.data!.byteLength }, { immutable: true });
    expect(kept["Cache-Control"]).toBe(IMMUTABLE_FILE_CACHE);
    expect(IMMUTABLE_FILE_CACHE).toBe("private, max-age=604800, immutable");
    const keptDownload = fileResponseHeaders(
      { filename: got.filename, contentType: got.contentType, byteLength: got.data!.byteLength },
      { immutable: true, download: true },
    );
    expect(keptDownload["Cache-Control"]).toBe("private, no-store");
    const sent = await sendStoredFile(new NextRequest(`http://localhost/posters/files/${pngFile.id}`), got, { immutable: true });
    expect(sent.headers.get("cache-control")).toBe(IMMUTABLE_FILE_CACHE);
    expect(sent.headers.get("content-type")).toBe("image/png");
    const sentDownload = await sendStoredFile(new NextRequest(`http://localhost/posters/files/${pngFile.id}?download=1`), got, { immutable: true });
    expect(sentDownload.headers.get("cache-control")).toBe("private, no-store");
    expect((await sendStoredFile(new NextRequest(`http://localhost/resources/files/x`), got)).headers.get("cache-control")).toBe("private, no-store");

    const pdfGot = (await getPosterFile(maya, pdfFile.id, t.db))!;
    expect(fileResponseHeaders({ filename: pdfGot.filename, contentType: pdfGot.contentType, byteLength: pdfGot.data!.byteLength })).toMatchObject({
      "Content-Type": "application/pdf",
      "Content-Security-Policy": PDF_CSP,
    });
  });
});
