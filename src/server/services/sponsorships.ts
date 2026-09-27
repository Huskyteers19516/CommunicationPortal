// Sponsorships: the Business team's tracker of every sponsor, donor, and grant they ask
// (replaces their Google Sheet). The Business subteam and staff (leaders, captain, mentors, teachers,
// owners) can see and change everything; removing one is for whoever added it, the Business leader,
// and all-scope staff. Plus a small shared note ("Info for applications") and a spreadsheet import.
import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import type { SponsorshipStage } from "@/generated/prisma/enums";
import { LIMITS, STAFF_ROLES } from "@/lib/constants";
import { type DateOnly, dateOnlyToDb, dbToDateOnly, todayInTimezone } from "@/lib/dates";
import { type SponsorshipFields, sponsorshipFields, stageField } from "@/lib/sponsorship-fields";
import {
  type ExistingSponsor,
  matchSponsorshipImport,
  type PlannedSponsorship,
  prepareSponsorshipImport,
  type SponsorshipImportPlan,
  SPONSORSHIP_IMPORT_MAX_PASTED_ROWS,
  SPONSORSHIP_IMPORT_MAX_ROWS,
  SPONSORSHIP_IMPORT_TEXT_MAX,
  sheetValue,
} from "@/lib/sponsorship-import";
import { type OwnerOption } from "@/lib/sponsorships";
import { checkbox, idSchema, optionalText } from "@/lib/validation";
import { parseInput } from "../action";
import type { ServiceContext } from "../context";
import type { Db } from "../db";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../errors";
import { canDeleteSponsorship, canUseSponsorships } from "../permissions";
import { enforceRateLimit } from "../rate-limit";

export const SPONSORSHIP_NOT_FOUND = "That sponsor no longer exists.";
export const SPONSORSHIP_CHANGED = "Someone changed this sponsor since you opened it — reload to see the latest.";
/** TeamNote key for the "Info for applications" card. */
export const SPONSORSHIP_INFO_KEY = "sponsorship-info";

const HOUR = 60 * 60 * 1000;
/** Saves per person per hour (the stage menu saves on every change, like the spreadsheet did). */
export const SPONSORSHIP_WRITES_PER_HOUR = 120;
/** Imports per person per hour (each can add up to 200 sponsors). Only imports that pass the checks count. */
export const SPONSORSHIP_IMPORTS_PER_HOUR = 10;

type Tx = Prisma.TransactionClient;

function asRecord(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

/** ACTIVE and able to use Sponsorships (the Business team and staff), else ForbiddenError. */
export function assertCanUseSponsorships(ctx: ServiceContext) {
  if (ctx.actor.status !== "ACTIVE" || !canUseSponsorships(ctx.actor)) {
    throw new ForbiddenError("Sponsorships are for the Business team and leaders.");
  }
}

/** The hourly allowance for changes to Sponsorships (shared by sponsors, the info note, and removing files). */
export async function limitSponsorshipWrites(ctx: ServiceContext) {
  await enforceRateLimit(ctx.db, `sponsorship:${ctx.actor.id}`, SPONSORSHIP_WRITES_PER_HOUR, HOUR, ctx.now);
}

function today(ctx: ServiceContext): DateOnly {
  return todayInTimezone(ctx.config.teamTimezone, ctx.now);
}

// ---------------------------------------------------------------------------------------------
// Fields (the schema is in src/lib/sponsorship-fields.ts, shared with the import preview)
// ---------------------------------------------------------------------------------------------

/** Validated fields → the columns they fill ("" / null for anything left empty). */
function columns(f: SponsorshipFields) {
  return {
    name: f.name,
    website: f.website,
    contactName: f.contactName ?? "",
    contactEmail: f.contactEmail ?? "",
    asking: f.asking ?? "",
    amountReceived: f.amountReceived,
    stage: f.stage,
    ownerId: f.ownerId ?? null,
    submittedOn: f.submittedOn ? dateOnlyToDb(f.submittedOn) : null,
    acceptedOn: f.acceptedOn ? dateOnlyToDb(f.acceptedOn) : null,
    closesOn: f.closesOn ? dateOnlyToDb(f.closesOn) : null,
    notes: f.notes ?? "",
  };
}

// ---------------------------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------------------------

/** Mirror of canUseSponsorships for ACTIVE users: the Business subteam plus staff. */
export const sponsorshipPeopleWhere: Prisma.UserWhereInput = {
  status: "ACTIVE",
  OR: [{ subteam: "BUSINESS" }, { role: { in: [...STAFF_ROLES] } }, { isAdmin: true }],
};

/** Everyone who can be "the person" on a sponsorship, by name. */
export async function loadOwnerOptions(db: Db | Tx): Promise<OwnerOption[]> {
  const people = await db.user.findMany({
    where: sponsorshipPeopleWhere,
    select: { id: true, name: true, role: true, subteam: true, isAdmin: true },
    orderBy: { name: "asc" },
    take: 500,
  });
  return people.filter((p) => canUseSponsorships(p)).map((p) => ({ id: p.id, name: p.name }));
}

const OWNER_MESSAGE = "Pick someone on the Business team or a leader.";

/** The person must be ACTIVE and able to use Sponsorships (`keep`: their current person may stay even if not). */
async function assertOwner(ctx: ServiceContext, ownerId: string | undefined, keep: string | null = null) {
  if (!ownerId || ownerId === keep) return;
  const owner = await ctx.db.user.findUnique({
    where: { id: ownerId },
    select: { id: true, role: true, subteam: true, isAdmin: true, status: true },
  });
  if (!owner || owner.status !== "ACTIVE" || !canUseSponsorships(owner)) {
    throw new ValidationError(OWNER_MESSAGE, { ownerId: OWNER_MESSAGE });
  }
}

/**
 * Moving into Submitted / Accepted fills that date with today when it's empty (the form's own value wins,
 * and a date someone entered is never replaced).
 */
function fillStageDate(data: ReturnType<typeof columns>, previous: SponsorshipStage | null, day: DateOnly) {
  if (data.stage === previous) return;
  if (data.stage === "SUBMITTED" && !data.submittedOn) data.submittedOn = dateOnlyToDb(day);
  if (data.stage === "ACCEPTED" && !data.acceptedOn) data.acceptedOn = dateOnlyToDb(day);
}

// ---------------------------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------------------------

export interface CreatedSponsorship {
  id: string;
  /** How many other sponsors already had this name (any case). Both are kept; the page mentions it. */
  sameName: number;
}

/** Add a sponsor. Picking Submitted or Accepted without a date fills in today. A name that's already here is allowed. */
export async function createSponsorship(ctx: ServiceContext, raw: unknown): Promise<CreatedSponsorship> {
  assertCanUseSponsorships(ctx);
  const fields = parseInput(sponsorshipFields, asRecord(raw));
  await assertOwner(ctx, fields.ownerId);
  await limitSponsorshipWrites(ctx);
  const data = columns(fields);
  fillStageDate(data, null, today(ctx));
  const sameName = await ctx.db.sponsorship.count({ where: { name: { equals: data.name, mode: "insensitive" } } });
  const { id } = await ctx.db.sponsorship.create({ data: { ...data, createdById: ctx.actor.id }, select: { id: true } });
  return { id, sameName };
}

const idInput = z.object({ sponsorshipId: idSchema });

/** The edit form's `version`: the sponsor's updatedAt when the form was opened (ISO), or missing. */
function parseVersion(value: unknown): Date | null {
  if (value === undefined || value === null || value === "") return null;
  const date = typeof value === "string" && value.length <= 40 ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) throw new ConflictError(SPONSORSHIP_CHANGED);
  return date;
}

/**
 * Save the edit form. Moving the stage into Submitted / Accepted fills that date when it's left empty.
 * The form sends `version` (the updatedAt it loaded): if the sponsor changed since (e.g. someone moved
 * its stage from the list), nothing is saved and it's a ConflictError, so a stale form can't undo that.
 */
export async function updateSponsorship(ctx: ServiceContext, raw: unknown): Promise<{ id: string }> {
  assertCanUseSponsorships(ctx);
  const rec = asRecord(raw);
  const { sponsorshipId } = parseInput(idInput, rec);
  const fields = parseInput(sponsorshipFields, rec);
  const version = parseVersion(rec.version);
  const existing = await ctx.db.sponsorship.findUnique({
    where: { id: sponsorshipId },
    select: { stage: true, ownerId: true, updatedAt: true },
  });
  if (!existing) throw new NotFoundError(SPONSORSHIP_NOT_FOUND);
  if (version && existing.updatedAt.getTime() !== version.getTime()) throw new ConflictError(SPONSORSHIP_CHANGED);
  await assertOwner(ctx, fields.ownerId, existing.ownerId);
  await limitSponsorshipWrites(ctx);
  const data = columns(fields);
  fillStageDate(data, existing.stage, today(ctx));
  // Conditional on the version the form loaded (or, without one, on the stage the date fill was based on).
  const { count } = await ctx.db.sponsorship.updateMany({
    where: { id: sponsorshipId, ...(version ? { updatedAt: version } : { stage: existing.stage }) },
    data,
  });
  if (count === 0) {
    const still = await ctx.db.sponsorship.count({ where: { id: sponsorshipId } });
    throw still ? new ConflictError(SPONSORSHIP_CHANGED) : new NotFoundError(SPONSORSHIP_NOT_FOUND);
  }
  return { id: sponsorshipId };
}

const stageInput = z.object({ sponsorshipId: idSchema, stage: stageField });

export interface StageChange {
  id: string;
  stage: SponsorshipStage;
  /** The date this change filled in (it was empty), if any. */
  filled: { field: "submittedOn" | "acceptedOn"; date: DateOnly } | null;
}

/**
 * The quick stage menu on the list. Moving to Submitted fills `submittedOn` with today (team timezone)
 * when it's empty; Accepted fills `acceptedOn`. Dates people entered are never overwritten (the fill is
 * a conditional write on the date still being empty).
 */
export async function setSponsorshipStage(ctx: ServiceContext, raw: unknown): Promise<StageChange> {
  assertCanUseSponsorships(ctx);
  const { sponsorshipId, stage } = parseInput(stageInput, asRecord(raw));
  await limitSponsorshipWrites(ctx);
  const day = today(ctx);
  const field: "submittedOn" | "acceptedOn" | null =
    stage === "SUBMITTED" ? "submittedOn" : stage === "ACCEPTED" ? "acceptedOn" : null;
  const filled = await ctx.db.$transaction(async (tx): Promise<StageChange["filled"]> => {
    const { count } = await tx.sponsorship.updateMany({ where: { id: sponsorshipId }, data: { stage } });
    if (count === 0) throw new NotFoundError(SPONSORSHIP_NOT_FOUND);
    if (!field) return null;
    const date = dateOnlyToDb(day);
    const fill =
      field === "submittedOn"
        ? await tx.sponsorship.updateMany({ where: { id: sponsorshipId, submittedOn: null }, data: { submittedOn: date } })
        : await tx.sponsorship.updateMany({ where: { id: sponsorshipId, acceptedOn: null }, data: { acceptedOn: date } });
    return fill.count > 0 ? { field, date: day } : null;
  });
  return { id: sponsorshipId, stage, filled };
}

/** Remove a sponsor: whoever added it, the Business leader, and the captain, mentors, teachers, and owners. */
export async function deleteSponsorship(ctx: ServiceContext, raw: unknown): Promise<{ name: string }> {
  assertCanUseSponsorships(ctx);
  const { sponsorshipId } = parseInput(idInput, asRecord(raw));
  const existing = await ctx.db.sponsorship.findUnique({ where: { id: sponsorshipId }, select: { createdById: true, name: true } });
  if (!existing) throw new NotFoundError(SPONSORSHIP_NOT_FOUND);
  if (!canDeleteSponsorship(ctx.actor, existing)) {
    throw new ForbiddenError("Only the person who added it, the Business leader, or the captain, mentors, and teachers can remove a sponsor.");
  }
  await limitSponsorshipWrites(ctx);
  const { count } = await ctx.db.sponsorship.deleteMany({ where: { id: sponsorshipId } });
  if (count === 0) throw new NotFoundError(SPONSORSHIP_NOT_FOUND);
  return { name: existing.name };
}

const infoInput = z.object({ body: optionalText("Info", LIMITS.teamNoteMax) });

/** The "Info for applications" note (team address, contact person, links). Empty clears it. */
export async function updateSponsorshipInfo(ctx: ServiceContext, raw: unknown): Promise<void> {
  assertCanUseSponsorships(ctx);
  const { body } = parseInput(infoInput, asRecord(raw));
  await limitSponsorshipWrites(ctx);
  const data = { body: body ?? "", updatedById: ctx.actor.id };
  await ctx.db.teamNote.upsert({ where: { key: SPONSORSHIP_INFO_KEY }, create: { key: SPONSORSHIP_INFO_KEY, ...data }, update: data });
}

// ---------------------------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------------------------

const importInput = z.object({
  text: z
    .string({ error: "Paste some rows from your spreadsheet first." })
    .max(
      SPONSORSHIP_IMPORT_TEXT_MAX,
      `That's too much to paste at once. Paste up to ${SPONSORSHIP_IMPORT_MAX_PASTED_ROWS.toLocaleString("en-US")} rows at a time.`,
    )
    .refine((v) => v.trim() !== "", "Paste some rows from your spreadsheet first."),
  skipDuplicates: checkbox,
  /** Also copy what's different in the sheet into sponsors that are already here (needs skipDuplicates). */
  updateExisting: checkbox,
});

export interface ImportResult {
  added: number;
  /** Sponsors already here that got newer info from the sheet. */
  updated: number;
  /** Skipped because a sponsor with the same name is already here (or repeats in the paste). */
  skipped: number;
}

function importError(message: string): ValidationError {
  return new ValidationError(message, { text: message });
}

/** Everything the import compares with the sheet, for sponsors already here. */
const existingSelect = {
  id: true,
  name: true,
  stage: true,
  amountReceived: true,
  submittedOn: true,
  acceptedOn: true,
  closesOn: true,
  contactName: true,
  contactEmail: true,
  website: true,
} as const satisfies Prisma.SponsorshipSelect;

/** The sponsors already here, as the import compares them (also the preview's context). */
export async function loadExistingSponsors(db: Db | Tx): Promise<ExistingSponsor[]> {
  const rows = await db.sponsorship.findMany({ select: existingSelect, orderBy: { createdAt: "asc" }, take: 5000 });
  const day = (d: Date | null) => (d ? dbToDateOnly(d) : null);
  return rows.map((r) => ({ ...r, submittedOn: day(r.submittedOn), acceptedOn: day(r.acceptedOn), closesOn: day(r.closesOn) }));
}

/** Throws the message people see when a plan can't be imported (nothing in it, too big, or rows to fix). */
function assertImportable(plan: SponsorshipImportPlan) {
  if (plan.rows.length === 0) {
    throw importError(
      plan.unnamedRows.length > 0
        ? "None of the rows has a sponsor name. Include the company column (and its header row, if your columns are in a different order)."
        : "Paste some rows from your spreadsheet first.",
    );
  }
  if (plan.tooManyRows) {
    throw importError(
      `That's more than ${SPONSORSHIP_IMPORT_MAX_PASTED_ROWS.toLocaleString("en-US")} rows. Paste up to ${SPONSORSHIP_IMPORT_MAX_PASTED_ROWS.toLocaleString("en-US")} at a time.`,
    );
  }
  if (plan.tooMany) {
    const count = plan.toAdd + plan.toUpdate;
    throw importError(`That's ${count} sponsors to ${plan.toUpdate > 0 ? "add or update" : "add"}. Import up to ${SPONSORSHIP_IMPORT_MAX_ROWS} at a time.`);
  }
  const problems = plan.rows.filter((r) => r.errors.length > 0).map((r) => `Row ${r.row}: ${r.errors[0]}`);
  if (problems.length > 0) {
    const shown = problems.slice(0, 3).join(" ");
    const more = problems.length > 3 ? ` (and ${problems.length - 3} more)` : "";
    throw importError(
      problems.length === 1
        ? `Nothing was imported. ${shown} Fix it in the sheet and paste again.`
        : `Nothing was imported: ${problems.length} rows need fixing. ${shown}${more}`,
    );
  }
}

/** The columns an update writes: only what's different in the sheet, from cells that aren't empty. */
function updateData(r: PlannedSponsorship): Prisma.SponsorshipUpdateManyMutationInput {
  const data: Prisma.SponsorshipUpdateManyMutationInput = {};
  for (const field of r.changes) {
    const value = sheetValue(r, field);
    if (value === null) continue;
    switch (field) {
      case "stage":
        data.stage = value as SponsorshipStage;
        break;
      case "amountReceived":
        data.amountReceived = value as number;
        break;
      case "submittedOn":
      case "acceptedOn":
      case "closesOn":
        data[field] = dateOnlyToDb(value as DateOnly);
        break;
      case "contactName":
      case "website":
        data[field] = String(value);
        break;
      case "contactEmail":
        data.contactEmail = String(value).toLowerCase();
        break;
    }
  }
  return data;
}

/**
 * Add the sponsors pasted from a spreadsheet (see prepareSponsorshipImport for how rows are read).
 * Everything is re-read and re-checked here; the browser's preview is only a preview. All or nothing:
 * if any row can't be saved, nothing is saved and the message names the rows to fix. Imported rows
 * keep the sheet's dates exactly (no "today" is filled in). With `updateExisting`, sponsors already here
 * get what's different in the sheet (empty cells never erase anything).
 *
 * The paste is read and validated before anything else (and before the hourly import allowance is used,
 * so a paste with mistakes doesn't count); only the comparison with the sponsors already here and the
 * writes happen under the import lock.
 */
export async function importSponsorships(ctx: ServiceContext, raw: unknown): Promise<ImportResult> {
  assertCanUseSponsorships(ctx);
  const input = parseInput(importInput, asRecord(raw));
  const owners = await loadOwnerOptions(ctx.db);
  const prepared = prepareSponsorshipImport(input.text, { today: today(ctx), owners });
  const options = { skipDuplicates: input.skipDuplicates, updateExisting: input.skipDuplicates && input.updateExisting };
  // Checked against what's here now, so a paste that can't be imported fails before it counts.
  assertImportable(matchSponsorshipImport(prepared, { ...options, existing: await loadExistingSponsors(ctx.db) }));
  await enforceRateLimit(ctx.db, `sponsorship-import:${ctx.actor.id}`, SPONSORSHIP_IMPORTS_PER_HOUR, HOUR, ctx.now);
  await limitSponsorshipWrites(ctx);

  return ctx.db.$transaction(
    async (tx) => {
      // One import at a time, so two people importing the same sheet can't both add every row.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('hk-sponsorship-import'))`;
      const plan = matchSponsorshipImport(prepared, { ...options, existing: await loadExistingSponsors(tx) });
      assertImportable(plan);
      const data: Prisma.SponsorshipCreateManyInput[] = [];
      for (const r of plan.rows) {
        if (!r.duplicate && r.fields) data.push({ ...columns(r.fields), createdById: ctx.actor.id });
      }
      if (data.length > 0) await tx.sponsorship.createMany({ data });
      let updated = 0;
      for (const r of plan.rows) {
        if (!r.update || !r.existing) continue;
        const { count } = await tx.sponsorship.updateMany({ where: { id: r.existing.id }, data: updateData(r) });
        updated += count;
      }
      return { added: data.length, updated, skipped: plan.duplicates };
    },
    { timeout: 20_000 },
  );
}
