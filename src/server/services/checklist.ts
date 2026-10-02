// Member side of the checklist: check an item off (submit it for review), uncheck it
// (withdraw before review), and edit the note sent along with a submission.
// Only the assignee may act on their own assignment. Anything else looks like "not found".
// Checking off is throttled per person, because every check-off emails a leader.
// Once a leader marks the whole task finished, its items can't be changed from here anymore: every write first
// locks the task's row (FOR SHARE), so "Mark task finished" (FOR UPDATE) can't land between the check and the write.

import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { TASK_FINISHED_CODES } from "@/lib/action-state";
import { LIMITS } from "@/lib/constants";
import { idSchema, optionalText } from "@/lib/validation";
import { parseInput } from "../action";
import type { ServiceContext } from "../context";
import { allowedFrom, nextStatus } from "../domain/assignment";
import { ConflictError, NotFoundError, RateLimitError } from "../errors";
import { consumeRateLimit } from "../rate-limit";

/**
 * Check-offs per person per hour. Each one emails a leader, so this caps how many emails one account
 * can cause (e.g. a scripted check/uncheck loop). A real day's list — even with a few
 * uncheck/re-check corrections — stays far below it.
 */
export const SUBMIT_RATE_LIMIT = { limit: 60, windowMs: 60 * 60 * 1000 } as const;

const submitInput = z.object({
  assignmentId: idSchema,
  note: optionalText("Note", LIMITS.noteMax),
});

const withdrawInput = z.object({
  assignmentId: idSchema,
});

const noteInput = z.object({
  assignmentId: idSchema,
  note: optionalText("Note", LIMITS.noteMax),
});

const NOT_FOUND = "That checklist item no longer exists.";

type Tx = Prisma.TransactionClient;

function asRecord(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
}

/**
 * Called after a conditional write matched nothing: works out whether the item is missing
 * (or not the actor's — same answer, so we don't leak it) or just in the wrong state.
 */
async function currentOwnStatus(ctx: ServiceContext, tx: Tx, assignmentId: string) {
  const row = await tx.taskAssignment.findFirst({
    where: { id: assignmentId, userId: ctx.actor.id },
    select: { status: true },
  });
  if (!row) throw new NotFoundError(NOT_FOUND);
  return row.status;
}

/**
 * How it ended for the member, e.g. "Marcus Johnson marked the whole task finished — it counts as done for you."
 * Not a failure from their side (they may even have got the credit), so the checklist shows it as a status line.
 */
export function taskFinishedMessage(
  actorId: string,
  item: { approved: boolean; checkedOff: boolean; finishedById: string | null; finishedByName: string | null },
): string {
  const who = item.finishedById === actorId ? "You" : (item.finishedByName ?? "A leader");
  const outcome = item.approved
    ? "it counts as done for you"
    : item.checkedOff
      ? "your check-off wasn't approved in time, so it doesn't count"
      : "it was closed without credit";
  return `${who} marked the whole task finished — ${outcome}.`;
}

/**
 * Run `write` in a transaction after locking the item's task row (FOR SHARE). The item must be the actor's
 * (else NotFound) and its task not marked finished (else a ConflictError with a TASK_FINISHED_CODES code that says how the
 * item ended up — the checklist shows it as a status line, not an error).
 */
async function onOwnOpenItem<T>(ctx: ServiceContext, assignmentId: string, write: (tx: Tx) => Promise<T>): Promise<T> {
  return ctx.db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<
      { status: string; completedAt: Date | null; completedById: string | null; completedByName: string | null }[]
    >`
      SELECT a.status::text AS status, t."completedAt", t."completedById", u.name AS "completedByName"
      FROM "TaskAssignment" a
        JOIN "Task" t ON t.id = a."taskId"
        LEFT JOIN "User" u ON u.id = t."completedById"
      WHERE a.id = ${assignmentId} AND a."userId" = ${ctx.actor.id}
      FOR SHARE OF t`;
    if (rows.length === 0) throw new NotFoundError(NOT_FOUND);
    const row = rows[0];
    if (row.completedAt) {
      const message = taskFinishedMessage(ctx.actor.id, {
        approved: row.status === "APPROVED",
        checkedOff: row.status === "SUBMITTED",
        finishedById: row.completedById,
        finishedByName: row.completedByName,
      });
      throw new ConflictError(message, row.status === "APPROVED" ? TASK_FINISHED_CODES.counted : TASK_FINISHED_CODES.closed);
    }
    return write(tx);
  });
}

/** Check an item off: TODO | REJECTED -> SUBMITTED, with an optional note. A reviewer is notified (the note goes in the email). */
export async function submitAssignment(ctx: ServiceContext, raw: unknown): Promise<void> {
  const { assignmentId, note } = parseInput(submitInput, asRecord(raw));

  const allowed = await consumeRateLimit(
    ctx.db,
    `submit:${ctx.actor.id}`,
    SUBMIT_RATE_LIMIT.limit,
    SUBMIT_RATE_LIMIT.windowMs,
    ctx.now,
  );
  if (!allowed) {
    throw new RateLimitError("You've checked off a lot of items in the last hour. Please wait a few minutes and try again.");
  }

  await onOwnOpenItem(ctx, assignmentId, async (tx) => {
    const { count } = await tx.taskAssignment.updateMany({
      where: { id: assignmentId, userId: ctx.actor.id, status: { in: allowedFrom("submit") } },
      // reviewNote is kept on purpose so reviewers can see the earlier feedback.
      data: { status: nextStatus("submit"), submittedAt: ctx.now, submissionNote: note ?? null },
    });
    if (count === 0) {
      await currentOwnStatus(ctx, tx, assignmentId);
      throw new ConflictError("This item was already submitted or approved.");
    }
  });

  ctx.notifier.notify({ type: "task.submitted", assignmentId });
}

/** Uncheck an item before a leader reviews it: SUBMITTED -> TODO. */
export async function withdrawAssignment(ctx: ServiceContext, raw: unknown): Promise<void> {
  const { assignmentId } = parseInput(withdrawInput, asRecord(raw));

  await onOwnOpenItem(ctx, assignmentId, async (tx) => {
    const { count } = await tx.taskAssignment.updateMany({
      where: { id: assignmentId, userId: ctx.actor.id, status: { in: allowedFrom("withdraw") } },
      data: { status: nextStatus("withdraw"), submittedAt: null, submissionNote: null },
    });
    if (count === 0) {
      const status = await currentOwnStatus(ctx, tx, assignmentId);
      if (status === "TODO") throw new ConflictError("This item is already unchecked.");
      throw new ConflictError("A leader already reviewed this item.");
    }
  });
}

/** Add, change, or clear (empty string) the note on a submission that is still waiting for review. */
export async function updateSubmissionNote(ctx: ServiceContext, raw: unknown): Promise<void> {
  const { assignmentId, note } = parseInput(noteInput, asRecord(raw));

  await onOwnOpenItem(ctx, assignmentId, async (tx) => {
    const { count } = await tx.taskAssignment.updateMany({
      where: { id: assignmentId, userId: ctx.actor.id, status: "SUBMITTED" },
      data: { submissionNote: note ?? null },
    });
    if (count === 0) {
      await currentOwnStatus(ctx, tx, assignmentId);
      throw new ConflictError("You can only edit the note while the item is waiting for review.");
    }
  });
}
