// Resources page: shared links and small uploaded files (team docs, code, CAD links, tools…).
// - People with admin access (owners, leaders, captain, mentors, teachers) add resources that go
//   live right away, and can edit / remove / pin anyone's.
// - Members can share too, but theirs wait (PENDING) until someone with admin access approves them.
//   Until then only the member and the reviewers can see them; members can edit (which sends it
//   back for approval) or remove what they shared.
import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { LIMITS, RESOURCE_TYPES } from "@/lib/constants";
import { formatFileSize, RESOURCE_FILE_MAX_MB } from "@/lib/files";
import { parseHttpUrl } from "@/lib/urls";
import { checkbox, idSchema, optionalText, text } from "@/lib/validation";
import { parseInput } from "../action";
import type { ServiceContext } from "../context";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../errors";
import {
  canDeleteResource,
  canEditResource,
  canManageResources,
  canReviewResources,
  canViewResource,
} from "../permissions";
import { enforceRateLimit } from "../rate-limit";
import { fileExtension } from "../resources/serve";

export const RESOURCE_NOT_FOUND = "That resource no longer exists.";
export const RESOURCE_ALREADY_REVIEWED = "Someone already reviewed this.";

const HOUR = 60 * 60 * 1000;
/** Adds per person per hour: people with admin access / everyone else (their shares email the reviewers). */
const RATE_LIMITS = { manager: 60, member: 20 } as const;

// Lives in src/lib/urls.ts (the browser uses it too); re-exported so existing imports keep working.
export { parseHttpUrl };

const urlField = z
  .string({ error: "Link is required." })
  .trim()
  .min(1, "Link is required.")
  .transform((v, ctx) => {
    const url = parseHttpUrl(v);
    if (!url) {
      ctx.addIssue({ code: "custom", message: "Enter a full link starting with https://" });
      return z.NEVER;
    }
    return url;
  });

export interface ResourceLink {
  label: string;
  url: string;
}

/** Stored JSON → links, dropping anything malformed (never trusts the column blindly). */
export function readLinks(value: unknown): ResourceLink[] {
  if (!Array.isArray(value)) return [];
  const out: ResourceLink[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const { label, url } = item as Record<string, unknown>;
    const safeUrl = typeof url === "string" ? parseHttpUrl(url) : null;
    if (typeof label !== "string" || !label.trim() || !safeUrl) continue;
    out.push({ label: label.trim().slice(0, LIMITS.resourceLinkLabelMax), url: safeUrl });
  }
  return out.slice(0, LIMITS.resourceLinksMax);
}

/**
 * "Quick links" textarea → links. One per line: `Label | https://…` (or just a URL, labelled by its host).
 * Throws ValidationError on the `links` field naming the bad line.
 */
export function parseLinksText(value: string): ResourceLink[] {
  const lines = value
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length > LIMITS.resourceLinksMax) {
    throw new ValidationError("Too many quick links.", { links: `Add at most ${LIMITS.resourceLinksMax} quick links.` });
  }
  return lines.map((line, i) => {
    // "Label | https://…": split at the "|" that starts the URL, so labels and URLs may contain "|" too.
    const m = line.match(/^(.*?)\s*\|\s*(\S+:\/\/.*)$/);
    const labelPart = m ? m[1].trim() : "";
    const urlPart = m ? m[2].trim() : line;
    const url = parseHttpUrl(urlPart);
    if (!url) {
      throw new ValidationError("Please fix the quick links.", {
        links: `Line ${i + 1}: use “Label | https://…” with a full link.`,
      });
    }
    const label = (labelPart || new URL(url).hostname).slice(0, LIMITS.resourceLinkLabelMax);
    return { label, url };
  });
}

// ---------------------------------------------------------------------------------------------
// Uploaded files
// ---------------------------------------------------------------------------------------------

/** A file picked in the form. The Server Action reads it from FormData (formDataToObject only keeps its name). */
export interface UploadedFile {
  name: string;
  /** Type reported by the browser (may be empty or wrong). */
  type: string;
  bytes: Uint8Array;
}

/** Programs, scripts, and shortcuts that run on Windows when opened. Never accepted. */
export const BLOCKED_EXTENSIONS: ReadonlySet<string> = new Set([
  "exe", "msi", "msp", "msix", "msixbundle", "appx", "appxbundle", "bat", "cmd", "com", "scr", "pif", "cpl", "dll",
  "sys", "drv", "ocx", "ps1", "ps1xml", "ps2", "psm1", "psd1", "psc1", "vb", "vbs", "vbe", "jse", "wsf", "wsh", "ws",
  "wsc", "sct", "hta", "lnk", "url", "reg", "inf", "scf", "msc", "gadget", "application", "chm", "iso", "img", "vhd",
  "vhdx", "appref-ms", "settingcontent-ms", "library-ms", "xll", "xbap",
  // Run on double-click too (Windows Script Host / Java). Share JavaScript as a link or a .txt instead.
  "js", "jar",
]);

/** C0/C1 controls, line/paragraph separators, BOM, and bidi overrides (which can disguise "exe.txt" as "txt.exe"). */
function isUnsafeFilenameChar(code: number): boolean {
  return (
    code < 0x20 ||
    (code >= 0x7f && code < 0xa0) ||
    code === 0x200e ||
    code === 0x200f ||
    (code >= 0x2028 && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069) ||
    code === 0xfeff
  );
}

/**
 * A safe display/download name: the base name only (no folders), no control or bidi characters,
 * no trailing dots/spaces, at most LIMITS.resourceFilenameMax characters (keeping the extension),
 * and "file" when nothing usable is left.
 */
export function cleanFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  let out = "";
  for (const ch of base) if (!isUnsafeFilenameChar(ch.codePointAt(0) ?? 0)) out += ch;
  out = out
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/, ""); // Windows drops these, which could turn "x.exe." into "x.exe"
  if (!out || /^\.+$/.test(out)) return "file";
  const chars = Array.from(out);
  const max = LIMITS.resourceFilenameMax;
  if (chars.length <= max) return out;
  const ext = fileExtension(out);
  const tail = ext && ext.length <= 16 ? `.${ext}` : "";
  return `${chars.slice(0, max - tail.length).join("").trimEnd()}${tail}`;
}

/** The browser's MIME type if it looks like one, else application/octet-stream. Only a hint for serving. */
function cleanContentType(type: string): string {
  const t = type.trim().toLowerCase().split(";")[0].trim();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]{0,62}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,62}$/.test(t) ? t : "application/octet-stream";
}

function readUpload(value: unknown): UploadedFile | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Partial<Record<keyof UploadedFile, unknown>>;
  if (!(v.bytes instanceof Uint8Array)) return null;
  return { name: typeof v.name === "string" ? v.name : "", type: typeof v.type === "string" ? v.type : "", bytes: v.bytes };
}

interface CleanUpload {
  filename: string;
  contentType: string;
  bytes: Uint8Array<ArrayBuffer>;
}

function fileError(message: string): ValidationError {
  return new ValidationError(message, { file: message });
}

/** Checks the picked file. `hasCurrentFile`: editing a file resource, so no new file = keep the old one. */
function checkUpload(value: unknown, hasCurrentFile: boolean): CleanUpload | null {
  const upload = readUpload(value);
  if (!upload) {
    if (hasCurrentFile) return null;
    throw fileError("Choose a file to upload.");
  }
  const size = upload.bytes.byteLength;
  if (size === 0) throw fileError("That file is empty. Choose another one.");
  if (size > LIMITS.resourceFileMaxBytes) {
    throw fileError(
      `That file is ${formatFileSize(size)}. Files can be up to ${RESOURCE_FILE_MAX_MB} MB, so for bigger files (like CAD) share a link instead.`,
    );
  }
  const filename = cleanFilename(upload.name);
  const ext = fileExtension(filename);
  if (BLOCKED_EXTENSIONS.has(ext)) {
    throw fileError(`.${ext} files can't be uploaded because they can run programs on a computer. Share a link instead.`);
  }
  return { filename, contentType: cleanContentType(upload.type), bytes: new Uint8Array(upload.bytes) };
}

/** Files one member can have waiting for approval (or turned down) at once, so one account can't fill the storage. */
export const MEMBER_UNAPPROVED_FILE_BYTES = 20 * 1024 * 1024;

type Tx = Prisma.TransactionClient;

/**
 * Every uploaded file together must stay under LIMITS.resourceStorageMaxBytes (they live in Postgres),
 * and a member's files that aren't approved yet under MEMBER_UNAPPROVED_FILE_BYTES. Takes a transaction
 * lock first, so two uploads at the same moment can't both squeeze into the last bit of room.
 */
async function assertStorageRoom(
  tx: Tx,
  ctx: ServiceContext,
  change: { adding: number; freeing: number; resourceId?: string },
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('hk-resource-storage'))`;
  const { _sum } = await tx.resourceFile.aggregate({ _sum: { size: true } });
  if ((_sum.size ?? 0) - change.freeing + change.adding > LIMITS.resourceStorageMaxBytes) {
    throw fileError("The team's file storage is full. Share a link instead, or ask an admin to remove old files.");
  }
  if (canManageResources(ctx.actor)) return;
  const mine = await tx.resourceFile.aggregate({
    _sum: { size: true },
    where: {
      resource: {
        createdById: ctx.actor.id,
        status: { not: "APPROVED" },
        ...(change.resourceId ? { id: { not: change.resourceId } } : {}),
      },
    },
  });
  if ((mine._sum.size ?? 0) + change.adding > MEMBER_UNAPPROVED_FILE_BYTES) {
    throw fileError(
      `You have ${formatFileSize(mine._sum.size ?? 0)} of files waiting for approval. Wait until a leader reviews them, or remove some.`,
    );
  }
}

function fileData(upload: CleanUpload) {
  return { filename: upload.filename, contentType: upload.contentType, size: upload.bytes.byteLength, data: upload.bytes };
}

// ---------------------------------------------------------------------------------------------
// Form input
// ---------------------------------------------------------------------------------------------

export const RESOURCE_KINDS = ["link", "file"] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];

const kindInput = z.object({
  kind: z.preprocess(
    (v) => (v === undefined || v === null || v === "" ? "link" : v),
    z.enum(RESOURCE_KINDS, { error: "Choose a link or a file." }),
  ),
});

const commonFields = {
  title: text("Title", LIMITS.resourceTitleMax),
  description: optionalText("Description", LIMITS.resourceDescriptionMax),
  type: z.enum(RESOURCE_TYPES as [string, ...string[]], { error: "Pick a type." }),
  group: optionalText("Section", LIMITS.resourceGroupMax),
  pinned: checkbox,
  links: z.string().max(10_000, "Too many quick links.").optional().default(""),
};
const linkInput = z.object({ ...commonFields, url: urlField });
const fileInput = z.object(commonFields);

interface ParsedResource {
  kind: ResourceKind;
  pinned: boolean;
  data: {
    title: string;
    url: string;
    description: string;
    type: (typeof RESOURCE_TYPES)[number];
    group: string;
    links: object;
  };
  /** The new file (file resources), or null to keep the current one. */
  upload: CleanUpload | null;
}

/** Validates the whole form at once, so every bad field (including the file) is reported together. */
function parseResourceInput(rec: Record<string, unknown>, opts: { hasCurrentFile: boolean }): ParsedResource {
  const errors: Record<string, string> = {};
  const failures: ValidationError[] = [];
  const collect = <T>(fn: () => T): T | undefined => {
    try {
      return fn();
    } catch (e) {
      if (!(e instanceof ValidationError)) throw e;
      failures.push(e);
      const entries = Object.entries(e.fieldErrors);
      if (entries.length === 0) errors._form ??= e.userMessage;
      for (const [key, message] of entries) errors[key] ??= message;
      return undefined;
    }
  };

  const kind = collect(() => parseInput(kindInput, rec).kind) ?? "link";
  const fields = collect(() => parseInput(kind === "link" ? linkInput : fileInput, rec));
  const links = fields ? collect(() => parseLinksText(fields.links)) : undefined;
  const upload = kind === "file" ? (collect(() => checkUpload(rec.file, opts.hasCurrentFile)) ?? null) : null;

  if (failures.length > 0 || !fields || !links) {
    // One failing check keeps its own summary ("Please fix the quick links."); several get a generic one.
    const message = failures.length === 1 ? failures[0].userMessage : "Please fix the highlighted fields.";
    throw new ValidationError(message, errors);
  }
  return {
    kind,
    pinned: fields.pinned,
    data: {
      title: fields.title,
      url: "url" in fields ? (fields.url as string) : "",
      description: fields.description ?? "",
      type: fields.type as (typeof RESOURCE_TYPES)[number],
      group: fields.group ?? "",
      links: links as unknown as object,
    },
    upload,
  };
}

function asRecord(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

function assertActive(ctx: ServiceContext) {
  if (ctx.actor.status !== "ACTIVE") throw new ForbiddenError("Your account isn't active, so you can't change resources.");
}

// ---------------------------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------------------------

/**
 * Add a link or an uploaded file. People with admin access publish it right away (and may pin it);
 * everyone else's waits for approval (PENDING, never pinned) and the reviewers get an email.
 */
export async function createResource(ctx: ServiceContext, raw: unknown): Promise<{ id: string }> {
  assertActive(ctx);
  const input = parseResourceInput(asRecord(raw), { hasCurrentFile: false });
  const manager = canManageResources(ctx.actor);
  await enforceRateLimit(ctx.db, `resource:${ctx.actor.id}`, manager ? RATE_LIMITS.manager : RATE_LIMITS.member, HOUR, ctx.now);

  const upload = input.upload;
  const created = await ctx.db.$transaction(async (tx) => {
    if (upload) await assertStorageRoom(tx, ctx, { adding: upload.bytes.byteLength, freeing: 0 });
    return tx.resource.create({
      data: {
        ...input.data,
        pinned: manager && input.pinned,
        status: manager ? "APPROVED" : "PENDING",
        createdById: ctx.actor.id,
        file: upload ? { create: fileData(upload) } : undefined,
      },
      select: { id: true },
    });
  });
  if (!manager) ctx.notifier.notify({ type: "resource.submitted", resourceId: created.id });
  return created;
}

const updateIdInput = z.object({ resourceId: idSchema });

/**
 * Edit a resource. People with admin access: any resource, status unchanged. Members: their own until
 * it's approved; saving sends it back for approval (clears the old review) and, if it had been turned
 * down, emails the reviewers again.
 * A file resource saved without a new file keeps its file; switching between link and file works both ways.
 */
export async function updateResource(ctx: ServiceContext, raw: unknown): Promise<{ id: string }> {
  assertActive(ctx);
  const rec = asRecord(raw);
  const { resourceId } = parseInput(updateIdInput, rec);
  const existing = await ctx.db.resource.findUnique({
    where: { id: resourceId },
    select: { status: true, createdById: true, pinned: true, file: { select: { size: true } } },
  });
  if (!existing || !canViewResource(ctx.actor, existing)) throw new NotFoundError(RESOURCE_NOT_FOUND);
  if (!canEditResource(ctx.actor, existing)) {
    throw new ForbiddenError("You can only change resources you shared, and only until they're approved.");
  }
  const input = parseResourceInput(rec, { hasCurrentFile: !!existing.file });
  const manager = canManageResources(ctx.actor);
  // Members' saves send it for approval again, so they share the "add" allowance (each can email reviewers).
  if (!manager) await enforceRateLimit(ctx.db, `resource:${ctx.actor.id}`, RATE_LIMITS.member, HOUR, ctx.now);

  // Members: only while it's still theirs and not approved (a reviewer may have just approved it).
  const where: Prisma.ResourceWhereInput = manager
    ? { id: resourceId }
    : { id: resourceId, createdById: ctx.actor.id, status: { in: ["PENDING", "REJECTED"] } };
  const data: Prisma.ResourceUncheckedUpdateManyInput = {
    ...input.data,
    pinned: manager ? input.pinned : existing.pinned,
    ...(manager ? {} : { status: "PENDING" as const, reviewedById: null, reviewedAt: null, reviewNote: null }),
  };

  const upload = input.upload;
  await ctx.db.$transaction(async (tx) => {
    if (upload) {
      await assertStorageRoom(tx, ctx, { adding: upload.bytes.byteLength, freeing: existing.file?.size ?? 0, resourceId });
    }
    const { count } = await tx.resource.updateMany({ where, data });
    if (count === 0) {
      throw manager
        ? new NotFoundError(RESOURCE_NOT_FOUND)
        : new ConflictError("This resource was just reviewed or removed. Reload the page to see what changed.");
    }
    if (input.kind === "link") {
      await tx.resourceFile.deleteMany({ where: { resourceId } });
    } else if (input.upload) {
      const file = fileData(input.upload);
      await tx.resourceFile.upsert({ where: { resourceId }, create: { resourceId, ...file }, update: { ...file, createdAt: ctx.now } });
    }
  });
  // Re-sent after being turned down: tell the reviewers. Edits while it's still waiting don't email
  // again (the reviewers already know; the review buttons check they approve the latest version).
  if (!manager && existing.status === "REJECTED") ctx.notifier.notify({ type: "resource.submitted", resourceId });
  return { id: resourceId };
}

/** Remove a resource (and its file). People with admin access: any; members: what they shared. */
export async function deleteResource(ctx: ServiceContext, raw: unknown): Promise<void> {
  assertActive(ctx);
  const { resourceId } = parseInput(updateIdInput, asRecord(raw));
  const existing = await ctx.db.resource.findUnique({
    where: { id: resourceId },
    select: { status: true, createdById: true },
  });
  // Someone else's pending resource is invisible to members: same answer as a missing one.
  if (!existing || !canViewResource(ctx.actor, existing)) throw new NotFoundError(RESOURCE_NOT_FOUND);
  if (!canDeleteResource(ctx.actor, existing)) {
    throw new ForbiddenError("Only leaders, mentors, teachers, and owners can remove resources other people shared.");
  }
  const { count } = await ctx.db.resource.deleteMany({ where: { id: resourceId } });
  if (count === 0) throw new NotFoundError(RESOURCE_NOT_FOUND);
}

const reviewInput = z.object({
  resourceId: idSchema,
  decision: z.enum(["approve", "reject"], { error: "Choose approve or send back." }),
  note: optionalText("Note", LIMITS.noteMax),
  /** The resource's updatedAt the reviewer saw (ISO). When given, a newer edit makes the review fail. */
  version: z.preprocess((v) => (v === "" ? undefined : v), z.iso.datetime().optional()),
});

export const RESOURCE_CHANGED = "The member changed this since you opened it. Take another look, then decide again.";

/** What `reviewResource` just did, for the reviewer's confirmation (see reviewDoneMessage). */
export interface ReviewedResource {
  id: string;
  decision: "approve" | "reject";
  title: string;
  /** Who shared it (null when their account is gone). */
  sharedByName: string | null;
  /** The reviewer left a note (the member sees it). */
  withNote: boolean;
}

/**
 * Approve (the whole team sees it) or send back (the member sees why and can fix it) a member's
 * resource that is waiting (or was sent back before). Already approved, or changed since the
 * reviewer opened it (`version`): ConflictError.
 */
export async function reviewResource(ctx: ServiceContext, raw: unknown): Promise<ReviewedResource> {
  const input = parseInput(reviewInput, asRecord(raw));
  if (ctx.actor.status !== "ACTIVE" || !canReviewResources(ctx.actor)) {
    throw new ForbiddenError("Only leaders, mentors, teachers, and owners can approve resources.");
  }
  const { count } = await ctx.db.resource.updateMany({
    where: {
      id: input.resourceId,
      // Only what the reviewer actually looked at (a member may have swapped the link or file since).
      // With that version a sent-back resource can be decided again (a reviewer changing their mind);
      // without it only waiting ones, so two reviewers deciding at once can't both "win".
      ...(input.version
        ? { status: { in: ["PENDING", "REJECTED"] }, updatedAt: new Date(input.version) }
        : { status: "PENDING" }),
    },
    data: {
      status: input.decision === "approve" ? "APPROVED" : "REJECTED",
      reviewedById: ctx.actor.id,
      reviewedAt: ctx.now,
      reviewNote: input.note ?? null,
    },
  });
  if (count === 0) {
    const now = await ctx.db.resource.findUnique({ where: { id: input.resourceId }, select: { status: true } });
    if (!now) throw new NotFoundError(RESOURCE_NOT_FOUND);
    throw new ConflictError(now.status === "APPROVED" ? RESOURCE_ALREADY_REVIEWED : RESOURCE_CHANGED);
  }
  const reviewed = await ctx.db.resource.findUnique({
    where: { id: input.resourceId },
    select: { title: true, createdBy: { select: { name: true } } },
  });
  ctx.notifier.notify({ type: "resource.reviewed", resourceId: input.resourceId });
  return {
    id: input.resourceId,
    decision: input.decision,
    title: reviewed?.title ?? "",
    sharedByName: reviewed?.createdBy?.name ?? null,
    withNote: !!input.note,
  };
}

/**
 * The reviewer's confirmation: "Approved “Gear calculator” — the team can see it now." /
 * "Sent “Gear calculator” back to Maya. They'll see your note."
 */
export function reviewDoneMessage(r: ReviewedResource): string {
  const title = r.title ? `“${r.title}”` : "it";
  if (r.decision === "approve") return `Approved ${title} — the team can see it now.`;
  const first = r.sharedByName?.trim().split(/\s+/)[0];
  const to = first ? ` back to ${first}` : " back";
  return `Sent ${title}${to}.${r.withNote ? " They'll see your note." : ""}`;
}
