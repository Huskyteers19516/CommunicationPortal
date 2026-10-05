// Team calendar: league meets, the ILT, scrimmages, competitions, outreach, deadlines, team events.
// - Every ACTIVE person sees the calendar (queries/calendar.ts); staff (canManageCalendar: every leader, the
//   captain, mentors, teachers, owners) add, edit, and remove events. No emails.
// - Field rules live in src/lib/calendar.ts (checkCalendarEventFields), shared with the form.
// - The edit form sends `version` (the event's updatedAt when it was opened): a stale save is a ConflictError,
//   so it can't silently undo someone else's edit.
// - Events loaded from a season schedule carry a `sourceKey`; editing keeps it, so loading again never duplicates.
// - "Hide from the team website" (hideFromWebsite) keeps a meet, scrimmage, competition, or outreach event off the
//   team website's Events page (src/server/queries/public-events.ts); other kinds are never published.
import { z } from "zod";
import { type CalendarEventFields, checkCalendarEventFields } from "@/lib/calendar";
import { type DateOnly, dateOnlyToDb, dbToDateOnly, todayInTimezone } from "@/lib/dates";
import { idSchema } from "@/lib/validation";
import { parseInput } from "../action";
import type { ServiceContext } from "../context";
import { ConflictError, ForbiddenError, NotFoundError, RateLimitError, ValidationError } from "../errors";
import { canManageCalendar } from "../permissions";
import { consumeRateLimit } from "../rate-limit";

const HOUR = 60 * 60 * 1000;
/** New events per person per hour: plenty for typing in a season's schedule, stops a runaway script. */
export const CALENDAR_CREATE_RATE_LIMIT = { limit: 60, windowMs: HOUR } as const;

export const CALENDAR_EVENT_NOT_FOUND = "That event isn't on the calendar any more.";
export const CALENDAR_EVENT_CHANGED =
  "Someone changed this event while you were editing. Save again to replace their changes with yours, or reload the page to see them.";
const MANAGERS_ONLY = "Only leaders, the captain, mentors, and teachers can change the team calendar.";
const INACTIVE = "Your account isn't active.";

const idInput = z.object({ eventId: idSchema });

function asRecord(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

/** ACTIVE and allowed to change the calendar, else ForbiddenError. */
function requireManager(ctx: ServiceContext) {
  if (ctx.actor.status !== "ACTIVE") throw new ForbiddenError(INACTIVE);
  if (!canManageCalendar(ctx.actor)) throw new ForbiddenError(MANAGERS_ONLY);
}

function today(ctx: ServiceContext): DateOnly {
  return todayInTimezone(ctx.config.teamTimezone, ctx.now);
}

/** Every field checked at once; ValidationError with each field's problem. */
function parseEventForm(
  ctx: ServiceContext,
  rec: Record<string, unknown>,
  keep: { startsOn?: DateOnly | null; endsOn?: DateOnly | null } = {},
): CalendarEventFields {
  const result = checkCalendarEventFields(rec, today(ctx), keep);
  if (result.ok) return result.value;
  const messages = Object.values(result.fieldErrors);
  throw new ValidationError(messages.length === 1 ? messages[0] : "Please fix the highlighted fields.", result.fieldErrors);
}

function columns(f: CalendarEventFields) {
  return {
    title: f.title,
    kind: f.kind,
    startsOn: dateOnlyToDb(f.startsOn),
    endsOn: f.endsOn ? dateOnlyToDb(f.endsOn) : null,
    startTime: f.startTime,
    endTime: f.startTime ? f.endTime : null,
    location: f.location,
    link: f.link,
    notes: f.notes,
    hideFromWebsite: f.hideFromWebsite,
  };
}

/** The edit form's `version`: the event's updatedAt when the form was opened (ISO), or missing. */
function parseVersion(value: unknown): Date | null {
  if (value === undefined || value === null || value === "") return null;
  const date = typeof value === "string" && value.length <= 40 ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) throw new ConflictError(CALENDAR_EVENT_CHANGED);
  return date;
}

/** Add an event. */
export async function createCalendarEvent(ctx: ServiceContext, raw: unknown): Promise<{ id: string }> {
  requireManager(ctx);
  const fields = parseEventForm(ctx, asRecord(raw));
  const { limit, windowMs } = CALENDAR_CREATE_RATE_LIMIT;
  if (!(await consumeRateLimit(ctx.db, `calendar-create:${ctx.actor.id}`, limit, windowMs, ctx.now))) {
    throw new RateLimitError("You've added a lot of events in the last hour. Please wait a bit and try again.");
  }
  const { id } = await ctx.db.calendarEvent.create({
    data: { ...columns(fields), createdById: ctx.actor.id },
    select: { id: true },
  });
  return { id };
}

/**
 * Save the edit form. An edit may keep days that are out of the usual range now (an old event). With a
 * `version`, the write is conditional on the event not having changed since the form was opened.
 */
export async function updateCalendarEvent(ctx: ServiceContext, raw: unknown): Promise<{ id: string }> {
  requireManager(ctx);
  const rec = asRecord(raw);
  const { eventId } = parseInput(idInput, rec);
  const existing = await ctx.db.calendarEvent.findUnique({
    where: { id: eventId },
    select: { startsOn: true, endsOn: true, updatedAt: true },
  });
  if (!existing) throw new NotFoundError(CALENDAR_EVENT_NOT_FOUND);
  // The version before the fields: a stale form that also has a field error must still say "someone changed
  // it", or the refreshed page's newer version would let the next save silently replace the other edit.
  const version = parseVersion(rec.version);
  if (version && existing.updatedAt.getTime() !== version.getTime()) throw new ConflictError(CALENDAR_EVENT_CHANGED);
  const fields = parseEventForm(ctx, rec, {
    startsOn: dbToDateOnly(existing.startsOn),
    endsOn: existing.endsOn && dbToDateOnly(existing.endsOn),
  });
  const { count } = await ctx.db.calendarEvent.updateMany({
    where: { id: eventId, ...(version ? { updatedAt: version } : {}) },
    data: { ...columns(fields), updatedById: ctx.actor.id },
  });
  if (count === 0) {
    const still = await ctx.db.calendarEvent.count({ where: { id: eventId } });
    throw still ? new ConflictError(CALENDAR_EVENT_CHANGED) : new NotFoundError(CALENDAR_EVENT_NOT_FOUND);
  }
  return { id: eventId };
}

/** Remove an event. Returns what it was (for the "Removed …" message and the month to go back to). */
export async function deleteCalendarEvent(ctx: ServiceContext, raw: unknown): Promise<{ title: string; startsOn: DateOnly }> {
  requireManager(ctx);
  const { eventId } = parseInput(idInput, asRecord(raw));
  const existing = await ctx.db.calendarEvent.findUnique({ where: { id: eventId }, select: { title: true, startsOn: true } });
  if (!existing) throw new NotFoundError(CALENDAR_EVENT_NOT_FOUND);
  const { count } = await ctx.db.calendarEvent.deleteMany({ where: { id: eventId } });
  if (count === 0) throw new NotFoundError(CALENDAR_EVENT_NOT_FOUND);
  return { title: existing.title, startsOn: dbToDateOnly(existing.startsOn) };
}
