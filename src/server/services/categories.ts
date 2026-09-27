// Task categories: the kinds of job inside a subteam (Build → Intake, Drivetrain, CAD…), shown as groups on
// the Task dashboard. Leaders manage their own subteam's list; captain/mentors/teachers/admins manage every
// list, including the whole-team one (subteam null).
//
// Writes to one subteam's list are serialized with a transaction-scoped advisory lock, because the
// unique index on (subteam, nameKey) can't catch duplicates in the whole-team list (Postgres treats
// NULL subteams as distinct) and the per-subteam cap is a count check.
import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import type { Subteam } from "@/generated/prisma/enums";
import { LIMITS, SUBTEAM_LABELS } from "@/lib/constants";
import { idSchema } from "@/lib/validation";
import { parseInput } from "../action";
import type { Actor } from "../actor";
import type { ServiceContext } from "../context";
import { ForbiddenError, NotFoundError, RateLimitError, ValidationError } from "../errors";
import { canManageCategories, hasAllScope, isStaff } from "../permissions";
import { consumeRateLimit } from "../rate-limit";

type ActorLike = Pick<Actor, "id" | "role" | "subteam" | "isAdmin" | "status">;
type Tx = Prisma.TransactionClient;

/** New categories per person per hour (the per-subteam cap keeps the lists short anyway). */
export const CATEGORY_RATE_LIMIT = { limit: 60, windowMs: 60 * 60 * 1000 } as const;

const CATEGORY_NOT_FOUND = "That category no longer exists.";
const STAFF_ONLY = "Only leaders, the captain, mentors, and teachers can manage categories.";

// ---------- names ----------

/** Trim and collapse runs of whitespace ("  CAD   &  Design " -> "CAD & Design"). */
export function normalizeCategoryName(name: string): string {
  return name.replace(/\s+/g, " ").trim();
}

/** Lower-cased key used for "no duplicates in one subteam" (case-insensitive). */
export function categoryNameKey(name: string): string {
  return normalizeCategoryName(name).toLowerCase();
}

/** Zod schema for a category name (normalized, 1..LIMITS.categoryNameMax characters). */
export function categoryNameSchema(label = "Name") {
  return z
    .string({ error: `${label} is required.` })
    .transform(normalizeCategoryName)
    .pipe(
      z
        .string()
        .min(1, `${label} is required.`)
        .max(LIMITS.categoryNameMax, `${label} must be at most ${LIMITS.categoryNameMax} characters.`),
    );
}

/** "in Build" / "for the whole team". */
function wherePhrase(subteam: Subteam | null): string {
  return subteam ? `in ${SUBTEAM_LABELS[subteam]}` : "for the whole team";
}

function listLabel(subteam: Subteam | null): string {
  return subteam ? SUBTEAM_LABELS[subteam] : "The whole-team list";
}

function duplicateMessage(existingName: string, subteam: Subteam | null): string {
  const article = /^[aeiou]/i.test(existingName) ? "an" : "a";
  return `There's already ${article} “${existingName}” category ${wherePhrase(subteam)}.`;
}

// ---------- input schemas ----------

const subteamField = z
  .preprocess(
    (v) => (v === undefined || v === null ? "" : v),
    z.enum(["", "SOFTWARE", "BUILD", "BUSINESS"], { error: "Pick a subteam." }),
  )
  .transform((v): Subteam | null => (v === "" ? null : v));

const createInput = z.object({ subteam: subteamField, name: categoryNameSchema() });
const renameInput = z.object({ categoryId: idSchema, name: categoryNameSchema() });
const categoryIdInput = z.object({ categoryId: idSchema });
const moveInput = z.object({
  categoryId: idSchema,
  direction: z.enum(["up", "down"], { error: "Pick up or down." }),
});

function asRecord(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
}

// ---------- permission helpers ----------

function requireActiveStaff(actor: ActorLike) {
  if (actor.status !== "ACTIVE" || !isStaff(actor)) throw new ForbiddenError(STAFF_ONLY);
}

function assertCanManage(actor: ActorLike, subteam: Subteam | null) {
  requireActiveStaff(actor);
  if (canManageCategories(actor, subteam)) return;
  if (subteam === null && !hasAllScope(actor)) {
    throw new ForbiddenError("Only the captain, mentors, and teachers can change whole-team categories.");
  }
  throw new ForbiddenError("You can only change your own subteam's categories.");
}

/** Load a category the actor may manage. Missing or someone else's → NotFound (so ids don't leak). */
async function loadManagedCategory(ctx: ServiceContext, categoryId: string) {
  requireActiveStaff(ctx.actor);
  const category = await ctx.db.taskCategory.findUnique({
    where: { id: categoryId },
    select: { id: true, subteam: true, name: true, nameKey: true },
  });
  if (!category || !canManageCategories(ctx.actor, category.subteam)) throw new NotFoundError(CATEGORY_NOT_FOUND);
  return category;
}

// ---------- shared transaction steps ----------

/** Serialize writes to one subteam's list until the transaction ends. */
async function lockList(tx: Tx, subteam: Subteam | null): Promise<void> {
  const key = `task-categories:${subteam ?? "TEAM"}`;
  await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext(${key}))`;
}

async function findByKey(tx: Tx, subteam: Subteam | null, nameKey: string) {
  return tx.taskCategory.findFirst({ where: { subteam, nameKey }, select: { id: true, name: true } });
}

/** Insert a new category at the end of its list. Call with the list locked and after the duplicate check. */
async function insertCategory(
  tx: Tx,
  actor: ActorLike,
  subteam: Subteam | null,
  name: string,
  field: string,
): Promise<{ id: string }> {
  const agg = await tx.taskCategory.aggregate({ where: { subteam }, _count: { _all: true }, _max: { position: true } });
  if (agg._count._all >= LIMITS.categoriesPerSubteamMax) {
    const message = `${listLabel(subteam)} already has ${LIMITS.categoriesPerSubteamMax} categories. Delete one you don't use first.`;
    throw new ValidationError(message, { [field]: message });
  }
  return tx.taskCategory.create({
    data: {
      subteam,
      name,
      nameKey: name.toLowerCase(),
      position: (agg._max.position ?? -1) + 1,
      createdById: actor.id,
    },
    select: { id: true },
  });
}

function isUniqueViolation(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
}

/**
 * Inside a transaction: the category called `name` in `subteam` (case-insensitive), created at the end
 * of the list if it doesn't exist yet. Used by the task form's inline "New category…".
 * Errors are reported on `field` (default "newCategory"). The actor must be allowed to manage that list.
 */
export async function findOrCreateCategory(
  tx: Tx,
  actor: ActorLike,
  input: { subteam: Subteam | null; name: string },
  field = "newCategory",
): Promise<{ id: string; created: boolean }> {
  assertCanManage(actor, input.subteam);
  const name = normalizeCategoryName(input.name);
  if (!name || name.length > LIMITS.categoryNameMax) {
    const message = name ? `Category name must be at most ${LIMITS.categoryNameMax} characters.` : "Name the new category.";
    throw new ValidationError(message, { [field]: message });
  }
  await lockList(tx, input.subteam);
  const existing = await findByKey(tx, input.subteam, name.toLowerCase());
  if (existing) return { id: existing.id, created: false };
  const { id } = await insertCategory(tx, actor, input.subteam, name, field);
  return { id, created: true };
}

// ---------- services ----------

/** Add a category to the end of a subteam's list ("" = whole team). */
export async function createCategory(ctx: ServiceContext, raw: unknown): Promise<{ id: string }> {
  requireActiveStaff(ctx.actor);
  const data = parseInput(createInput, asRecord(raw));
  assertCanManage(ctx.actor, data.subteam);

  const allowed = await consumeRateLimit(
    ctx.db,
    `category:${ctx.actor.id}`,
    CATEGORY_RATE_LIMIT.limit,
    CATEGORY_RATE_LIMIT.windowMs,
    ctx.now,
  );
  if (!allowed) throw new RateLimitError("You've added a lot of categories in the last hour. Please wait a bit and try again.");

  try {
    return await ctx.db.$transaction(async (tx) => {
      await lockList(tx, data.subteam);
      const existing = await findByKey(tx, data.subteam, data.name.toLowerCase());
      if (existing) {
        const message = duplicateMessage(existing.name, data.subteam);
        throw new ValidationError(message, { name: message });
      }
      return insertCategory(tx, ctx.actor, data.subteam, data.name, "name");
    });
  } catch (e) {
    if (isUniqueViolation(e)) {
      const message = duplicateMessage(data.name, data.subteam);
      throw new ValidationError(message, { name: message });
    }
    throw e;
  }
}

/** Rename a category (changing only the capitalization is fine). */
export async function renameCategory(ctx: ServiceContext, raw: unknown): Promise<void> {
  requireActiveStaff(ctx.actor);
  const data = parseInput(renameInput, asRecord(raw));
  const category = await loadManagedCategory(ctx, data.categoryId);
  const nameKey = data.name.toLowerCase();

  try {
    await ctx.db.$transaction(async (tx) => {
      await lockList(tx, category.subteam);
      const clash = await tx.taskCategory.findFirst({
        where: { subteam: category.subteam, nameKey, id: { not: category.id } },
        select: { name: true },
      });
      if (clash) {
        const message = duplicateMessage(clash.name, category.subteam);
        throw new ValidationError(message, { name: message });
      }
      const { count } = await tx.taskCategory.updateMany({ where: { id: category.id }, data: { name: data.name, nameKey } });
      if (count === 0) throw new NotFoundError(CATEGORY_NOT_FOUND);
    });
  } catch (e) {
    if (isUniqueViolation(e)) {
      const message = duplicateMessage(data.name, category.subteam);
      throw new ValidationError(message, { name: message });
    }
    throw e;
  }
}

/** Delete a category. Its tasks stay, uncategorized (the foreign key sets their categoryId to null). */
export async function deleteCategory(ctx: ServiceContext, raw: unknown): Promise<void> {
  requireActiveStaff(ctx.actor);
  const { categoryId } = parseInput(categoryIdInput, asRecord(raw));
  const category = await loadManagedCategory(ctx, categoryId);
  await ctx.db.taskCategory.deleteMany({ where: { id: category.id } });
}

/** Move a category one place up or down in its list. At the top/bottom already: nothing changes. */
export async function moveCategory(ctx: ServiceContext, raw: unknown): Promise<void> {
  requireActiveStaff(ctx.actor);
  const data = parseInput(moveInput, asRecord(raw));
  const category = await loadManagedCategory(ctx, data.categoryId);

  await ctx.db.$transaction(async (tx) => {
    await lockList(tx, category.subteam);
    const siblings = await tx.taskCategory.findMany({
      where: { subteam: category.subteam },
      orderBy: [{ position: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      select: { id: true, position: true },
    });
    const from = siblings.findIndex((c) => c.id === category.id);
    if (from === -1) throw new NotFoundError(CATEGORY_NOT_FOUND);
    const to = data.direction === "up" ? from - 1 : from + 1;
    const order = siblings.map((c) => c.id);
    if (to >= 0 && to < order.length) [order[from], order[to]] = [order[to], order[from]];

    // Renumber 0..n-1 so gaps left by deletes disappear; only rows whose position changes are written.
    const current = new Map(siblings.map((c) => [c.id, c.position]));
    for (const [position, id] of order.entries()) {
      if (current.get(id) !== position) await tx.taskCategory.update({ where: { id }, data: { position }, select: { id: true } });
    }
  });
}
