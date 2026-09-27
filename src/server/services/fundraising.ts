// Fundraising: the team's fundraisers (car washes, bake sales, restaurant nights, donation pages…).
// - Every ACTIVE person sees them, taps "I'll help" (up to an optional number of spots), and can leave
//   again while the fundraiser is still open (not done or cancelled, and its last day hasn't passed).
// - The Business subteam and staff (canManageFundraisers) add, edit, and remove fundraisers, update the
//   amount raised, take people off the helper list, and set the season goal and the day the season started
//   (TeamNotes "fundraising-season-goal" and "fundraising-season-start").
//
// Sign-ups and edits take a row lock on the fundraiser (SELECT … FOR UPDATE) before counting helpers, so two
// people racing for the last spot can't both get it, and an edit can't lower the limit below who's signed up.
// Only ACTIVE helpers count toward the spots (someone whose account was disabled doesn't block a spot).
import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import { FundraiserKind, FundraiserStatus } from "@/generated/prisma/enums";
import { LIMITS } from "@/lib/constants";
import { type DateOnly, dateOnlyToDb, dbToDateOnly, todayInTimezone } from "@/lib/dates";
import { fundraiserClosedReason, fundraiserDateProblem } from "@/lib/fundraising";
import { formatDollars, parseDollars } from "@/lib/money";
import { withHttps } from "@/lib/sponsorships";
import { parseHttpUrl } from "@/lib/urls";
import { dateOnlySchema, idSchema, optionalText, text } from "@/lib/validation";
import { parseInput } from "../action";
import type { ServiceContext } from "../context";
import { ConflictError, ForbiddenError, NotFoundError, RateLimitError, ValidationError } from "../errors";
import { canManageFundraisers } from "../permissions";
import { consumeRateLimit, enforceRateLimit } from "../rate-limit";

type Tx = Prisma.TransactionClient;

/** TeamNote key for the season goal (whole dollars as text; "" = not set). */
export const FUNDRAISING_SEASON_GOAL_KEY = "fundraising-season-goal";
/** TeamNote key for the day the season started ("YYYY-MM-DD"; "" = not set, so totals are all-time). */
export const FUNDRAISING_SEASON_START_KEY = "fundraising-season-start";

const HOUR = 60 * 60 * 1000;
/** Changes by the Business team per person per hour (adds, edits, amounts, removals, the season goal). */
export const FUNDRAISING_WRITES_PER_HOUR = 120;
/** "I'll help" / "Leave" per person per hour. Plenty for real use; stops scripted join/leave loops. */
export const FUNDRAISER_HELP_RATE_LIMIT = { limit: 30, windowMs: HOUR } as const;

export const FUNDRAISER_NOT_FOUND = "That fundraiser no longer exists.";
const ALREADY_HELPING = "You're already helping with this one.";
const NOT_HELPING = "You're not on the helper list for this one.";
const INACTIVE = "Your account isn't active.";
const MANAGERS_ONLY = "Only the Business team and leaders can do that.";
const LEAD_MESSAGE = "Pick someone who's active on the team.";
const LINK_MESSAGE = "Enter a web link, like https://example.com/donate";
const LIMIT_MESSAGE = `Enter a number from 1 to ${LIMITS.fundraiserVolunteersMax}, or leave it empty for no limit.`;
const GOAL_MESSAGE = "Set a goal above $0, or leave it empty.";
const RAISED_MESSAGE = "Enter how much has come in so far, like 250 (0 is fine).";
const DATES_MESSAGE = "The end date can't be before the start date.";

// ---------- input schemas ----------

const blankToUndefined = (v: unknown) => (v === null || (typeof v === "string" && v.trim() === "") ? undefined : v);

/** "$1,000" / "1000" / "1.5k" → whole dollars, or null when empty. */
const dollarsField = z
  .preprocess((v) => (v === undefined || v === null ? "" : typeof v === "number" ? String(v) : v), z.string({ error: "Enter an amount in dollars." }))
  .transform((v, ctx): number | null => {
    const result = parseDollars(v);
    if (!result.ok) {
      ctx.addIssue({ code: "custom", message: result.message });
      return z.NEVER;
    }
    return result.value;
  });

/** Empty = no goal; otherwise more than $0. */
const goalField = dollarsField.refine((v) => v === null || v > 0, GOAL_MESSAGE);

/** "" / missing = no limit; otherwise a whole number 1..LIMITS.fundraiserVolunteersMax. */
const volunteerLimitField = z.preprocess(
  (v) => {
    if (v === undefined || v === null) return null;
    if (typeof v === "number") return v;
    if (typeof v !== "string") return Number.NaN;
    const s = v.trim();
    if (s === "") return null;
    return /^\d{1,6}$/.test(s) ? Number(s) : Number.NaN;
  },
  z
    .number({ error: LIMIT_MESSAGE })
    .int(LIMIT_MESSAGE)
    .min(1, LIMIT_MESSAGE)
    .max(LIMITS.fundraiserVolunteersMax, LIMIT_MESSAGE)
    .nullable(),
);

/** "" = no link; otherwise an http(s) address (https:// is added to a bare "gofundme.com/…"). */
const linkField = z.preprocess(
  (v) => (v === undefined || v === null ? "" : v),
  z
    .string({ error: LINK_MESSAGE })
    .trim()
    .transform((v, ctx) => {
      if (v === "") return "";
      const url = parseHttpUrl(withHttps(v));
      if (!url) {
        ctx.addIssue({ code: "custom", message: LINK_MESSAGE });
        return z.NEVER;
      }
      return url;
    }),
);

const optionalDate = z.preprocess(blankToUndefined, dateOnlySchema.optional());

const fundraiserFields = z.object({
  name: text("Name", LIMITS.fundraiserNameMax),
  kind: z.preprocess((v) => blankToUndefined(v) ?? "EVENT", z.enum(FundraiserKind, { error: "Pick what kind of fundraiser it is." })),
  status: z.preprocess((v) => blankToUndefined(v) ?? "PLANNING", z.enum(FundraiserStatus, { error: "Pick a status." })),
  description: optionalText("Details", LIMITS.fundraiserDescriptionMax),
  location: optionalText("Location", LIMITS.fundraiserLocationMax),
  link: linkField,
  startsOn: optionalDate,
  endsOn: optionalDate,
  goalAmount: goalField,
  raisedAmount: dollarsField,
  leadId: z.preprocess(blankToUndefined, idSchema.optional()),
  volunteerLimit: volunteerLimitField,
});

/** Just the dates, checked on their own so their problems show up together with every other field's. */
const dateFields = z.object({ startsOn: optionalDate, endsOn: optionalDate });

/** The edit form's amount raised when it was opened (whole dollars), or missing. */
const loadedRaisedField = z.preprocess(
  (v) => (typeof v === "string" && /^\d{1,9}$/.test(v.trim()) ? Number(v.trim()) : undefined),
  z.number().int().min(0).optional(),
);

type FundraiserFields = z.infer<typeof fundraiserFields>;

const idInput = z.object({ fundraiserId: idSchema });
const raisedInput = z.object({
  fundraiserId: idSchema,
  raisedAmount: dollarsField.refine((v) => v !== null, RAISED_MESSAGE),
});
const removeVolunteerInput = z.object({ fundraiserId: idSchema, userId: idSchema });
const seasonGoalInput = z.object({ goal: goalField, seasonStart: optionalDate });

// ---------- helpers ----------

function asRecord(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

function requireActive(ctx: ServiceContext) {
  if (ctx.actor.status !== "ACTIVE") throw new ForbiddenError(INACTIVE);
}

/** ACTIVE and in the Business subteam or staff, else ForbiddenError. */
function requireManager(ctx: ServiceContext) {
  requireActive(ctx);
  if (!canManageFundraisers(ctx.actor)) throw new ForbiddenError(MANAGERS_ONLY);
}

async function limitWrites(ctx: ServiceContext) {
  await enforceRateLimit(ctx.db, `fundraising:${ctx.actor.id}`, FUNDRAISING_WRITES_PER_HOUR, HOUR, ctx.now);
}

async function limitHelp(ctx: ServiceContext) {
  const { limit, windowMs } = FUNDRAISER_HELP_RATE_LIMIT;
  if (!(await consumeRateLimit(ctx.db, `fundraiser-help:${ctx.actor.id}`, limit, windowMs, ctx.now))) {
    throw new RateLimitError("You've signed up and left a lot in the last hour. Please wait a bit and try again.");
  }
}

function today(ctx: ServiceContext): DateOnly {
  return todayInTimezone(ctx.config.teamTimezone, ctx.now);
}

/** Lock the fundraiser row until the transaction ends; NotFoundError if it's gone. */
async function lockFundraiser(tx: Tx, fundraiserId: string) {
  const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Fundraiser" WHERE id = ${fundraiserId} FOR UPDATE`;
  if (locked.length === 0) throw new NotFoundError(FUNDRAISER_NOT_FOUND);
}

/** Helpers who count toward the spots: people whose account is still active. */
const activeVolunteers = { volunteers: { where: { user: { status: "ACTIVE" } } } } satisfies Prisma.FundraiserCountOutputTypeSelect;

/** A date's range problem, or null. `keep`: an edit may leave a date as it was, however far back it is. */
function dateProblem(ctx: ServiceContext, date: DateOnly | undefined, keep: DateOnly | null = null): string | null {
  if (!date || date === keep) return null;
  return fundraiserDateProblem(date, today(ctx));
}

/**
 * Check the whole form at once (fields, the dates' range and order), so every problem shows in one go.
 * `keep`: the dates the fundraiser has now (an edit may leave them as they are).
 */
function parseFundraiserForm(
  ctx: ServiceContext,
  rec: Record<string, unknown>,
  keep: { startsOn: DateOnly | null; endsOn: DateOnly | null } = { startsOn: null, endsOn: null },
): FundraiserFields {
  const errors: Record<string, string> = {};
  let fields: FundraiserFields | undefined;
  try {
    fields = parseInput(fundraiserFields, rec);
  } catch (e) {
    if (!(e instanceof ValidationError)) throw e;
    Object.assign(errors, e.fieldErrors);
  }
  // Format problems ("Pick a valid date.") come from the fields above; range and order only for real dates.
  const dates = dateFields.safeParse(rec);
  if (dates.success) {
    const { startsOn, endsOn } = dates.data;
    const startProblem = dateProblem(ctx, startsOn, keep.startsOn);
    const endProblem = dateProblem(ctx, endsOn, keep.endsOn);
    if (startProblem) errors.startsOn ??= startProblem;
    if (endProblem) errors.endsOn ??= endProblem;
    else if (startsOn && endsOn && endsOn < startsOn) errors.endsOn ??= DATES_MESSAGE;
  }
  const messages = Object.values(errors);
  if (messages.length > 0 || !fields) {
    throw new ValidationError(messages.length === 1 ? messages[0] : "Please fix the highlighted fields.", errors);
  }
  return fields;
}

/** The lead must be an ACTIVE person (`keep`: an edit may leave the current lead as it is, even if they left). */
async function assertLead(db: Tx | ServiceContext["db"], leadId: string | undefined, keep: string | null = null) {
  if (!leadId || leadId === keep) return;
  const lead = await db.user.findUnique({ where: { id: leadId }, select: { status: true } });
  if (!lead || lead.status !== "ACTIVE") throw new ValidationError(LEAD_MESSAGE, { leadId: LEAD_MESSAGE });
}

function columns(f: FundraiserFields) {
  return {
    name: f.name,
    kind: f.kind,
    status: f.status,
    description: f.description ?? "",
    location: f.location ?? "",
    link: f.link,
    startsOn: f.startsOn ? dateOnlyToDb(f.startsOn) : null,
    endsOn: f.endsOn ? dateOnlyToDb(f.endsOn) : null,
    goalAmount: f.goalAmount,
    raisedAmount: f.raisedAmount ?? 0,
    leadId: f.leadId ?? null,
    volunteerLimit: f.volunteerLimit,
  };
}

/** The amount raised was updated (e.g. with the quick box) while the edit form was open. */
export function raisedChangedMessage(now: number): string {
  return `The amount raised was changed to ${formatDollars(now)} while you were editing. Save again to replace it with yours.`;
}

/** The lead was deleted between our check and the write. */
function isMissingReference(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2003";
}

/** Lost the race for the last spot (or it filled up while the page was open). */
export function fundraiserFullMessage(limit: number): string {
  return limit === 1 ? "The only spot is taken." : `All ${limit} spots are taken.`;
}

// ---------- fundraisers (Business team and staff) ----------

/** Add a fundraiser. */
export async function createFundraiser(ctx: ServiceContext, raw: unknown): Promise<{ id: string }> {
  requireManager(ctx);
  const fields = parseFundraiserForm(ctx, asRecord(raw));
  await assertLead(ctx.db, fields.leadId);
  await limitWrites(ctx);
  try {
    const { id } = await ctx.db.fundraiser.create({ data: { ...columns(fields), createdById: ctx.actor.id }, select: { id: true } });
    return { id };
  } catch (e) {
    if (isMissingReference(e)) throw new ValidationError(LEAD_MESSAGE, { leadId: LEAD_MESSAGE });
    throw e;
  }
}

/**
 * Save the edit form. The spots limit can't go below the (active) people already signed up, counted under
 * the row lock so a sign-up can't sneak in between. The form sends `loadedRaisedAmount` (the amount raised
 * when it was opened), so a stale form can't undo a newer amount: left as loaded, the amount now in the
 * database is kept; changed while someone else also changed it, the save is refused on that field (saving
 * again then replaces it — the page reloads the form's copy).
 */
export async function updateFundraiser(ctx: ServiceContext, raw: unknown): Promise<{ id: string }> {
  requireManager(ctx);
  const rec = asRecord(raw);
  const { fundraiserId } = parseInput(idInput, rec);
  const before = await ctx.db.fundraiser.findUnique({ where: { id: fundraiserId }, select: { startsOn: true, endsOn: true } });
  if (!before) throw new NotFoundError(FUNDRAISER_NOT_FOUND);
  const fields = parseFundraiserForm(ctx, rec, {
    startsOn: before.startsOn && dbToDateOnly(before.startsOn),
    endsOn: before.endsOn && dbToDateOnly(before.endsOn),
  });
  const loadedRaised = loadedRaisedField.safeParse(rec.loadedRaisedAmount).data;
  await limitWrites(ctx);
  try {
    await ctx.db.$transaction(async (tx) => {
      await lockFundraiser(tx, fundraiserId);
      const existing = await tx.fundraiser.findUnique({
        where: { id: fundraiserId },
        select: { leadId: true, raisedAmount: true, _count: { select: activeVolunteers } },
      });
      if (!existing) throw new NotFoundError(FUNDRAISER_NOT_FOUND);
      const data = columns(fields);
      if (loadedRaised !== undefined) {
        if (data.raisedAmount === loadedRaised) {
          data.raisedAmount = existing.raisedAmount; // not touched here: keep the newest amount
        } else if (existing.raisedAmount !== loadedRaised && existing.raisedAmount !== data.raisedAmount) {
          const message = raisedChangedMessage(existing.raisedAmount);
          throw new ValidationError(message, { raisedAmount: message });
        }
      }
      await assertLead(tx, fields.leadId, existing.leadId);
      const signedUp = existing._count.volunteers;
      if (fields.volunteerLimit !== null && fields.volunteerLimit < signedUp) {
        const message = `${signedUp} people already signed up. Set at least ${signedUp} spots, or take someone off the list first.`;
        throw new ValidationError(message, { volunteerLimit: message });
      }
      await tx.fundraiser.update({ where: { id: fundraiserId }, data, select: { id: true } });
    });
  } catch (e) {
    if (isMissingReference(e)) throw new ValidationError(LEAD_MESSAGE, { leadId: LEAD_MESSAGE });
    throw e;
  }
  return { id: fundraiserId };
}

/** Remove a fundraiser (and its helper list). */
export async function deleteFundraiser(ctx: ServiceContext, raw: unknown): Promise<{ name: string }> {
  requireManager(ctx);
  const { fundraiserId } = parseInput(idInput, asRecord(raw));
  const existing = await ctx.db.fundraiser.findUnique({ where: { id: fundraiserId }, select: { name: true } });
  if (!existing) throw new NotFoundError(FUNDRAISER_NOT_FOUND);
  await limitWrites(ctx);
  const { count } = await ctx.db.fundraiser.deleteMany({ where: { id: fundraiserId } });
  if (count === 0) throw new NotFoundError(FUNDRAISER_NOT_FOUND);
  return { name: existing.name };
}

/** The quick "Update amount raised" box: just the money that has come in so far. */
export async function updateRaisedAmount(ctx: ServiceContext, raw: unknown): Promise<{ raisedAmount: number }> {
  requireManager(ctx);
  const { fundraiserId, raisedAmount } = parseInput(raisedInput, asRecord(raw));
  await limitWrites(ctx);
  const amount = raisedAmount ?? 0;
  const { count } = await ctx.db.fundraiser.updateMany({ where: { id: fundraiserId }, data: { raisedAmount: amount } });
  if (count === 0) throw new NotFoundError(FUNDRAISER_NOT_FOUND);
  return { raisedAmount: amount };
}

/**
 * The whole season's goal and the day the season started, shown at the top of the page. Only fundraisers
 * whose last day is on or after the start count toward the totals (so last season's money doesn't). An
 * empty goal means the page adds up each fundraiser's goal; an empty start counts every fundraiser.
 */
export async function updateSeasonGoal(
  ctx: ServiceContext,
  raw: unknown,
): Promise<{ goal: number | null; seasonStart: DateOnly | null }> {
  requireManager(ctx);
  const rec = asRecord(raw);
  const errors: Record<string, string> = {};
  let parsed: z.infer<typeof seasonGoalInput> | undefined;
  try {
    parsed = parseInput(seasonGoalInput, rec);
  } catch (e) {
    if (!(e instanceof ValidationError)) throw e;
    Object.assign(errors, e.fieldErrors);
  }
  const startProblem = parsed ? dateProblem(ctx, parsed.seasonStart) : null;
  if (startProblem) errors.seasonStart = startProblem;
  const messages = Object.values(errors);
  if (messages.length > 0 || !parsed) {
    throw new ValidationError(messages.length === 1 ? messages[0] : "Please fix the highlighted fields.", errors);
  }
  const goal = parsed.goal;
  const seasonStart = parsed.seasonStart ?? null;
  await limitWrites(ctx);
  const notes = [
    { key: FUNDRAISING_SEASON_GOAL_KEY, body: goal === null ? "" : String(goal) },
    { key: FUNDRAISING_SEASON_START_KEY, body: seasonStart ?? "" },
  ];
  await ctx.db.$transaction(
    notes.map(({ key, body }) =>
      ctx.db.teamNote.upsert({
        where: { key },
        create: { key, body, updatedById: ctx.actor.id },
        update: { body, updatedById: ctx.actor.id },
      }),
    ),
  );
  return { goal, seasonStart };
}

/** Take someone off a fundraiser's helper list (any time — e.g. to fix the list after the event). */
export async function removeVolunteer(ctx: ServiceContext, raw: unknown): Promise<{ name: string }> {
  requireManager(ctx);
  const { fundraiserId, userId } = parseInput(removeVolunteerInput, asRecord(raw));
  const row = await ctx.db.fundraiserVolunteer.findUnique({
    where: { fundraiserId_userId: { fundraiserId, userId } },
    select: { id: true, user: { select: { name: true } } },
  });
  if (!row) throw new NotFoundError("They're no longer on the helper list.");
  await limitWrites(ctx);
  await ctx.db.fundraiserVolunteer.deleteMany({ where: { id: row.id } });
  return { name: row.user.name };
}

// ---------- helping (everyone) ----------

/** "I'll help": put yourself on the helper list, while it's open and there's a spot left. */
export async function volunteer(ctx: ServiceContext, raw: unknown): Promise<void> {
  requireActive(ctx);
  const { fundraiserId } = parseInput(idInput, asRecord(raw));
  await limitHelp(ctx);
  const day = today(ctx);
  try {
    await ctx.db.$transaction(async (tx) => {
      await lockFundraiser(tx, fundraiserId);
      const f = await tx.fundraiser.findUnique({
        where: { id: fundraiserId },
        select: {
          status: true,
          startsOn: true,
          endsOn: true,
          volunteerLimit: true,
          _count: { select: activeVolunteers },
          volunteers: { where: { userId: ctx.actor.id }, select: { id: true } },
        },
      });
      if (!f) throw new NotFoundError(FUNDRAISER_NOT_FOUND);
      const closed = fundraiserClosedReason(
        { status: f.status, startsOn: f.startsOn && dbToDateOnly(f.startsOn), endsOn: f.endsOn && dbToDateOnly(f.endsOn) },
        day,
      );
      if (closed) throw new ConflictError(closed);
      if (f.volunteers.length > 0) throw new ConflictError(ALREADY_HELPING);
      if (f.volunteerLimit !== null && f._count.volunteers >= f.volunteerLimit) throw new ConflictError(fundraiserFullMessage(f.volunteerLimit));
      await tx.fundraiserVolunteer.create({ data: { fundraiserId, userId: ctx.actor.id }, select: { id: true } });
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError) {
      if (e.code === "P2002") throw new ConflictError(ALREADY_HELPING);
      if (e.code === "P2003" || e.code === "P2025") throw new NotFoundError(FUNDRAISER_NOT_FOUND);
    }
    throw e;
  }
}

/**
 * "Leave": take yourself off the helper list while the fundraiser is still open. Once it's over (or
 * cancelled) the list stays as it is — the Business team can still fix it.
 */
export async function unvolunteer(ctx: ServiceContext, raw: unknown): Promise<void> {
  requireActive(ctx);
  const { fundraiserId } = parseInput(idInput, asRecord(raw));
  await limitHelp(ctx);
  const day = today(ctx);
  await ctx.db.$transaction(async (tx) => {
    await lockFundraiser(tx, fundraiserId);
    const f = await tx.fundraiser.findUnique({
      where: { id: fundraiserId },
      select: { status: true, startsOn: true, endsOn: true },
    });
    if (!f) throw new NotFoundError(FUNDRAISER_NOT_FOUND);
    const closed = fundraiserClosedReason(
      { status: f.status, startsOn: f.startsOn && dbToDateOnly(f.startsOn), endsOn: f.endsOn && dbToDateOnly(f.endsOn) },
      day,
    );
    if (closed) throw new ConflictError(`${closed} Ask the Business team if the helper list needs a fix.`);
    const { count } = await tx.fundraiserVolunteer.deleteMany({ where: { fundraiserId, userId: ctx.actor.id } });
    if (count === 0) throw new NotFoundError(NOT_HELPING);
  });
}
