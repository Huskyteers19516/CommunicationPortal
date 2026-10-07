// Meeting categories (Meeting recaps → Categories, and "New category" in the recap form): one team-wide list of the
// kinds of meeting (Whole team, Leadership, Build, …), kept by everyone with admin access (canManageMeetingRecaps).
// Names are unique ignoring case (nameKey), at most MEETING_CATEGORIES_MAX of them; shown alphabetically. Deleting
// one takes it off its recaps (the join rows cascade); the recaps stay.
//
// Writes take one advisory lock ("hk-meeting-categories"), so the duplicate check and the cap are exact.
import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import { MEETING_CATEGORIES_MAX } from "@/lib/meeting-recaps";
import { idSchema } from "@/lib/validation";
import { parseInput } from "../action";
import type { ServiceContext } from "../context";
import { ForbiddenError, NotFoundError, RateLimitError, ValidationError } from "../errors";
import { canManageMeetingRecaps } from "../permissions";
import { consumeRateLimit } from "../rate-limit";
import { categoryNameKey, categoryNameSchema } from "./categories";

type Tx = Prisma.TransactionClient;

/** Category changes (adds, renames, deletes) per person per hour. */
export const MEETING_CATEGORY_RATE_LIMIT = { limit: 60, windowMs: 60 * 60 * 1000 } as const;

export const MEETING_CATEGORY_FORBIDDEN = "Only people with admin access can change the meeting categories.";
export const MEETING_CATEGORY_NOT_FOUND = "That category was already deleted.";
export const MEETING_CATEGORIES_FULL = `There are already ${MEETING_CATEGORIES_MAX} meeting categories. Delete one you don't use first.`;

/** "There's already a category called “Build”." */
export function meetingCategoryDuplicateMessage(existingName: string): string {
  return `There's already a category called “${existingName}”.`;
}

const createInput = z.object({ name: categoryNameSchema() });
const renameInput = z.object({ categoryId: idSchema, name: categoryNameSchema() });
const idInput = z.object({ categoryId: idSchema });

function asRecord(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

function assertCanManage(ctx: ServiceContext): void {
  if (ctx.actor.status !== "ACTIVE" || !canManageMeetingRecaps(ctx.actor)) throw new ForbiddenError(MEETING_CATEGORY_FORBIDDEN);
}

async function limitChanges(ctx: ServiceContext): Promise<void> {
  const { limit, windowMs } = MEETING_CATEGORY_RATE_LIMIT;
  if (!(await consumeRateLimit(ctx.db, `meeting-category:${ctx.actor.id}`, limit, windowMs, ctx.now))) {
    throw new RateLimitError("You've changed the meeting categories a lot in the last hour. Please wait a bit and try again.");
  }
}

/** One writer at a time, until the transaction ends. */
async function lockCategories(tx: Tx): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('hk-meeting-categories'))`;
}

function duplicate(existingName: string): ValidationError {
  const message = meetingCategoryDuplicateMessage(existingName);
  return new ValidationError(message, { name: message });
}

function isUniqueViolation(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
}

/** Add a category to the team's list. Returns its id and name as saved (spaces tidied). */
export async function createMeetingCategory(ctx: ServiceContext, raw: unknown): Promise<{ id: string; name: string }> {
  assertCanManage(ctx);
  const { name } = parseInput(createInput, asRecord(raw));
  const nameKey = categoryNameKey(name);
  await limitChanges(ctx);
  try {
    return await ctx.db.$transaction(async (tx) => {
      await lockCategories(tx);
      const clash = await tx.meetingCategory.findUnique({ where: { nameKey }, select: { name: true } });
      if (clash) throw duplicate(clash.name);
      if ((await tx.meetingCategory.count()) >= MEETING_CATEGORIES_MAX) {
        throw new ValidationError(MEETING_CATEGORIES_FULL, { name: MEETING_CATEGORIES_FULL });
      }
      return tx.meetingCategory.create({
        data: { name, nameKey, createdById: ctx.actor.id, createdAt: ctx.now, updatedAt: ctx.now },
        select: { id: true, name: true },
      });
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw duplicate(name);
    throw e;
  }
}

/** Rename a category (changing only the capitalization is fine). `changed` is false when the name stayed the same. */
export async function renameMeetingCategory(ctx: ServiceContext, raw: unknown): Promise<{ id: string; name: string; changed: boolean }> {
  assertCanManage(ctx);
  const { categoryId, name } = parseInput(renameInput, asRecord(raw));
  const nameKey = categoryNameKey(name);
  const current = await ctx.db.meetingCategory.findUnique({ where: { id: categoryId }, select: { name: true } });
  if (!current) throw new NotFoundError(MEETING_CATEGORY_NOT_FOUND);
  if (current.name === name) return { id: categoryId, name, changed: false };
  await limitChanges(ctx);
  try {
    await ctx.db.$transaction(async (tx) => {
      await lockCategories(tx);
      const clash = await tx.meetingCategory.findFirst({ where: { nameKey, id: { not: categoryId } }, select: { name: true } });
      if (clash) throw duplicate(clash.name);
      const { count } = await tx.meetingCategory.updateMany({ where: { id: categoryId }, data: { name, nameKey, updatedAt: ctx.now } });
      if (count === 0) throw new NotFoundError(MEETING_CATEGORY_NOT_FOUND);
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw duplicate(name);
    throw e;
  }
  return { id: categoryId, name, changed: true };
}

/** Delete a category. Its recaps stay, without it. `recaps` = how many recaps had it. */
export async function deleteMeetingCategory(ctx: ServiceContext, raw: unknown): Promise<{ id: string; name: string; recaps: number }> {
  assertCanManage(ctx);
  const { categoryId } = parseInput(idInput, asRecord(raw));
  await limitChanges(ctx);
  return ctx.db.$transaction(async (tx) => {
    await lockCategories(tx);
    const category = await tx.meetingCategory.findUnique({
      where: { id: categoryId },
      select: { name: true, _count: { select: { recaps: true } } },
    });
    if (!category) throw new NotFoundError(MEETING_CATEGORY_NOT_FOUND);
    await tx.meetingCategory.delete({ where: { id: categoryId } });
    return { id: categoryId, name: category.name, recaps: category._count.recaps };
  });
}
