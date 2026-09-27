// Questions: members (or anyone) ask leaders; staff reply; the thread moves OPEN <-> ANSWERED -> RESOLVED.
//
//   OPEN ──staff reply──▶ ANSWERED ──asker follow-up──▶ OPEN
//     └──────resolve (asker or staff)──────▶ RESOLVED ──reopen──▶ OPEN
//   Any reply to a RESOLVED question reopens it (OPEN if the asker wrote, ANSWERED if staff did).

import { z } from "zod";
import type { QuestionStatus, Subteam } from "@/generated/prisma/enums";
import { LIMITS } from "@/lib/constants";
import { text } from "@/lib/validation";
import type { Actor } from "../actor";
import { parseInput } from "../action";
import type { ServiceContext } from "../context";
import { ConflictError, ForbiddenError, NotFoundError, RateLimitError, ValidationError } from "../errors";
import {
  canBeQuestionRecipient,
  canChangeQuestionStatus,
  canReplyToQuestion,
  canViewQuestion,
} from "../permissions";
import { consumeRateLimit } from "../rate-limit";

// ── Rate limits ────────────────────────────────────────────────────────────────

const HOUR_MS = 60 * 60 * 1000;

/**
 * Per-user throttles. Every question and reply emails someone, so a runaway script (or a bored teammate)
 * can't flood leaders' inboxes or use up the SMTP sending quota. Generous enough that nobody hits them by hand.
 */
export const QUESTION_RATE_LIMITS = {
  ask: { limit: 20, windowMs: HOUR_MS },
  reply: { limit: 60, windowMs: HOUR_MS },
} as const;

async function throttle(ctx: ServiceContext, kind: keyof typeof QUESTION_RATE_LIMITS, message: string) {
  const { limit, windowMs } = QUESTION_RATE_LIMITS[kind];
  if (!(await consumeRateLimit(ctx.db, `${kind}:${ctx.actor.id}`, limit, windowMs, ctx.now))) {
    throw new RateLimitError(message);
  }
}

// ── Input schemas ──────────────────────────────────────────────────────────────

const emptyToUndefined = (v: unknown) => (v === "" || v === null ? undefined : v);

/** An optional id coming from a form select ("" = none). */
function optionalId(message: string) {
  return z.preprocess(
    emptyToUndefined,
    z.string({ error: message }).trim().min(1, message).max(64, message).optional(),
  );
}

const questionIdSchema = z
  .string({ error: "That question no longer exists." })
  .trim()
  .min(1, "That question no longer exists.")
  .max(64, "That question no longer exists.");

const askInput = z.object({
  title: text("Title", LIMITS.questionTitleMax),
  body: z
    .string({ error: "Add a few details so your leaders can help." })
    .trim()
    .min(1, "Add a few details so your leaders can help.")
    .max(LIMITS.questionBodyMax, `Keep the details under ${LIMITS.questionBodyMax} characters.`),
  to: z.preprocess(
    emptyToUndefined,
    z.enum(["subteam", "person"], { error: "Choose who should answer." }).default("subteam"),
  ),
  recipientId: optionalId("Choose who should answer."),
  /** "" = whole team (goes to the captain). Missing = the asker's own subteam. */
  subteam: z.enum(["SOFTWARE", "BUILD", "BUSINESS", ""], { error: "Pick a topic from the list." }).optional(),
  taskId: optionalId("Pick a task from the list."),
});

const replyInput = z.object({
  questionId: questionIdSchema,
  body: z
    .string({ error: "Write a reply first." })
    .trim()
    .min(1, "Write a reply first.")
    .max(LIMITS.replyBodyMax, `Replies must be at most ${LIMITS.replyBodyMax} characters.`),
});

const statusInput = z.object({
  questionId: questionIdSchema,
  status: z.enum(["RESOLVED", "OPEN"], { error: "Pick a valid status." }),
});

const deleteInput = z.object({ questionId: questionIdSchema });

// ── Helpers ────────────────────────────────────────────────────────────────────

function asRecord(raw: unknown): FormData | Record<string, unknown> {
  if (raw instanceof FormData) return raw;
  return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
}

function fieldError(field: string, message: string): ValidationError {
  return new ValidationError(message, { [field]: message });
}

function assertActive(actor: Actor) {
  if (actor.status !== "ACTIVE") throw new ForbiddenError("Your account isn't active yet.");
}

const questionAccessSelect = {
  id: true,
  askerId: true,
  recipientId: true,
  subteam: true,
  status: true,
} as const;

/** Load a question the actor can see, else NotFound (never reveal that it exists). */
async function loadVisibleQuestion(ctx: ServiceContext, questionId: string) {
  const q = await ctx.db.question.findUnique({ where: { id: questionId }, select: questionAccessSelect });
  if (!q || !canViewQuestion(ctx.actor, q)) throw new NotFoundError("That question doesn't exist or was deleted.");
  return q;
}

// ── Services ───────────────────────────────────────────────────────────────────

/**
 * Ask a question. Any ACTIVE user may ask.
 * - to="subteam": goes to the leaders of `subteam` (default: the asker's subteam; "" = whole team → captains).
 * - to="person": goes to `recipientId`, who must be ACTIVE staff and not the asker.
 * - taskId (optional): any existing task (everyone can see every task on the Task dashboard).
 */
export async function askQuestion(ctx: ServiceContext, raw: unknown): Promise<{ id: string }> {
  const data = parseInput(askInput, asRecord(raw));
  const actor = ctx.actor;
  assertActive(actor);

  const subteam: Subteam | null =
    data.subteam === undefined ? actor.subteam : data.subteam === "" ? null : data.subteam;

  if (data.to === "person") {
    if (!data.recipientId) throw fieldError("recipientId", "Choose who should answer.");
    if (data.recipientId === actor.id) throw fieldError("recipientId", "You can't send a question to yourself.");
  }

  const [recipient, task] = await Promise.all([
    data.to === "person" && data.recipientId
      ? ctx.db.user.findUnique({
          where: { id: data.recipientId },
          select: { id: true, role: true, status: true, isAdmin: true },
        })
      : null,
    data.taskId
      ? ctx.db.task.findUnique({
          where: { id: data.taskId },
          select: { id: true },
        })
      : null,
  ]);

  let recipientId: string | null = null;
  if (data.to === "person") {
    if (!recipient || !canBeQuestionRecipient(recipient)) {
      throw fieldError("recipientId", "Pick a leader, mentor, or teacher from the list.");
    }
    recipientId = recipient.id;
  }

  // Any task will do: the whole team can see every task on the Task dashboard.
  if (data.taskId && !task) throw fieldError("taskId", "That task no longer exists.");

  // Counted only once the question is valid, so fixing a typo never uses up the allowance.
  await throttle(ctx, "ask", "You've asked a lot of questions in the last hour. Please wait a bit before asking another.");

  const question = await ctx.db.question.create({
    data: {
      title: data.title,
      body: data.body,
      askerId: actor.id,
      recipientId,
      subteam,
      taskId: task?.id ?? null,
      status: "OPEN",
      lastActivityAt: ctx.now,
      createdAt: ctx.now,
    },
    select: { id: true },
  });

  ctx.notifier.notify({ type: "question.asked", questionId: question.id });
  return { id: question.id };
}

/**
 * Post in a question thread. The asker's follow-ups make it OPEN again (waiting on staff);
 * a staff answer makes it ANSWERED (waiting on the asker).
 *
 * `lastActivityAt` orders the staff inbox (Open = oldest first), so it only moves when the question's
 * turn changes: staff answers and follow-ups that reopen it. An asker adding detail to a question that is
 * still waiting keeps its place in the queue instead of going to the back.
 */
export async function replyToQuestion(ctx: ServiceContext, raw: unknown): Promise<{ replyId: string }> {
  const data = parseInput(replyInput, asRecord(raw));
  assertActive(ctx.actor);

  const q = await loadVisibleQuestion(ctx, data.questionId);
  if (!canReplyToQuestion(ctx.actor, q)) throw new ForbiddenError("You can't reply to this question.");

  await throttle(ctx, "reply", "You've posted a lot of replies in the last hour. Please wait a bit before sending another.");

  const byAsker = q.askerId === ctx.actor.id;
  const status: QuestionStatus = byAsker ? "OPEN" : "ANSWERED";

  const reply = await ctx.db.$transaction(async (tx) => {
    // Conditional on the status so a staff answer that lands meanwhile still counts as a status change.
    let updated =
      byAsker && q.status === "OPEN"
        ? await tx.question.updateMany({ where: { id: q.id, status: "OPEN" }, data: { status } })
        : { count: 0 };
    if (updated.count === 0) {
      updated = await tx.question.updateMany({ where: { id: q.id }, data: { status, lastActivityAt: ctx.now } });
    }
    if (updated.count === 0) throw new NotFoundError("That question was just deleted.");
    return tx.questionReply.create({
      data: { questionId: q.id, authorId: ctx.actor.id, body: data.body, createdAt: ctx.now },
      select: { id: true },
    });
  });

  ctx.notifier.notify({ type: "question.replied", questionId: q.id, replyId: reply.id });
  return { replyId: reply.id };
}

/** Mark resolved (from OPEN/ANSWERED) or reopen (from RESOLVED). Asker or staff who can see it. */
export async function setQuestionStatus(
  ctx: ServiceContext,
  raw: unknown,
): Promise<{ status: "RESOLVED" | "OPEN" }> {
  const data = parseInput(statusInput, asRecord(raw));
  assertActive(ctx.actor);

  const q = await loadVisibleQuestion(ctx, data.questionId);
  if (!canChangeQuestionStatus(ctx.actor, q)) throw new ForbiddenError("You can't change the status of this question.");

  const from: QuestionStatus[] = data.status === "RESOLVED" ? ["OPEN", "ANSWERED"] : ["RESOLVED"];
  const updated = await ctx.db.question.updateMany({
    where: { id: q.id, status: { in: from } },
    // Reopening puts it back in the queue, so it counts as fresh activity.
    data: data.status === "OPEN" ? { status: "OPEN", lastActivityAt: ctx.now } : { status: "RESOLVED" },
  });
  if (updated.count === 0) {
    throw new ConflictError(
      data.status === "RESOLVED" ? "This question is already resolved." : "This question is already open.",
    );
  }
  return { status: data.status };
}

/** The asker may delete their question until someone replies. Admins may delete any question. */
export async function deleteQuestion(ctx: ServiceContext, raw: unknown): Promise<{ id: string }> {
  const data = parseInput(deleteInput, asRecord(raw));
  const actor = ctx.actor;
  assertActive(actor);

  const q = await loadVisibleQuestion(ctx, data.questionId);
  if (!actor.isAdmin && q.askerId !== actor.id) throw new ForbiddenError("Only the person who asked can delete this question.");

  // Remember where it was posted in the leaders' Discord channel, so those copies can be removed too.
  const posted = await ctx.db.question.findUnique({
    where: { id: q.id },
    select: { discordMessageIds: true, replies: { select: { discordMessageIds: true } } },
  });
  const discordMessageIds = [...(posted?.discordMessageIds ?? []), ...(posted?.replies.flatMap((r) => r.discordMessageIds) ?? [])];

  if (actor.isAdmin) {
    await ctx.db.question.deleteMany({ where: { id: q.id } });
  } else {
    const hasReplies = "This question already has replies, so it can't be deleted. Mark it as resolved instead.";
    const deleted = await ctx.db.question.deleteMany({
      where: { id: q.id, askerId: actor.id, replies: { none: {} } },
    });
    if (deleted.count === 0) throw new ConflictError(hasReplies);
  }
  if (discordMessageIds.length) ctx.notifier.notify({ type: "question.deleted", questionId: q.id, discordMessageIds });
  return { id: q.id };
}
