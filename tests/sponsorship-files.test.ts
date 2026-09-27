import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LIMITS } from "@/lib/constants";
import { sponsorFileTooBigMessage } from "@/lib/files";
import type { Actor } from "@/server/actor";
import { ForbiddenError, NotFoundError, RateLimitError, ValidationError } from "@/server/errors";
import { fileStorageUsage, storageFullSentence, usedFileStorageBytes } from "@/server/files/storage";
import { canDeleteSponsorshipFile, canManageSponsorships } from "@/server/permissions";
import { getUserDetail } from "@/server/queries/admin";
import { getFileStorageUsage } from "@/server/queries/files";
import { getSponsorship, getSponsorshipFile, listSponsorships, sponsorshipFileHref } from "@/server/queries/sponsorships";
import { fileResponseHeaders, PDF_CSP } from "@/server/resources/serve";
import { deleteUser, HAS_ACTIVITY_MESSAGE } from "@/server/services/admin";
import { createResource } from "@/server/services/resources";
import {
  deleteSponsorshipFile,
  SPONSOR_FILE_BYTES_PER_PERSON,
  SPONSORSHIP_FILE_NOT_FOUND,
  SPONSORSHIP_FILE_UPLOADS_PER_HOUR,
  uploadSponsorshipFile,
} from "@/server/services/sponsorship-files";
import { deleteSponsorship, SPONSORSHIP_NOT_FOUND } from "@/server/services/sponsorships";
import { createTestDb, type TestDb } from "./helpers/db";
import { contextFor, makeUser, TEST_NOW, TEST_TODAY } from "./helpers/factories";

let t: TestDb;
let ava: Actor; // Business member
let daniel: Actor; // Business member
let amara: Actor; // Business leader
let maya: Actor; // Software member
let ethan: Actor; // Build member
let priya: Actor; // Software leader
let jordan: Actor; // Captain
let elena: Actor; // Mentor
let david: Actor; // Teacher
let olivia: Actor; // Owner (a Build member with the Owner flag)
let pendingBiz: Actor;
let disabledBiz: Actor;
let pendingLeader: Actor;

beforeAll(async () => {
  t = await createTestDb();
  ava = await makeUser(t.db, { name: "Ava Thompson", role: "MEMBER", subteam: "BUSINESS" });
  daniel = await makeUser(t.db, { name: "Daniel Park", role: "MEMBER", subteam: "BUSINESS" });
  amara = await makeUser(t.db, { name: "Amara Okafor", role: "BUSINESS_LEADER" });
  maya = await makeUser(t.db, { name: "Maya Patel", role: "MEMBER", subteam: "SOFTWARE" });
  ethan = await makeUser(t.db, { name: "Ethan Chen", role: "MEMBER", subteam: "BUILD" });
  priya = await makeUser(t.db, { name: "Priya Raman", role: "SOFTWARE_LEADER" });
  jordan = await makeUser(t.db, { name: "Jordan Lee", role: "CAPTAIN" });
  elena = await makeUser(t.db, { name: "Elena Petrova", role: "MENTOR" });
  david = await makeUser(t.db, { name: "David Kim", role: "TEACHER" });
  olivia = await makeUser(t.db, { name: "Olivia Stone", role: "MEMBER", subteam: "BUILD", isAdmin: true });
  pendingBiz = await makeUser(t.db, { name: "Pat Pending", role: "MEMBER", subteam: "BUSINESS", status: "PENDING" });
  disabledBiz = await makeUser(t.db, { name: "Dana Gone", role: "MEMBER", subteam: "BUSINESS", status: "DISABLED" });
  pendingLeader = await makeUser(t.db, { name: "Quinn Waiting", role: "BUSINESS_LEADER", status: "PENDING" });
});
afterAll(async () => {
  await t.drop();
});

const ctx = (actor: Actor) => contextFor(t.db, actor);

let seq = 0;
/** A sponsor written straight to the DB. */
async function makeSponsorship(data: { name?: string; createdById?: string | null } = {}) {
  return t.db.sponsorship.create({ data: { name: data.name ?? `Sponsor ${++seq}`, createdById: data.createdById ?? null } });
}

const PDF = "%PDF-1.4\n% sponsor application form\n";

/** A picked file, as the Server Action passes it to the service. */
function file(name = "Polymaker application.pdf", content: string | Uint8Array = PDF, type = "application/pdf") {
  return { name, type, bytes: typeof content === "string" ? new TextEncoder().encode(content) : content };
}

async function upload(actor: Actor, sponsorshipId: string, picked: unknown = file()) {
  return uploadSponsorshipFile(ctx(actor), { sponsorshipId, file: picked });
}

async function errorOf(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => null,
    (e: unknown) => e,
  );
}

async function fileErrorOf(p: Promise<unknown>): Promise<string | undefined> {
  const err = await errorOf(p);
  expect(err).toBeInstanceOf(ValidationError);
  return (err as ValidationError).fieldErrors.file;
}

// ── Who can do what ────────────────────────────────────────────────────────────

describe("who can add, open, and remove sponsor files", () => {
  it("the Business team and staff can upload; the file is stored with who added it", async () => {
    const s = await makeSponsorship();
    for (const a of [ava, amara, priya, jordan, elena, david, olivia]) {
      const { id, filename } = await upload(a, s.id, file(`Form from ${a.name}.pdf`));
      expect(filename).toBe(`Form from ${a.name}.pdf`);
      const row = await t.db.sponsorshipFile.findUniqueOrThrow({ where: { id } });
      expect(row).toMatchObject({ sponsorshipId: s.id, uploadedById: a.id, contentType: "application/pdf", size: PDF.length });
      expect(row.createdAt).toEqual(TEST_NOW);
      expect(new TextDecoder().decode(row.data)).toBe(PDF);
    }
  });

  it("other subteams' members and accounts that aren't active are turned away (nothing is written or read)", async () => {
    const s = await makeSponsorship({ createdById: ava.id });
    const { id } = await upload(ava, s.id);
    for (const a of [maya, ethan, pendingBiz, disabledBiz, pendingLeader]) {
      await expect(upload(a, s.id), a.name).rejects.toBeInstanceOf(ForbiddenError);
      await expect(deleteSponsorshipFile(ctx(a), { fileId: id }), a.name).rejects.toBeInstanceOf(ForbiddenError);
      // Same answer for a file that doesn't exist, so ids don't leak.
      await expect(deleteSponsorshipFile(ctx(a), { fileId: "missing" }), a.name).rejects.toBeInstanceOf(ForbiddenError);
      expect(await getSponsorshipFile(a, id, t.db), a.name).toBeNull();
      expect(await getSponsorship(a, s.id, t.db), a.name).toBeNull();
    }
    expect(await t.db.sponsorshipFile.count({ where: { sponsorshipId: s.id } })).toBe(1);
  });

  it("canDeleteSponsorshipFile: the uploader, plus whoever can remove the sponsor", () => {
    const f = (uploadedById: string | null, createdById: string | null) => ({ uploadedById, sponsorship: { createdById } });
    expect(canDeleteSponsorshipFile(ava, f(ava.id, null))).toBe(true);
    expect(canDeleteSponsorshipFile(daniel, f(ava.id, daniel.id))).toBe(true); // added the sponsor
    expect(canDeleteSponsorshipFile(daniel, f(ava.id, null))).toBe(false);
    expect(canDeleteSponsorshipFile(daniel, f(null, null))).toBe(false);
    for (const a of [amara, jordan, elena, david, olivia]) expect(canDeleteSponsorshipFile(a, f(ava.id, null)), a.name).toBe(true);
    expect(canDeleteSponsorshipFile(priya, f(ava.id, null))).toBe(false);
    expect(canDeleteSponsorshipFile(priya, f(priya.id, null))).toBe(true);
    // Uploaded it, but can't use Sponsorships any more (e.g. moved to another subteam).
    expect(canDeleteSponsorshipFile(maya, f(maya.id, maya.id))).toBe(false);
  });

  it("canManageSponsorships: the Business leader, captain, mentors, teachers, and owners", () => {
    for (const a of [amara, jordan, elena, david, olivia]) expect(canManageSponsorships(a), a.name).toBe(true);
    for (const a of [ava, daniel, priya, maya, ethan]) expect(canManageSponsorships(a), a.name).toBe(false);
  });
});

// ── Validation ────────────────────────────────────────────────────────────────

describe("checking uploads", () => {
  let uploader: Actor;
  beforeAll(async () => {
    uploader = await makeUser(t.db, { name: "Gwen Business", role: "MEMBER", subteam: "BUSINESS" });
  });

  it("needs a file that isn't empty", async () => {
    const s = await makeSponsorship();
    // What the Server Action passes when no file was chosen.
    expect(await fileErrorOf(uploadSponsorshipFile(ctx(uploader), { sponsorshipId: s.id, file: undefined }))).toBe("Choose a file to upload.");
    // Only a name (what formDataToObject keeps) isn't a file.
    expect(await fileErrorOf(upload(uploader, s.id, "form.pdf"))).toBe("Choose a file to upload.");
    expect(await fileErrorOf(upload(uploader, s.id, file("empty.pdf", "")))).toMatch(/empty/);
    expect(await t.db.sponsorshipFile.count({ where: { sponsorshipId: s.id } })).toBe(0);
  });

  it("files can be up to 4 MB, and the message says so in MB", async () => {
    const s = await makeSponsorship();
    const tooBig = LIMITS.resourceFileMaxBytes + 1;
    const message = await fileErrorOf(upload(uploader, s.id, file("scan.pdf", new Uint8Array(tooBig))));
    expect(message).toBe(sponsorFileTooBigMessage(tooBig));
    expect(message).toMatch(/^That file is 4\.0 MB\. Files can be up to 4 MB each/);
    // Exactly 4 MB is fine.
    await upload(uploader, s.id, file("scan.pdf", new Uint8Array(LIMITS.resourceFileMaxBytes).fill(37)));
    expect(await t.db.sponsorshipFile.count({ where: { sponsorshipId: s.id } })).toBe(1);
  });

  it("refuses files that can run programs", async () => {
    const s = await makeSponsorship();
    for (const name of ["setup.exe", "Form.MSI", "run.bat", "x.cmd", "p.ps1", "v.vbs", "Shortcut.lnk", "tool.js", "app.jar", "form\u202Efdp.exe", "trailing.exe. "]) {
      expect(await fileErrorOf(upload(uploader, s.id, file(name, "MZ"))), name).toMatch(/can't be uploaded because they can run programs/);
    }
    expect(await t.db.sponsorshipFile.count({ where: { sponsorshipId: s.id } })).toBe(0);
  });

  it("cleans the file name and the browser's type", async () => {
    const s = await makeSponsorship();
    const a = await upload(uploader, s.id, file("C:\\Users\\gwen\\Desktop\\Polymaker  form.pdf", PDF, "application/pdf; charset=binary"));
    expect(a.filename).toBe("Polymaker form.pdf");
    const b = await upload(uploader, s.id, file("../../signed\u0000 copy.docx", "PK", "not a type"));
    expect(b.filename).toBe("signed copy.docx");
    const rows = await t.db.sponsorshipFile.findMany({ where: { sponsorshipId: s.id }, orderBy: { filename: "asc" }, select: { filename: true, contentType: true } });
    expect(rows).toEqual([
      { filename: "Polymaker form.pdf", contentType: "application/pdf" },
      { filename: "signed copy.docx", contentType: "application/octet-stream" },
    ]);
  });

  it("needs a sponsor that exists", async () => {
    await expect(upload(uploader, "")).rejects.toBeInstanceOf(ValidationError);
    const err = await errorOf(upload(uploader, "no-such-sponsor"));
    expect(err).toBeInstanceOf(NotFoundError);
    expect((err as NotFoundError).userMessage).toBe(SPONSORSHIP_NOT_FOUND);
  });

  it(`a sponsor holds at most ${LIMITS.sponsorFilesMax} files; removing one makes room`, async () => {
    const filer = await makeUser(t.db, { role: "MEMBER", subteam: "BUSINESS" });
    const s = await makeSponsorship();
    const ids: string[] = [];
    for (let i = 0; i < LIMITS.sponsorFilesMax; i++) ids.push((await upload(filer, s.id, file(`page ${i + 1}.pdf`))).id);
    expect(await fileErrorOf(upload(filer, s.id, file("one more.pdf")))).toMatch(new RegExp(`already has ${LIMITS.sponsorFilesMax} files`));
    // Other sponsors aren't affected.
    await upload(filer, (await makeSponsorship()).id, file("other.pdf"));
    await deleteSponsorshipFile(ctx(filer), { fileId: ids[0] });
    await upload(filer, s.id, file("one more.pdf"));
    expect(await t.db.sponsorshipFile.count({ where: { sponsorshipId: s.id } })).toBe(LIMITS.sponsorFilesMax);
  });

  it(`each person can upload ${SPONSORSHIP_FILE_UPLOADS_PER_HOUR} files an hour`, async () => {
    const busy = await makeUser(t.db, { role: "MEMBER", subteam: "BUSINESS" });
    let sponsor = await makeSponsorship();
    for (let i = 0; i < SPONSORSHIP_FILE_UPLOADS_PER_HOUR; i++) {
      if (i > 0 && i % LIMITS.sponsorFilesMax === 0) sponsor = await makeSponsorship();
      await upload(busy, sponsor.id, file(`f${i}.pdf`));
    }
    await expect(upload(busy, (await makeSponsorship()).id)).rejects.toBeInstanceOf(RateLimitError);
    // An hour later it's fine again.
    const later = { ...ctx(busy), now: new Date(TEST_NOW.getTime() + 61 * 60 * 1000) };
    await uploadSponsorshipFile(later, { sponsorshipId: (await makeSponsorship()).id, file: file() });
  });
});

// ── Storage shared with Resources ─────────────────────────────────────────────

describe("the team's file storage", () => {
  it("Resources files and sponsor files share one cap", async () => {
    const uploader = await makeUser(t.db, { role: "MEMBER", subteam: "BUSINESS" });
    const s = await makeSponsorship();
    // A big Resources file that leaves exactly 30 bytes free.
    const holder = await t.db.resource.create({
      data: { title: "Big old CAD export", file: { create: { filename: "big.step", contentType: "application/octet-stream", size: 0, data: new Uint8Array([1]) } } },
    });
    const used = await t.db.$transaction((tx) => usedFileStorageBytes(tx));
    await t.db.resourceFile.update({ where: { resourceId: holder.id }, data: { size: LIMITS.resourceStorageMaxBytes - used - 30 } });

    // The message says where the space is going and who can free it.
    const almostFull = await t.db.$transaction((tx) => fileStorageUsage(tx));
    expect(await fileErrorOf(upload(uploader, s.id, file("form.pdf", "x".repeat(31))))).toBe(
      `${storageFullSentence(almostFull)} Remove sponsor files you don't need, or ask the Business leader, captain, or a mentor to clear out old ones. Admins can remove old Resources files.`,
    );
    expect(storageFullSentence(almostFull)).toMatch(/^The team's file storage is full: \d+ MB of Resources files and [\d.]+ (KB|MB|bytes) of sponsor files\.$/);
    const { id } = await upload(uploader, s.id, file("form.pdf", "x".repeat(30))); // exactly full is fine

    // Now a Resources upload doesn't fit either: the sponsor file counts.
    const resourceForm = { title: "Tiny", kind: "file", type: "OTHER", group: "", description: "", pinned: "", links: "", file: file("tiny.txt", "y", "text/plain") };
    const full = await errorOf(createResource(ctx(elena), resourceForm));
    expect(full).toBeInstanceOf(ValidationError);
    const nowFull = await t.db.$transaction((tx) => fileStorageUsage(tx));
    expect(nowFull.used).toBe(LIMITS.resourceStorageMaxBytes);
    expect((full as ValidationError).fieldErrors.file).toBe(
      `${storageFullSentence(nowFull)} Share a link instead, or ask an admin to remove old Resources files. The Business leader, captain, mentors, and teachers can clear out sponsor files.`,
    );

    // Removing the sponsor file frees its space.
    await deleteSponsorshipFile(ctx(uploader), { fileId: id });
    await createResource(ctx(elena), resourceForm);

    await t.db.resource.deleteMany({ where: { OR: [{ id: holder.id }, { title: "Tiny" }] } });
  });

  it("admins and people who use Sponsorships can see how much is used, and by what", async () => {
    const before = await getFileStorageUsage(amara, t.db);
    expect(before).not.toBeNull();
    await upload(amara, (await makeSponsorship()).id, file("usage.pdf", "x".repeat(1000)));
    const after = await getFileStorageUsage(priya, t.db);
    expect(after).toEqual({ ...before, sponsors: before!.sponsors + 1000, used: before!.used + 1000 });
    expect(after).toMatchObject({ max: LIMITS.resourceStorageMaxBytes, used: after!.resources + after!.sponsors });
    expect(await getFileStorageUsage(ava, t.db)).toEqual(after);
    for (const a of [maya, ethan, pendingBiz, disabledBiz, pendingLeader]) expect(await getFileStorageUsage(a, t.db), a.name).toBeNull();
  });
});

// ── Each person's share ────────────────────────────────────────────────────────

describe("how much one person can upload", () => {
  /** Makes it look like `who` already uploaded `bytes` of sponsor files (only the size column counts). */
  async function alreadyUploaded(who: Actor, bytes: number) {
    const s = await makeSponsorship();
    return t.db.sponsorshipFile.create({
      data: { sponsorshipId: s.id, uploadedById: who.id, filename: "old scan.pdf", contentType: "application/pdf", size: bytes, data: new Uint8Array([1]), createdAt: TEST_NOW },
    });
  }

  it(`a member's sponsor files stay under ${SPONSOR_FILE_BYTES_PER_PERSON / 1024 / 1024} MB; removing some frees it up`, async () => {
    const gwen = await makeUser(t.db, { name: "Gwen Byers", role: "MEMBER", subteam: "BUSINESS" });
    const old = await alreadyUploaded(gwen, SPONSOR_FILE_BYTES_PER_PERSON - 30);
    const s = await makeSponsorship();
    expect(await fileErrorOf(upload(gwen, s.id, file("form.pdf", "x".repeat(31))))).toBe(
      "You've uploaded 50 MB of sponsor files, and each person can have up to 50 MB. Remove ones you don't need, or ask the Business leader to add this one.",
    );
    await upload(gwen, s.id, file("form.pdf", "x".repeat(30))); // exactly at the limit is fine
    // Other people's files (even on the same sponsor) don't count toward hers.
    await upload(daniel, s.id, file("daniel's copy.pdf"));
    expect(await fileErrorOf(upload(gwen, s.id, file("one more.pdf", "x")))).toMatch(/^You've uploaded 50 MB of sponsor files/);
    await deleteSponsorshipFile(ctx(gwen), { fileId: old.id });
    await upload(gwen, s.id, file("one more.pdf", "x"));
    expect(await t.db.sponsorshipFile.count({ where: { uploadedById: gwen.id } })).toBe(2);
  });

  it("the Business leader, captain, mentors, teachers, and owners aren't limited; other subteams' leaders are", async () => {
    const s = await makeSponsorship();
    for (const a of [amara, jordan, elena, david, olivia]) {
      const old = await alreadyUploaded(a, SPONSOR_FILE_BYTES_PER_PERSON);
      await upload(a, s.id, file(`from ${a.name}.pdf`));
      await t.db.sponsorshipFile.delete({ where: { id: old.id } });
    }
    const old = await alreadyUploaded(priya, SPONSOR_FILE_BYTES_PER_PERSON);
    expect(await fileErrorOf(upload(priya, s.id, file("form.pdf")))).toMatch(/each person can have up to 50 MB/);
    await t.db.sponsorshipFile.delete({ where: { id: old.id } });
    await upload(priya, s.id, file("form.pdf"));
  });
});

// ── Removing ────────────────────────────────────────────────────────────────

describe("removing a file", () => {
  it("the uploader can remove their own; it says which file it was", async () => {
    const s = await makeSponsorship();
    const { id } = await upload(ava, s.id, file("mine.pdf"));
    expect(await deleteSponsorshipFile(ctx(ava), { fileId: id })).toEqual({ filename: "mine.pdf", sponsorshipId: s.id });
    expect(await t.db.sponsorshipFile.count({ where: { id } })).toBe(0);
  });

  it("other members and other subteams' leaders can't remove someone else's file", async () => {
    const s = await makeSponsorship({ createdById: ava.id });
    const { id } = await upload(ava, s.id);
    for (const a of [daniel, priya]) {
      const err = await errorOf(deleteSponsorshipFile(ctx(a), { fileId: id }));
      expect(err, a.name).toBeInstanceOf(ForbiddenError);
      expect((err as ForbiddenError).userMessage).toMatch(/^Only the person who uploaded this file/);
    }
    expect(await t.db.sponsorshipFile.count({ where: { id } })).toBe(1);
  });

  it("whoever added the sponsor, the Business leader, captain, mentors, teachers, and owners can remove any", async () => {
    const s = await makeSponsorship({ createdById: daniel.id });
    for (const a of [daniel, amara, jordan, elena, david, olivia]) {
      const { id } = await upload(ava, s.id, file(`for ${a.name}.pdf`));
      await deleteSponsorshipFile(ctx(a), { fileId: id });
      expect(await t.db.sponsorshipFile.count({ where: { id } }), a.name).toBe(0);
    }
  });

  it("a missing file (or one removed a moment ago) is NotFound; bad input is a ValidationError", async () => {
    const s = await makeSponsorship();
    const { id } = await upload(amara, s.id);
    await deleteSponsorshipFile(ctx(amara), { fileId: id });
    const err = await errorOf(deleteSponsorshipFile(ctx(amara), { fileId: id }));
    expect(err).toBeInstanceOf(NotFoundError);
    expect((err as NotFoundError).userMessage).toBe(SPONSORSHIP_FILE_NOT_FOUND);
    await expect(deleteSponsorshipFile(ctx(amara), {})).rejects.toBeInstanceOf(ValidationError);
  });

  it("removing the sponsor removes its files", async () => {
    const s = await makeSponsorship({ createdById: ava.id });
    await upload(ava, s.id, file("a.pdf"));
    await upload(daniel, s.id, file("b.pdf"));
    await deleteSponsorship(ctx(ava), { sponsorshipId: s.id });
    expect(await t.db.sponsorshipFile.count({ where: { sponsorshipId: s.id } })).toBe(0);
  });
});

// ── Pages ────────────────────────────────────────────────────────────────────

describe("what the pages get", () => {
  it("the sponsor's page lists its files oldest first, with details but never the bytes", async () => {
    const s = await makeSponsorship({ createdById: amara.id });
    const pdf = await upload(ava, s.id, file("Polymaker application.pdf"));
    const later = { ...ctx(daniel), now: new Date(TEST_NOW.getTime() + 60_000) };
    const docx = await uploadSponsorshipFile(later, { sponsorshipId: s.id, file: file("Signed copy.docx", "PK", "application/vnd.openxmlformats-officedocument.wordprocessingml.document") });

    const forDaniel = await getSponsorship(daniel, s.id, t.db);
    expect(forDaniel?.files).toEqual([
      {
        id: pdf.id,
        filename: "Polymaker application.pdf",
        size: PDF.length,
        contentType: "application/pdf",
        uploadedByName: "Ava Thompson",
        createdAt: TEST_NOW,
        canDelete: false,
        viewHref: `/sponsors/files/${pdf.id}`,
        downloadHref: `/sponsors/files/${pdf.id}?download=1`,
      },
      {
        id: docx.id,
        filename: "Signed copy.docx",
        size: 2,
        contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        uploadedByName: "Daniel Park",
        createdAt: new Date(TEST_NOW.getTime() + 60_000),
        canDelete: true,
        // Word files are only downloaded.
        viewHref: null,
        downloadHref: `/sponsors/files/${docx.id}?download=1`,
      },
    ]);
    expect((await getSponsorship(ava, s.id, t.db))?.files.map((f) => f.canDelete)).toEqual([true, false]);
    expect((await getSponsorship(amara, s.id, t.db))?.files.map((f) => f.canDelete)).toEqual([true, true]);
    expect(forDaniel?.fileCount).toBe(2);
  });

  it("a file keeps working after its uploader's account is gone", async () => {
    const leaving = await makeUser(t.db, { name: "Leaving Soon", role: "MEMBER", subteam: "BUSINESS" });
    const s = await makeSponsorship();
    const { id } = await upload(leaving, s.id);
    await t.db.user.delete({ where: { id: leaving.id } });
    const detail = await getSponsorship(amara, s.id, t.db);
    expect(detail?.files).toMatchObject([{ id, uploadedByName: null, canDelete: true }]);
    expect((await getSponsorship(daniel, s.id, t.db))?.files[0].canDelete).toBe(false);
  });

  it("the list has how many files each sponsor has", async () => {
    const name = `Counted ${Date.now()}`;
    const withFiles = await makeSponsorship({ name: `${name} A` });
    await makeSponsorship({ name: `${name} B` });
    await upload(amara, withFiles.id, file("one.pdf"));
    await upload(amara, withFiles.id, file("two.png", "PNG", "image/png"));
    const list = await listSponsorships(amara, { filter: "all", today: TEST_TODAY }, t.db);
    const counts = Object.fromEntries(list!.items.filter((i) => i.name.startsWith(name)).map((i) => [i.name, i.fileCount]));
    expect(counts).toEqual({ [`${name} A`]: 2, [`${name} B`]: 0 });
    expect(await listSponsorships(maya, { filter: "all", today: TEST_TODAY }, t.db)).toBeNull();
  });

  it("the file route gets the bytes only for people who can use Sponsorships", async () => {
    const s = await makeSponsorship();
    const { id } = await upload(ava, s.id, file("sponsor-form.pdf"));
    const got = await getSponsorshipFile(priya, id, t.db);
    expect(got?.filename).toBe("sponsor-form.pdf");
    expect(new TextDecoder().decode(got!.data)).toBe(PDF);
    for (const a of [maya, ethan, pendingBiz, disabledBiz]) expect(await getSponsorshipFile(a, id, t.db), a.name).toBeNull();
    expect(await getSponsorshipFile(ava, "missing", t.db)).toBeNull();
    expect(await getSponsorshipFile(ava, "x".repeat(65), t.db)).toBeNull();
    expect(sponsorshipFileHref("a b", true)).toBe("/sponsors/files/a%20b?download=1");

    // PDFs open in the browser (without `sandbox`, which Chrome's viewer refuses); ?download=1 downloads.
    const inline = fileResponseHeaders({ filename: got!.filename, contentType: got!.contentType, byteLength: got!.data.byteLength });
    expect(inline).toMatchObject({ "Content-Type": "application/pdf", "Content-Security-Policy": PDF_CSP, "X-Content-Type-Options": "nosniff" });
    expect(inline["Content-Disposition"]).toMatch(/^inline; filename="sponsor-form\.pdf"/);
    const download = fileResponseHeaders({ filename: "Signed copy.docx", contentType: "application/msword", byteLength: 2 }, { download: true });
    expect(download["Content-Type"]).toBe("application/octet-stream");
    expect(download["Content-Disposition"]).toMatch(/^attachment; /);
  });
});

// ── Accounts ─────────────────────────────────────────────────────────────────

describe("deleting accounts", () => {
  it("someone who uploaded a sponsor file can't be deleted (disable them instead)", async () => {
    const owner = await makeUser(t.db, { name: "Ada Owner", role: "MENTOR", isAdmin: true });
    const uploader = await makeUser(t.db, { role: "MEMBER", subteam: "BUSINESS" });
    await upload(uploader, (await makeSponsorship()).id);
    await t.db.user.update({ where: { id: uploader.id }, data: { status: "REJECTED" } });
    await expect(deleteUser(ctx(owner), { userId: uploader.id })).rejects.toThrow(HAS_ACTIVITY_MESSAGE);
    expect(await getUserDetail(owner, uploader.id, t.db, TEST_NOW)).toMatchObject({ canDelete: false, hasActivity: true });
    expect(await t.db.sponsorshipFile.count({ where: { uploadedById: uploader.id } })).toBe(1);
  });
});
