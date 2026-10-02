// Signing yourself up for a task from the Task dashboard, and leaving it again.
//
// Sign-ups take a row lock on the task (SELECT … FOR UPDATE) before counting who's on it, so two people
// racing for the last spot can't both get it. Leaders editing the task take the same lock (updateTask).
// A task marked finished takes no sign-ups and nobody leaves it (leaving locks the row too, FOR SHARE).
import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import { SUBTEAM_LABELS } from "@/lib/constants";
import { dbToDateOnly, todayInTimezone } from "@/lib/dates";
import { idSchema } from "@/lib/validation";
import { parseInput } from "../action";
import type { ServiceContext } from "../context";
import { ConflictError, ForbiddenError, NotFoundError, RateLimitError } from "../errors";
import { canSignUpForTask } from "../permissions";
import { consumeRateLimit } from "../rate-limit";

/** Sign-ups per person per hour. Plenty for real use; stops scripted sign-up/leave loops. */
export const SIGNUP_RATE_LIMIT = { limit: 30, windowMs: 60 * 60 * 1000 } as const;

const TASK_NOT_FOUND = "That task no longer exists.";
const ALREADY_ON_IT = "You're already on this task.";
const FINISHED = "This task is finished, so sign-ups are closed.";

const taskIdInput = z.object({ taskId: idSchema });

function asRecord(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
}

function requireActive(ctx: ServiceContext) {
  if (ctx.actor.status !== "ACTIVE") throw new ForbiddenError("Your account isn't active.");
}

/** Put yourself on a sign-up task: it lands on your checklist as a TODO item. */
export async function signUpForTask(ctx: ServiceContext, raw: unknown): Promise<void> {
  requireActive(ctx);
  const { taskId } = parseInput(taskIdInput, asRecord(raw));

  const allowed = await consumeRateLimit(ctx.db, `signup:${ctx.actor.id}`, SIGNUP_RATE_LIMIT.limit, SIGNUP_RATE_LIMIT.windowMs, ctx.now);
  if (!allowed) throw new RateLimitError("You've signed up for a lot of tasks in the last hour. Please wait a bit and try again.");

  const today = todayInTimezone(ctx.config.teamTimezone, ctx.now);
  try {
    await ctx.db.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Task" WHERE id = ${taskId} FOR UPDATE`;
      if (locked.length === 0) throw new NotFoundError(TASK_NOT_FOUND);
      const task = await tx.task.findUnique({
        where: { id: taskId },
        select: {
          id: true,
          subteam: true,
          signupOpen: true,
          signupLimit: true,
          dueDate: true,
          completedAt: true,
          assignments: { select: { userId: true } },
        },
      });
      if (!task) throw new NotFoundError(TASK_NOT_FOUND);

      if (task.completedAt) throw new ConflictError(FINISHED);
      if (!canSignUpForTask(ctx.actor, task)) {
        throw new ForbiddenError(
          !task.signupOpen
            ? "Sign-ups for this task are closed."
            : `This task is for the ${task.subteam ? SUBTEAM_LABELS[task.subteam] : "whole"} subteam.`,
        );
      }
      if (dbToDateOnly(task.dueDate) < today) throw new ConflictError("This task's due date has passed.");
      if (task.assignments.some((a) => a.userId === ctx.actor.id)) throw new ConflictError(ALREADY_ON_IT);
      if (task.signupLimit !== null && task.assignments.length >= task.signupLimit) {
        throw new ConflictError("This task is full.");
      }

      await tx.taskAssignment.create({
        data: { taskId: task.id, userId: ctx.actor.id, selfAssigned: true },
        select: { id: true },
      });
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError) {
      if (e.code === "P2002") throw new ConflictError(ALREADY_ON_IT);
      if (e.code === "P2003" || e.code === "P2025") throw new NotFoundError(TASK_NOT_FOUND);
    }
    throw e;
  }
}

/**
 * Take yourself off a task you signed up for, as long as you haven't checked it off yet and the task isn't
 * marked finished. Tasks a leader assigned you stay put — ask the leader.
 */
export async function leaveTask(ctx: ServiceContext, raw: unknown): Promise<void> {
  requireActive(ctx);
  const { taskId } = parseInput(taskIdInput, asRecord(raw));

  const count = await ctx.db.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ completedAt: Date | null }[]>`
      SELECT "completedAt" FROM "Task" WHERE id = ${taskId} FOR SHARE`;
    if (locked[0]?.completedAt) {
      const mine = await tx.taskAssignment.count({ where: { taskId, userId: ctx.actor.id } });
      if (mine > 0) throw new ConflictError("This task is finished, so you can't leave it.");
    }
    const { count } = await tx.taskAssignment.deleteMany({
      where: { taskId, userId: ctx.actor.id, selfAssigned: true, status: "TODO" },
    });
    return count;
  });
  if (count > 0) return;

  // Nothing matched: work out why.
  const mine = await ctx.db.taskAssignment.findUnique({
    where: { taskId_userId: { taskId, userId: ctx.actor.id } },
    select: { status: true, selfAssigned: true },
  });
  if (!mine) throw new NotFoundError("You're not on this task.");
  if (!mine.selfAssigned) {
    throw new ForbiddenError("A leader assigned you this task — ask them if you need to drop it.");
  }
  switch (mine.status) {
    case "SUBMITTED":
      throw new ConflictError("You already checked this off. Uncheck it on your checklist first if you want to leave.");
    case "APPROVED":
      throw new ConflictError("This task is already approved, so you can't leave it.");
    default:
      throw new ConflictError("A leader already reviewed your work on this task — ask them if you need to drop it.");
  }
}
