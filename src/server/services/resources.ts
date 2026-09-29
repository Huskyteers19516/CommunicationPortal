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
import { assertFileStorageRoom, checkFileStorageRoom, perPersonFileCap, posterCleanupSentence, storageFullSentence } from "../files/storage";
import { usesObjectStorage, withStoredFiles } from "../files/stored";
import {
  BLOCKED_EXTENSIONS,
  checkUploadedFile,
  type CleanUpload,
  cleanFilename,
  fileError,
  readUpload,
  type UploadedFile,
  type UploadMessages,
} from "../files/upload";
import {
  canDeleteResource,
  canEditResource,
  canManageResources,
  canReviewResources,
  canViewResource,
} from "../permissions";
import { enforceRateLimit } from "../rate-limit";

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

// Shared with sponsor files (src/server/files/upload.ts); re-exported so existing imports keep working.
export { BLOCKED_EXTENSIONS, cleanFilename, type UploadedFile };

const RESOURCE_UPLOAD_MESSAGES: UploadMessages = {
  tooBig: (size) =>
    `That file is ${formatFileSize(size)}. Files can be up to ${RESOURCE_FILE_MAX_MB} MB, so for bigger files (like CAD) share a link instead.`,
  blocked: (ext) => `.${ext} files can't be uploaded because they can run programs on a computer. Share a link instead.`,
};

/** Checks the picked file. `hasCurrentFile`: editing a file resource, so no new file = keep the old one. */
function checkUpload(value: unknown, hasCurrentFile: boolean): CleanUpload | null {
  const upload = readUpload(value);
  if (!upload) {
    if (hasCurrentFile) return null;
    throw fileError("Choose a file to upload.");
  }
  return checkUploadedFile(upload, RESOURCE_UPLOAD_MESSAGES);
}

/**
 * Files one member can have waiting for approval (or turned down) at once, so one account can't fill the storage
 * (10× with Cloudflare R2: perPersonFileCap).
 */
export const MEMBER_UNAPPROVED_FILE_BYTES = 20 * 1024 * 1024;

type Tx = Prisma.TransactionClient;

/**
 * Every uploaded file together must stay under the team's storage cap (fileStorageCapBytes), and a member's files
 * that aren't approved yet under MEMBER_UNAPPROVED_FILE_BYTES (perPersonFileCap). Takes the storage lock first
 * (assertFileStorageRoom), so two uploads at the same moment can't both squeeze into the last bit of room.
 * `locked: false`: the same checks without the lock, as the quick look before uploading to Cloudflare R2
 * (withStoredFiles' precheck); saving checks again under the lock.
 */
async function assertStorageRoom(
  tx: Tx,
  ctx: ServiceContext,
  change: { adding: number; freeing: number; resourceId?: string },
  locked = true,
): Promise<void> {
  await (locked ? assertFileStorageRoom : checkFileStorageRoom)(
    tx,
    change,
    (usage) =>
      `${storageFullSentence(usage)} Share a link instead, or ask an admin to remove old Resources files. The Business leader, captain, mentors, and teachers can clear out sponsor files.${posterCleanupSentence(usage)}`,
    usesObjectStorage(ctx),
  );
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
  if ((mine._sum.size ?? 0) + change.adding > perPersonFileCap(MEMBER_UNAPPROVED_FILE_BYTES, usesObjectStorage(ctx))) {
    throw fileError(
      `You have ${formatFileSize(mine._sum.size ?? 0)} of files waiting for approval. Wait until a leader reviews them, or remove some.`,
    );
  }
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
  const adding = upload?.bytes.byteLength ?? 0;
  const created = await withStoredFiles(
    ctx,
    "resources",
    upload ? [upload] : [],
    ([file]) =>
      ctx.db.$transaction(async (tx) => {
        if (upload) await assertStorageRoom(tx, ctx, { adding, freeing: 0 });
        return tx.resource.create({
          data: {
            ...input.data,
            pinned: manager && input.pinned,
            status: manager ? "APPROVED" : "PENDING",
            createdById: ctx.actor.id,
            file: file ? { create: file } : undefined,
          },
          select: { id: true },
        });
      }),
    { precheck: () => assertStorageRoom(ctx.db, ctx, { adding, freeing: 0 }, false) },
  );
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
  const change = { adding: upload?.bytes.byteLength ?? 0, freeing: existing.file?.size ?? 0, resourceId };
  await withStoredFiles(
    ctx,
    "resources",
    upload ? [upload] : [],
    ([file]) =>
      ctx.db.$transaction(async (tx) => {
        if (upload) await assertStorageRoom(tx, ctx, change);
        const { count } = await tx.resource.updateMany({ where, data });
        if (count === 0) {
          throw manager
            ? new NotFoundError(RESOURCE_NOT_FOUND)
            : new ConflictError("This resource was just reviewed or removed. Reload the page to see what changed.");
        }
        if (input.kind === "link") {
          await tx.resourceFile.deleteMany({ where: { resourceId } });
        } else if (file) {
          // Replacing sets both data and storageKey, so a file moving between Postgres and R2 never keeps the old one
          // (an old R2 object is queued for deletion by the database when its key changes).
          await tx.resourceFile.upsert({ where: { resourceId }, create: { resourceId, ...file }, update: { ...file, createdAt: ctx.now } });
        }
      }),
    { precheck: () => assertStorageRoom(ctx.db, ctx, change, false) },
  );
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
