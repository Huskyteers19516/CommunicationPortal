// Parts queue: parts someone needs printed, cut, or machined, in priority order.
// - Any ACTIVE person adds a part (it goes to the end of the queue) and can grab one ("I'll make it").
// - Whoever asked for a part can change or remove it until someone grabs it.
// - The person making it drops it or marks it done.
// - Build leaders (and captain/mentors/teachers/owners) reorder the queue, change or remove anyone's
//   parts, drop or finish anyone's claim, and put finished parts back in the queue.
//
// The queue order is `position` among parts that aren't done (smaller = sooner). Writes that pick or
// change positions take a transaction-scoped advisory lock, so two adds (or moves) at once can't
// collide. Claims are conditional writes, so two people grabbing the same part → exactly one wins.
import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import { PartProcess, type PartStatus } from "@/generated/prisma/enums";
import { LIMITS } from "@/lib/constants";
import { addDays, dateOnlyToDb, dbToDateOnly, todayInTimezone } from "@/lib/dates";
import { dateOnlySchema, idSchema, optionalText, text } from "@/lib/validation";
import { parseInput } from "../action";
import type { ServiceContext } from "../context";
import { ConflictError, ForbiddenError, NotFoundError, RateLimitError, ValidationError } from "../errors";
import { canEditPart, canManageParts, canWorkOnPart } from "../permissions";
import { consumeRateLimit } from "../rate-limit";
import { categoryNameKey, normalizeCategoryName } from "./categories";
import { parseHttpUrl } from "./resources";

type Tx = Prisma.TransactionClient;

/** New parts per person per hour. Plenty for a build session; stops scripted floods. */
export const PART_RATE_LIMIT = { limit: 30, windowMs: 60 * 60 * 1000 } as const;
/** How far back / ahead "Needed by" may be set (days from today in the team timezone), like task due dates. */
export const NEEDED_BY_MAX_PAST_DAYS = 30;
export const NEEDED_BY_MAX_FUTURE_DAYS = 365;

export const PART_NOT_FOUND = "That part is no longer in the queue.";
/** Lost a claim race: "Maya Patel just grabbed this one." */
export function partGrabbedMessage(claimerName: string | null): string {
  return `${claimerName ?? "Someone"} just grabbed this one.`;
}
const ALREADY_MAKING = "You're already making this one.";
const ALREADY_DONE = "This part is already done.";
const NOBODY_MAKING = "Nobody is making this one right now.";
const INACTIVE = "Your account isn't active.";
const CANT_EDIT = "Only the person who asked for it (before someone grabs it) or a Build leader can change this.";
const CANT_WORK = "Only the person making it or a Build leader can do that.";
const MANAGERS_ONLY = "Only Build leaders, the captain, mentors, and teachers can do that.";
const CATEGORY_GONE = "That category no longer exists. Pick another one.";
const LINK_MESSAGE = "Enter a web link to the file, like drive.google.com/…";
const QUANTITY_MESSAGE = `Enter a quantity from 1 to ${LIMITS.partQuantityMax}.`;

// ---------- input schemas ----------

/** "" / missing = 1; otherwise a whole number 1..LIMITS.partQuantityMax. */
const quantityField = z.preprocess(
  (v) => {
    if (v === undefined || v === null) return 1;
    if (typeof v !== "string") return v;
    const s = v.trim();
    if (s === "") return 1;
    return /^\d+$/.test(s) ? Number(s) : Number.NaN;
  },
  z
    .number({ error: QUANTITY_MESSAGE })
    .int(QUANTITY_MESSAGE)
    .min(1, QUANTITY_MESSAGE)
    .max(LIMITS.partQuantityMax, QUANTITY_MESSAGE),
);

/**
 * "drive.google.com/…" → "https://drive.google.com/…"; anything with a scheme (or that doesn't look like
 * a web address) is left alone for parseHttpUrl to accept or refuse. Same rule as the sponsor website field.
 */
function withHttps(value: string): string {
  const v = value.trim();
  if (!v || /^[a-z][a-z0-9+.-]*:\/\//i.test(v)) return v;
  return /^(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}(:\d+)?([/?#]\S*)?$/i.test(v) ? `https://${v}` : v;
}

/** "" = no file; otherwise an absolute http(s) link (normalized; https:// added to a bare address). */
const fileUrlField = z.preprocess(
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

/** "" = not for anything in particular; otherwise a TaskCategory id (checked against the DB). */
const categoryIdField = z.preprocess(
  (v) => (v === undefined || v === null ? "" : v),
  z.string({ error: "Pick a category from the list." }).trim().max(64, "Pick a category from the list."),
);

/**
 * "For", typed in (with the task categories as suggestions): a category's name links the part to that
 * category; anything else is kept as plain text. Missing = the older categoryId field decides.
 */
const forTextField = z.preprocess(
  (v) => (v === null ? "" : v),
  z
    .string({ error: "Type what it's for, or leave it empty." })
    .max(LIMITS.partForMax * 2, `Keep it under ${LIMITS.partForMax} characters.`)
    .transform((v) => normalizeCategoryName(v))
    .pipe(z.string().max(LIMITS.partForMax, `Keep it under ${LIMITS.partForMax} characters.`))
    .optional(),
);

const neededByField = z.preprocess(
  (v) => (v === undefined || v === null || (typeof v === "string" && v.trim() === "") ? undefined : v),
  dateOnlySchema.optional(),
);

const partFields = {
  name: text("Part name", LIMITS.partNameMax),
  process: z.preprocess((v) => (v === "" || v === null ? undefined : v), z.enum(PartProcess, { error: "Pick how it's made." })),
  quantity: quantityField,
  material: optionalText("Material", LIMITS.partMaterialMax),
  fileUrl: fileUrlField,
  notes: optionalText("Notes", LIMITS.partNotesMax),
  categoryId: categoryIdField,
  forText: forTextField,
  neededBy: neededByField,
};

const createInput = z.object(partFields);
const updateInput = z.object({ partId: idSchema, ...partFields });
const partIdInput = z.object({ partId: idSchema });
const moveInput = z.object({
  partId: idSchema,
  direction: z.enum(["up", "down", "top"], { error: "Pick up, down, or top." }),
});

type PartFields = z.infer<typeof createInput>;

// ---------- helpers ----------

function asRecord(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

function requireActive(ctx: ServiceContext) {
  if (ctx.actor.status !== "ACTIVE") throw new ForbiddenError(INACTIVE);
}

function requireManager(ctx: ServiceContext, message = MANAGERS_ONLY) {
  if (!canManageParts(ctx.actor)) throw new ForbiddenError(message);
}

/** Serialize changes to the queue order until the transaction ends. */
async function lockQueue(tx: Tx): Promise<void> {
  await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext('parts-queue'))`;
}

/** The position just after the last part that isn't done. Call with the queue locked. */
async function endOfQueue(tx: Tx): Promise<number> {
  const agg = await tx.part.aggregate({ where: { status: { not: "DONE" } }, _max: { position: true } });
  return (agg._max.position ?? -1) + 1;
}

function checkNeededBy(ctx: ServiceContext, neededBy: string) {
  const today = todayInTimezone(ctx.config.teamTimezone, ctx.now);
  if (neededBy < addDays(today, -NEEDED_BY_MAX_PAST_DAYS)) {
    throw new ValidationError("That date is too far in the past.", {
      neededBy: `Pick a date no more than ${NEEDED_BY_MAX_PAST_DAYS} days ago.`,
    });
  }
  if (neededBy > addDays(today, NEEDED_BY_MAX_FUTURE_DAYS)) {
    throw new ValidationError("That date is too far away.", { neededBy: "Pick a date within the next year." });
  }
}

/** The category picked in the form must still exist (any subteam's list, or whole-team). */
async function resolveCategory(ctx: ServiceContext, categoryId: string): Promise<string | null> {
  if (categoryId === "") return null;
  const category = await ctx.db.taskCategory.findUnique({ where: { id: categoryId }, select: { id: true } });
  if (!category) throw new ValidationError(CATEGORY_GONE, { categoryId: CATEGORY_GONE });
  return category.id;
}

/** Where a part points: a task category, or typed-in text. */
interface PartTarget {
  categoryId: string | null;
  forLabel: string;
}

/**
 * The "For" the form sent. Typed text that matches a category name (any case/spacing) links to that
 * category — Build's first, then the other subteams', then whole-team — otherwise it's kept as text.
 */
async function resolveTarget(ctx: ServiceContext, data: PartFields): Promise<PartTarget> {
  if (data.forText === undefined) return { categoryId: await resolveCategory(ctx, data.categoryId), forLabel: "" };
  if (data.forText === "") return { categoryId: null, forLabel: "" };
  const matches = await ctx.db.taskCategory.findMany({
    where: { nameKey: categoryNameKey(data.forText) },
    select: { id: true, subteam: true },
  });
  const rank = (s: string | null) => (s === "BUILD" ? 0 : s === null ? 2 : 1);
  const best = matches.sort((a, b) => rank(a.subteam) - rank(b.subteam))[0];
  return best ? { categoryId: best.id, forLabel: "" } : { categoryId: null, forLabel: data.forText };
}

/** The category was deleted between our check and the write. */
function isCategoryGone(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2003";
}

function columns(data: PartFields, target: PartTarget) {
  return {
    name: data.name,
    process: data.process,
    quantity: data.quantity,
    material: data.material ?? "",
    fileUrl: data.fileUrl,
    notes: data.notes ?? "",
    categoryId: target.categoryId,
    forLabel: target.forLabel,
    neededBy: data.neededBy ? dateOnlyToDb(data.neededBy) : null,
  };
}

const partSelect = { id: true, status: true, requestedById: true, claimedById: true, neededBy: true } as const;

async function loadPart(ctx: ServiceContext, partId: string) {
  const part = await ctx.db.part.findUnique({ where: { id: partId }, select: partSelect });
  if (!part) throw new NotFoundError(PART_NOT_FOUND);
  return part;
}

interface PartNow {
  status: PartStatus;
  claimedById: string | null;
  /** Who's making it (or made it), if anyone. */
  claimerName: string | null;
}

/** Why a conditional write matched nothing: gone, or its state changed under us. */
async function explainMiss(ctx: ServiceContext, partId: string, fallback: (now: PartNow) => string) {
  const now = await ctx.db.part.findUnique({
    where: { id: partId },
    select: { status: true, claimedById: true, claimedBy: { select: { name: true } } },
  });
  if (!now) return new NotFoundError(PART_NOT_FOUND);
  return new ConflictError(fallback({ status: now.status, claimedById: now.claimedById, claimerName: now.claimedBy?.name ?? null }));
}

/** "Maya Patel is making this one now." */
function makingNow(claimerName: string | null): string {
  return claimerName ? `${claimerName} is making this one now.` : "Someone else is making this one now.";
}

/** The requester's edit lost a race: someone grabbed (or finished) the part first. */
function lockedOut(now: PartNow, verb: "change" | "remove"): string {
  const what = now.status === "DONE" ? "This part is already done" : `${now.claimerName ?? "Someone"} just grabbed this one`;
  return `${what}, so only a Build leader can ${verb} it now.`;
}

// ---------- services ----------

/** Ask for a part. Anyone ACTIVE; it goes to the end of the queue. */
export async function createPart(ctx: ServiceContext, raw: unknown): Promise<{ id: string }> {
  requireActive(ctx);
  const data = parseInput(createInput, asRecord(raw));
  if (data.neededBy) checkNeededBy(ctx, data.neededBy);
  const target = await resolveTarget(ctx, data);

  const allowed = await consumeRateLimit(ctx.db, `part:${ctx.actor.id}`, PART_RATE_LIMIT.limit, PART_RATE_LIMIT.windowMs, ctx.now);
  if (!allowed) throw new RateLimitError("You've added a lot of parts in the last hour. Please wait a bit and try again.");

  try {
    return await ctx.db.$transaction(async (tx) => {
      await lockQueue(tx);
      return tx.part.create({
        data: { ...columns(data, target), position: await endOfQueue(tx), status: "NEEDED", requestedById: ctx.actor.id },
        select: { id: true },
      });
    });
  } catch (e) {
    if (isCategoryGone(e)) throw new ValidationError(CATEGORY_GONE, { categoryId: CATEGORY_GONE });
    throw e;
  }
}

/**
 * Change a part. Managers: any part, any time. Whoever asked for it: only while nobody has grabbed it
 * (checked again in the write, so a claim that lands first wins).
 */
export async function updatePart(ctx: ServiceContext, raw: unknown): Promise<{ id: string; status: PartStatus }> {
  requireActive(ctx);
  const rec = asRecord(raw);
  const { partId } = parseInput(partIdInput, rec);
  const part = await loadPart(ctx, partId);
  if (!canEditPart(ctx.actor, part)) throw new ForbiddenError(CANT_EDIT);
  const data = parseInput(updateInput, rec);
  // Keeping the date it already has is fine (so old parts stay editable); a new one must be in range.
  if (data.neededBy && data.neededBy !== (part.neededBy ? dbToDateOnly(part.neededBy) : null)) checkNeededBy(ctx, data.neededBy);
  const target = await resolveTarget(ctx, data);

  const manager = canManageParts(ctx.actor);
  const where: Prisma.PartWhereInput = manager ? { id: part.id } : { id: part.id, requestedById: ctx.actor.id, status: "NEEDED" };
  let count: number;
  try {
    ({ count } = await ctx.db.part.updateMany({ where, data: columns(data, target) }));
  } catch (e) {
    if (isCategoryGone(e)) throw new ValidationError(CATEGORY_GONE, { categoryId: CATEGORY_GONE });
    throw e;
  }
  if (count === 0) {
    throw await explainMiss(ctx, part.id, (now) => lockedOut(now, "change"));
  }
  const now = await ctx.db.part.findUnique({ where: { id: part.id }, select: { status: true } });
  return { id: part.id, status: now?.status ?? part.status };
}

/** Remove a part: managers any; whoever asked for it while nobody has grabbed it. */
export async function deletePart(ctx: ServiceContext, raw: unknown): Promise<void> {
  requireActive(ctx);
  const { partId } = parseInput(partIdInput, asRecord(raw));
  const part = await loadPart(ctx, partId);
  if (!canEditPart(ctx.actor, part)) throw new ForbiddenError(CANT_EDIT);
  const where: Prisma.PartWhereInput = canManageParts(ctx.actor)
    ? { id: part.id }
    : { id: part.id, requestedById: ctx.actor.id, status: "NEEDED" };
  // Same lock as reordering, so a move and a removal at the same moment don't trip over each other.
  const { count } = await ctx.db.$transaction(async (tx) => {
    await lockQueue(tx);
    return tx.part.deleteMany({ where });
  });
  if (count === 0) {
    throw await explainMiss(ctx, part.id, (now) => lockedOut(now, "remove"));
  }
}

/** "I'll make it": grab a part that's up for grabs. If two people grab it at once, exactly one gets it. */
export async function claimPart(ctx: ServiceContext, raw: unknown): Promise<void> {
  requireActive(ctx);
  const { partId } = parseInput(partIdInput, asRecord(raw));
  const { count } = await ctx.db.part.updateMany({
    where: { id: partId, status: "NEEDED" },
    data: { status: "CLAIMED", claimedById: ctx.actor.id, claimedAt: ctx.now },
  });
  if (count > 0) return;
  throw await explainMiss(ctx, partId, (now) => {
    if (now.status === "DONE") return ALREADY_DONE;
    return now.claimedById === ctx.actor.id ? ALREADY_MAKING : partGrabbedMessage(now.claimerName);
  });
}

/** "Drop it": the person making it (or a manager) puts it back up for grabs, at the same place in the queue. */
export async function unclaimPart(ctx: ServiceContext, raw: unknown): Promise<void> {
  requireActive(ctx);
  const { partId } = parseInput(partIdInput, asRecord(raw));
  const part = await loadPart(ctx, partId);
  if (!canWorkOnPart(ctx.actor, part)) throw new ForbiddenError(CANT_WORK);
  const where: Prisma.PartWhereInput = canManageParts(ctx.actor)
    ? { id: part.id, status: "CLAIMED" }
    : { id: part.id, status: "CLAIMED", claimedById: ctx.actor.id };
  const { count } = await ctx.db.part.updateMany({
    where,
    data: { status: "NEEDED", claimedById: null, claimedAt: null },
  });
  if (count > 0) return;
  throw await explainMiss(ctx, part.id, (now) =>
    now.status === "DONE" ? ALREADY_DONE : now.status === "NEEDED" ? NOBODY_MAKING : makingNow(now.claimerName),
  );
}

/**
 * "Mark done": the person making it, or a manager. Managers can also mark a part that's up for grabs
 * done (say, someone made it without grabbing it here); nobody is then recorded as its maker.
 */
export async function finishPart(ctx: ServiceContext, raw: unknown): Promise<void> {
  requireActive(ctx);
  const { partId } = parseInput(partIdInput, asRecord(raw));
  const part = await loadPart(ctx, partId);
  if (!canWorkOnPart(ctx.actor, part)) {
    throw new ForbiddenError(
      part.status === "NEEDED" ? "Grab it with “I'll make it” first, then mark it done when it's finished." : CANT_WORK,
    );
  }
  const where: Prisma.PartWhereInput = canManageParts(ctx.actor)
    ? { id: part.id, status: { in: ["NEEDED", "CLAIMED"] } }
    : { id: part.id, status: "CLAIMED", claimedById: ctx.actor.id };
  const { count } = await ctx.db.part.updateMany({ where, data: { status: "DONE", doneAt: ctx.now } });
  if (count > 0) return;
  throw await explainMiss(ctx, part.id, (now) =>
    now.status === "DONE" ? ALREADY_DONE : now.status === "NEEDED" ? NOBODY_MAKING : makingNow(now.claimerName),
  );
}

/** "Put back in the queue": managers reopen a finished part. It's up for grabs again, at the end of the queue. */
export async function reopenPart(ctx: ServiceContext, raw: unknown): Promise<void> {
  requireActive(ctx);
  const { partId } = parseInput(partIdInput, asRecord(raw));
  requireManager(ctx, "Only Build leaders, the captain, mentors, and teachers can put parts back in the queue.");
  const count = await ctx.db.$transaction(async (tx) => {
    await lockQueue(tx);
    const position = await endOfQueue(tx);
    const res = await tx.part.updateMany({
      where: { id: partId, status: "DONE" },
      data: { status: "NEEDED", position, claimedById: null, claimedAt: null, doneAt: null },
    });
    return res.count;
  });
  if (count > 0) return;
  throw await explainMiss(ctx, partId, () => "This part is already in the queue.");
}

/**
 * Move a part up or down one place, or to the top, among the parts that aren't done (managers only).
 * Already at that edge: nothing changes. Otherwise the queue is renumbered 0..n-1.
 */
export async function movePart(ctx: ServiceContext, raw: unknown): Promise<void> {
  requireActive(ctx);
  const data = parseInput(moveInput, asRecord(raw));
  requireManager(ctx, "Only Build leaders, the captain, mentors, and teachers can reorder the queue.");

  await ctx.db.$transaction(async (tx) => {
    await lockQueue(tx);
    const queue = await tx.part.findMany({
      where: { status: { not: "DONE" } },
      orderBy: [{ position: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      select: { id: true, position: true },
    });
    const from = queue.findIndex((p) => p.id === data.partId);
    if (from === -1) {
      const exists = await tx.part.count({ where: { id: data.partId } });
      throw exists ? new ConflictError(ALREADY_DONE) : new NotFoundError(PART_NOT_FOUND);
    }
    const to = data.direction === "top" ? 0 : data.direction === "up" ? from - 1 : from + 1;
    if (to < 0 || to >= queue.length || to === from) return;

    const order = queue.map((p) => p.id);
    const [moved] = order.splice(from, 1);
    order.splice(to, 0, moved);

    // Renumber 0..n-1 so gaps left by finished/removed parts disappear — one statement, only changed rows.
    // (A row that vanished meanwhile simply matches nothing; removals take the same lock anyway.)
    const positions = order.map((_, i) => i);
    await tx.$executeRaw`
      UPDATE "Part" AS p SET "position" = v.position
      FROM unnest(${order}::text[], ${positions}::int[]) AS v(id, position)
      WHERE p.id = v.id AND p."position" <> v.position`;
  });
}
