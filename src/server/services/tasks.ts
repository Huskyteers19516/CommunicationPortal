// Task management + review (leader side): create/edit/delete tasks, mark a whole task finished (and reopen it),
// and approve / send back / reopen / remove checklist items. The member side (submit/withdraw) lives in the
// checklist service, and signing yourself up for a task from the Task dashboard lives in the signups service.
//
// A task is either assigned ("Assign people": the leader picks everyone) or a sign-up task
// ("Let people sign up": signupOpen, optionally capped at signupLimit people). Leaders can still
// pre-fill people on a sign-up task.
import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import type { Subteam } from "@/generated/prisma/enums";
import { LIMITS, SUBTEAM_LABELS } from "@/lib/constants";
import { addDays, dateOnlyToDb, dbToDateOnly, todayInTimezone } from "@/lib/dates";
import { checkbox, dateOnlySchema, idSchema, optionalText, stringArray, text } from "@/lib/validation";
import { NEW_CATEGORY } from "@/lib/task-form";
import { parseInput } from "../action";
import type { Actor } from "../actor";
import type { Db } from "../db";
import type { ServiceContext } from "../context";
import { allowedFrom, nextStatus } from "../domain/assignment";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../errors";
import {
  canAssignTo,
  canCreateTask,
  canManageCategories,
  canManageTask,
  canReviewAssignment,
  hasAllScope,
  isStaff,
} from "../permissions";
import { reviewQueueWhere } from "../scopes";
import { findOrCreateCategory, normalizeCategoryName } from "./categories";

/** How far back / ahead a due date may be set (in days, relative to today in the team timezone). */
export const DUE_DATE_MAX_PAST_DAYS = 30;
export const DUE_DATE_MAX_FUTURE_DAYS = 365;
export const MAX_ASSIGNEES = 150;
export const MAX_BULK_APPROVE = 200;

const TASK_NOT_FOUND = "That task no longer exists.";
const ITEM_NOT_FOUND = "That checklist item no longer exists.";
const ALREADY_REVIEWED = "This item was already reviewed or withdrawn. Refresh to see the latest.";
const OWN_ITEM = "You can't review your own checklist item. Ask another leader or the captain.";
const REMOVE_SELF = "You can't remove yourself from a task. Ask another leader or the captain.";
const PICK_PEOPLE = "Pick at least one person.";
const FINISHED_NO_NEW_PEOPLE = "This task is marked finished, so nobody new can be added. Reopen the task first.";
const NO_SEND_BACK_WHEN_FINISHED = "This task is marked finished, so it can't be sent back. Reopen the task first.";
const OWN_ITEM_WAITING =
  "Your own item is waiting for review. Ask another leader or the captain to approve it first, or choose “Just close it”.";
const WHOLE_TEAM_CREATORS = "the captain, mentors, teachers, and the Business leader";
const NOT_YOURS_TO_MAKE_WHOLE_TEAM =
  "Only whoever created this task, or the captain, mentors, and teachers, can make it whole-team.";

export { NEW_CATEGORY };

// ---------- input schemas ----------

const subteamField = z
  .preprocess(
    (v) => (v === undefined || v === null ? "" : v),
    z.enum(["", "SOFTWARE", "BUILD", "BUSINESS"], { error: "Pick a subteam." }),
  )
  .transform((v): Subteam | null => (v === "" ? null : v));

const priorityField = z.preprocess(
  (v) => (v === undefined || v === null || v === "" ? "NORMAL" : v),
  z.enum(["LOW", "NORMAL", "HIGH"], { error: "Pick a priority." }),
);

/** Everyone picked in the form. May be empty for sign-up tasks (checked after parsing). */
const assigneeIdsField = stringArray
  .transform((ids) => [...new Set(ids)])
  .pipe(z.array(z.string()).max(MAX_ASSIGNEES, `You can assign up to ${MAX_ASSIGNEES} people at once.`));

/** "" = no category, NEW_CATEGORY = create `newCategory`, anything else = a category id. */
const categoryIdField = z.preprocess(
  (v) => (v === undefined || v === null ? "" : v),
  z.string({ error: "Pick a category from the list." }).trim().max(64, "Pick a category from the list."),
);

const newCategoryField = z.preprocess(
  (v) => (typeof v === "string" ? normalizeCategoryName(v) || undefined : v),
  z
    .string()
    .max(LIMITS.categoryNameMax, `Category name must be at most ${LIMITS.categoryNameMax} characters.`)
    .optional(),
);

const assignModeField = z.preprocess(
  (v) => (v === undefined || v === null || v === "" ? "assign" : v),
  z.enum(["assign", "signup"], { error: "Choose who does this task." }),
);

const SPOTS_MESSAGE = `Enter 1 to ${LIMITS.signupLimitMax} spots, or leave it empty for no limit.`;

/** "" / missing = no limit (null); otherwise a whole number 1..LIMITS.signupLimitMax. */
const signupLimitField = z.preprocess(
  (v) => {
    if (v === undefined || v === null) return null;
    if (typeof v !== "string") return v;
    const s = v.trim();
    if (s === "") return null;
    return /^\d+$/.test(s) ? Number(s) : Number.NaN;
  },
  z
    .number({ error: SPOTS_MESSAGE })
    .int(SPOTS_MESSAGE)
    .min(1, SPOTS_MESSAGE)
    .max(LIMITS.signupLimitMax, SPOTS_MESSAGE)
    .nullable(),
);

const taskFields = {
  title: text("Title", LIMITS.taskTitleMax),
  description: optionalText("Description", LIMITS.taskDescriptionMax),
  subteam: subteamField,
  dueDate: dateOnlySchema,
  priority: priorityField,
  assigneeIds: assigneeIdsField,
  categoryId: categoryIdField,
  newCategory: newCategoryField,
  assignMode: assignModeField,
  signupLimit: signupLimitField,
};

const createInput = z.object(taskFields);
const updateInput = z.object({
  taskId: idSchema,
  ...taskFields,
  /**
   * The people the edit form was loaded with. Only used when `previousAssigneeIdsSent` is set (so an
   * empty list is distinguishable from "not sent"): people who signed up after the form loaded are
   * kept, and people who left meanwhile aren't re-added.
   */
  previousAssigneeIds: stringArray.transform((ids) => [...new Set(ids)]),
  previousAssigneeIdsSent: checkbox,
});
const taskIdInput = z.object({ taskId: idSchema });
const signupOpenInput = z.object({
  taskId: idSchema,
  open: z.preprocess(
    (v) => (v === true || v === "true" || v === "1" || v === "on" ? true : v === false || v === "false" || v === "0" ? false : v),
    z.boolean({ error: "Choose open or closed." }),
  ),
});
const assignmentIdInput = z.object({ assignmentId: idSchema });
const finishInput = z.object({
  taskId: idSchema,
  /** "everyone" = count it as done for everyone still on it; "none" = just close it (no credit). */
  credit: z.enum(["everyone", "none"], { error: "Choose whether it counts as done for everyone." }),
});

const reviewInput = z.object({
  assignmentId: idSchema,
  decision: z.enum(["approve", "reject"], { error: "Pick approve or send back." }),
  note: optionalText("Note", LIMITS.noteMax),
});

const approveManyInput = z.object({
  assignmentIds: stringArray
    .transform((ids) => [...new Set(ids)])
    .pipe(
      z
        .array(z.string())
        .min(1, "Pick at least one submission.")
        .max(MAX_BULK_APPROVE, `You can approve up to ${MAX_BULK_APPROVE} at once.`),
    ),
});

// ---------- helpers ----------

function requireStaff(actor: Actor) {
  if (!isStaff(actor)) throw new ForbiddenError("Only leaders, the captain, mentors, and teachers can manage tasks.");
}

function subteamForbidden(subteam: Subteam | null): ForbiddenError {
  if (subteam === null) return new ForbiddenError(`Only ${WHOLE_TEAM_CREATORS} can create whole-team tasks.`);
  return new ForbiddenError("You can only create tasks for your own subteam.");
}

function checkDueDate(ctx: ServiceContext, dueDate: string) {
  const today = todayInTimezone(ctx.config.teamTimezone, ctx.now);
  if (dueDate < addDays(today, -DUE_DATE_MAX_PAST_DAYS)) {
    throw new ValidationError("That due date is too far in the past.", {
      dueDate: `Pick a date no more than ${DUE_DATE_MAX_PAST_DAYS} days ago.`,
    });
  }
  if (dueDate > addDays(today, DUE_DATE_MAX_FUTURE_DAYS)) {
    throw new ValidationError("That due date is too far away.", { dueDate: "Pick a date within the next year." });
  }
}

function listNames(names: string[]): string {
  if (names.length <= 3) return names.join(", ");
  return `${names.slice(0, 3).join(", ")} and ${names.length - 3} more`;
}

/**
 * Every id must be an existing user the actor may put on a task of `subteam` (null = whole team).
 * Throws ValidationError on assigneeIds otherwise.
 */
async function assertAssignable(ctx: ServiceContext, userIds: string[], subteam: Subteam | null, db: Db | Tx = ctx.db) {
  if (userIds.length === 0) return;
  const users = await db.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, name: true, subteam: true, status: true },
  });
  const byId = new Map(users.map((u) => [u.id, u]));
  const missing = userIds.filter((id) => !byId.has(id));
  const inactive = users.filter((u) => u.status !== "ACTIVE").map((u) => u.name);
  const outOfScope = users.filter((u) => u.status === "ACTIVE" && !canAssignTo(ctx.actor, u, subteam));
  // The Business leader may put anyone on a whole-team task, just not on a Business task.
  const wholeTeamOnly = outOfScope.filter((u) => subteam !== null && canAssignTo(ctx.actor, u, null)).map((u) => u.name);
  const notInSubteam = outOfScope.filter((u) => subteam === null || !canAssignTo(ctx.actor, u, null)).map((u) => u.name);

  const problems: string[] = [];
  if (missing.length) problems.push(missing.length === 1 ? "1 person no longer exists" : `${missing.length} people no longer exist`);
  if (inactive.length) problems.push(`${listNames(inactive)} ${inactive.length === 1 ? "isn't" : "aren't"} active`);
  if (notInSubteam.length) {
    problems.push(`${listNames(notInSubteam)} ${notInSubteam.length === 1 ? "isn't" : "aren't"} in your subteam`);
  }
  if (wholeTeamOnly.length && subteam) {
    problems.push(
      `${listNames(wholeTeamOnly)} ${wholeTeamOnly.length === 1 ? "isn't" : "aren't"} in ${SUBTEAM_LABELS[subteam]} — make it a whole-team task to add them`,
    );
  }
  if (problems.length) {
    const message = `Can't assign this task: ${problems.join("; ")}.`;
    throw new ValidationError(message, { assigneeIds: message });
  }
}

const assignmentSelect = {
  id: true,
  userId: true,
  status: true,
  user: { select: { subteam: true } },
  task: { select: { id: true, createdById: true, subteam: true, completedAt: true } },
} satisfies Prisma.TaskAssignmentSelect;

type LoadedAssignment = Prisma.TaskAssignmentGetPayload<{ select: typeof assignmentSelect }>;

/** Who an item belongs to, in the shape canReviewAssignment needs. */
function reviewTarget(a: Pick<LoadedAssignment, "userId" | "user">) {
  return { userId: a.userId, assigneeSubteam: a.user.subteam };
}

/** Load an assignment with its task and make sure the actor manages that task (else NotFound). */
async function loadManagedAssignment(ctx: ServiceContext, assignmentId: string): Promise<LoadedAssignment> {
  const assignment = await ctx.db.taskAssignment.findUnique({ where: { id: assignmentId }, select: assignmentSelect });
  if (!assignment || !canManageTask(ctx.actor, assignment.task)) throw new NotFoundError(ITEM_NOT_FOUND);
  return assignment;
}

/**
 * Load an assignment the actor may review: they manage its task, or it is one of their own
 * members' items on a whole-team task. Your own item (visible but not reviewable unless you are
 * all-scope) is Forbidden; anything else is NotFound so ids don't leak.
 */
async function loadReviewableAssignment(ctx: ServiceContext, assignmentId: string): Promise<LoadedAssignment> {
  const assignment = await ctx.db.taskAssignment.findUnique({ where: { id: assignmentId }, select: assignmentSelect });
  if (!assignment) throw new NotFoundError(ITEM_NOT_FOUND);
  if (canReviewAssignment(ctx.actor, assignment.task, reviewTarget(assignment))) return assignment;
  if (assignment.userId === ctx.actor.id || canManageTask(ctx.actor, assignment.task)) throw new ForbiddenError(OWN_ITEM);
  throw new NotFoundError(ITEM_NOT_FOUND);
}

/** The task (or someone on the list) vanished between our read and the write. */
function isGoneError(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && (e.code === "P2025" || e.code === "P2003");
}

type Tx = Prisma.TransactionClient;

type TaskFields = z.infer<typeof createInput>;

/** "Assign people" needs someone to assign; sign-up tasks may start empty. */
function requirePeople(data: TaskFields) {
  if (data.assignMode === "assign" && data.assigneeIds.length === 0) {
    throw new ValidationError(PICK_PEOPLE, { assigneeIds: PICK_PEOPLE });
  }
}

/** The sign-up columns for the chosen mode (a new sign-up task starts open). */
function modeFields(data: TaskFields): { signupMode: boolean; signupOpen: boolean; signupLimit: number | null } {
  return data.assignMode === "signup"
    ? { signupMode: true, signupOpen: true, signupLimit: data.signupLimit }
    : { signupMode: false, signupOpen: false, signupLimit: null };
}

/** A sign-up task can't start out (or be edited into) having more people than spots. */
function checkSpots(data: TaskFields, peopleOnIt: number) {
  if (data.assignMode !== "signup" || data.signupLimit === null || peopleOnIt <= data.signupLimit) return;
  const spots = data.signupLimit === 1 ? "1 spot" : `${data.signupLimit} spots`;
  const message = `${peopleOnIt} people are on this task, but it only has ${spots}. Add spots or take people off.`;
  throw new ValidationError(message, { signupLimit: message });
}

type CategoryChoice = { kind: "none" } | { kind: "existing"; id: string } | { kind: "new"; name: string };

/** Check the category picked in the form against the task's subteam (null = whole team). */
async function resolveCategory(ctx: ServiceContext, data: TaskFields): Promise<CategoryChoice> {
  if (data.categoryId === "") return { kind: "none" };
  if (data.categoryId === NEW_CATEGORY) {
    if (!data.newCategory) throw new ValidationError("Name the new category.", { newCategory: "Name the new category." });
    // The Business leader picks from the whole-team categories but doesn't add to that list.
    if (!canManageCategories(ctx.actor, data.subteam)) {
      const message =
        data.subteam === null
          ? "Only the captain, mentors, and teachers add whole-team categories. Pick one from the list."
          : "You can only add categories to your own subteam.";
      throw new ValidationError(message, { newCategory: message });
    }
    return { kind: "new", name: data.newCategory };
  }
  const category = await ctx.db.taskCategory.findUnique({ where: { id: data.categoryId }, select: { id: true, subteam: true } });
  if (!category) {
    const message = "That category no longer exists. Pick another one.";
    throw new ValidationError(message, { categoryId: message });
  }
  if (category.subteam !== data.subteam) {
    const message = `Pick a category from ${data.subteam ? SUBTEAM_LABELS[data.subteam] : "the whole-team list"}.`;
    throw new ValidationError(message, { categoryId: message });
  }
  return { kind: "existing", id: category.id };
}

/** The category id to store, creating the new category inside the task's transaction. */
async function categoryIdFor(tx: Tx, actor: Actor, choice: CategoryChoice, subteam: Subteam | null): Promise<string | null> {
  if (choice.kind === "none") return null;
  if (choice.kind === "existing") return choice.id;
  return (await findOrCreateCategory(tx, actor, { subteam, name: choice.name })).id;
}

// ---------- tasks ----------

/**
 * Create a task and a TODO checklist item for everyone picked. "Let people sign up" tasks may start
 * with nobody (or a few people the leader pre-fills); only those people get the "assigned" email.
 */
export async function createTask(ctx: ServiceContext, raw: unknown): Promise<{ id: string }> {
  requireStaff(ctx.actor);
  const data = parseInput(createInput, raw as Record<string, unknown>);
  requirePeople(data);
  if (!canCreateTask(ctx.actor, data.subteam)) throw subteamForbidden(data.subteam);
  checkDueDate(ctx, data.dueDate);
  checkSpots(data, data.assigneeIds.length);
  const category = await resolveCategory(ctx, data);
  await assertAssignable(ctx, data.assigneeIds, data.subteam);

  const write = (db: Db | Tx, categoryId: string | null) =>
    db.task.create({
      data: {
        title: data.title,
        description: data.description ?? "",
        subteam: data.subteam,
        dueDate: dateOnlyToDb(data.dueDate),
        priority: data.priority,
        categoryId,
        ...modeFields(data),
        createdById: ctx.actor.id,
        ...(data.assigneeIds.length
          ? { assignments: { createMany: { data: data.assigneeIds.map((userId) => ({ userId })) } } }
          : {}),
      },
      select: { id: true },
    });

  let task: { id: string };
  try {
    // A nested create is one statement batch in a single transaction; a new category joins that transaction.
    task =
      category.kind === "new"
        ? await ctx.db.$transaction(async (tx) => write(tx, await categoryIdFor(tx, ctx.actor, category, data.subteam)))
        : await write(ctx.db, category.kind === "existing" ? category.id : null);
  } catch (e) {
    // The category (or someone picked) was deleted between our checks and the write.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2003") {
      throw new ConflictError("A category or person on this task was just removed. Check the form and try again.");
    }
    throw e;
  }

  if (data.assigneeIds.length) {
    ctx.notifier.notify({ type: "task.assigned", taskId: task.id, userIds: data.assigneeIds, actorId: ctx.actor.id });
  }
  return { id: task.id };
}

/**
 * Edit a task. `assigneeIds` is the desired set of people: new people get a TODO item, people left
 * out lose theirs, everyone else keeps their current status.
 *
 * Members can sign up while a leader has the edit form open, so the form also sends the people it
 * was loaded with (`previousAssigneeIds` + `previousAssigneeIdsSent`). Changes are then worked out
 * against that list: people who signed up in the meantime are kept, and people who left in the
 * meantime aren't added back. Without it, `assigneeIds` is the full set (as before).
 *
 * Everything happens under a row lock on the task, so sign-ups can't sneak past the spot limit.
 * A task marked finished can still be edited, but nobody new can be put on it (reopen it first).
 */
export async function updateTask(ctx: ServiceContext, raw: unknown): Promise<void> {
  requireStaff(ctx.actor);
  const data = parseInput(updateInput, raw as Record<string, unknown>);
  requirePeople(data);

  const task = await ctx.db.task.findUnique({
    where: { id: data.taskId },
    select: { id: true, createdById: true, subteam: true, dueDate: true },
  });
  if (!task || !canManageTask(ctx.actor, task)) throw new NotFoundError(TASK_NOT_FOUND);
  if (!canCreateTask(ctx.actor, data.subteam)) {
    throw data.subteam === null
      ? new ForbiddenError(`Only ${WHOLE_TEAM_CREATORS} can make a task whole-team.`)
      : new ForbiddenError("You can only move tasks to your own subteam.");
  }
  // Never move a task out of your own hands: the Business leader manages every Business task, but a whole-team task
  // only when they created it — so they can't make someone else's Business task whole-team (and add anyone to it).
  if (!canManageTask(ctx.actor, { createdById: task.createdById, subteam: data.subteam })) {
    throw new ForbiddenError(NOT_YOURS_TO_MAKE_WHOLE_TEAM);
  }
  // Keeping an old due date is fine (so old tasks stay editable); a new one must be in range.
  if (data.dueDate !== dbToDateOnly(task.dueDate)) checkDueDate(ctx, data.dueDate);
  const category = await resolveCategory(ctx, data);

  let added: string[] = [];
  try {
    added = await ctx.db.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string; signupMode: boolean; signupOpen: boolean; completedAt: Date | null }[]>`
        SELECT id, "signupMode", "signupOpen", "completedAt" FROM "Task" WHERE id = ${task.id} FOR UPDATE`;
      if (locked.length === 0) throw new NotFoundError(TASK_NOT_FOUND);

      const rows = await tx.taskAssignment.findMany({ where: { taskId: task.id }, select: { userId: true, selfAssigned: true } });
      const current = new Set(rows.map((a) => a.userId));
      const baseline = data.previousAssigneeIdsSent ? new Set(data.previousAssigneeIds) : current;
      const selected = new Set(data.assigneeIds);
      const removed = [...current].filter((id) => baseline.has(id) && !selected.has(id));
      const additions = data.assigneeIds.filter((id) => !baseline.has(id) && !current.has(id));

      // Same rule as removeAssignment: a subteam leader can't take their own item off the list.
      if (!hasAllScope(ctx.actor) && removed.includes(ctx.actor.id)) {
        throw new ValidationError(REMOVE_SELF, { assigneeIds: REMOVE_SELF });
      }
      if (additions.length && locked[0].completedAt) {
        throw new ValidationError(FINISHED_NO_NEW_PEOPLE, { assigneeIds: FINISHED_NO_NEW_PEOPLE });
      }
      await assertAssignable(ctx, additions, data.subteam, tx);
      checkSpots(data, current.size - removed.length + additions.length);

      await tx.task.update({
        where: { id: task.id },
        data: {
          title: data.title,
          description: data.description ?? "",
          subteam: data.subteam,
          dueDate: dateOnlyToDb(data.dueDate),
          priority: data.priority,
          categoryId: await categoryIdFor(tx, ctx.actor, category, data.subteam),
          ...modeFields(data),
          // Already a sign-up task: saving keeps sign-ups open or closed as they are (closing and
          // reopening is its own button). Switching an assigned task to sign-up opens them.
          ...(data.assignMode === "signup" && locked[0].signupMode ? { signupOpen: locked[0].signupOpen } : {}),
        },
        select: { id: true },
      });
      // Switched to "Assign people": everyone on it now counts as assigned by a leader (so nobody can "leave").
      if (data.assignMode === "assign" && rows.some((r) => r.selfAssigned)) {
        await tx.taskAssignment.updateMany({ where: { taskId: task.id, selfAssigned: true }, data: { selfAssigned: false } });
      }
      if (removed.length) await tx.taskAssignment.deleteMany({ where: { taskId: task.id, userId: { in: removed } } });
      if (additions.length) {
        await tx.taskAssignment.createMany({
          data: additions.map((userId) => ({ taskId: task.id, userId })),
          skipDuplicates: true,
        });
      }
      return additions;
    });
  } catch (e) {
    // Deleted by someone else after we read it (P2025 on update, P2003 on the new items) — or the
    // picked category / a person was removed meanwhile (P2003 while the task still exists).
    if (isGoneError(e)) {
      if (await ctx.db.task.count({ where: { id: task.id } })) {
        throw new ConflictError("A category or person on this task was just removed. Check the form and try again.");
      }
      throw new NotFoundError(TASK_NOT_FOUND);
    }
    throw e;
  }

  // Only people a leader added hear about it (sign-ups found it themselves).
  if (added.length) ctx.notifier.notify({ type: "task.assigned", taskId: task.id, userIds: added, actorId: ctx.actor.id });
}

/**
 * Close sign-ups for a task (nobody else can sign up), or open them again. Task managers only. A task marked
 * finished takes no sign-ups whatever this says, so opening them waits until the task is reopened.
 */
export async function setSignupOpen(ctx: ServiceContext, raw: unknown): Promise<void> {
  requireStaff(ctx.actor);
  const { taskId, open } = parseInput(signupOpenInput, raw as Record<string, unknown>);
  const task = await ctx.db.task.findUnique({ where: { id: taskId }, select: { id: true, createdById: true, subteam: true } });
  if (!task || !canManageTask(ctx.actor, task)) throw new NotFoundError(TASK_NOT_FOUND);
  // Only "Let people sign up" tasks can be opened (an assigned task has to be edited into one first).
  const { count } = await ctx.db.task.updateMany({
    where: { id: task.id, ...(open ? { signupMode: true, completedAt: null } : {}) },
    data: { signupOpen: open },
  });
  if (count === 0) {
    const still = await ctx.db.task.findUnique({ where: { id: task.id }, select: { completedAt: true } });
    if (!still) throw new NotFoundError(TASK_NOT_FOUND);
    if (still.completedAt) throw new ConflictError("This task is marked finished. Reopen the task to open sign-ups again.");
    throw new ConflictError("This task isn't a sign-up task. Edit it and choose “Let people sign up”.");
  }
}

/** "Marcus Johnson already marked this task finished." ("You …" in a stale second tab.) */
function alreadyFinished(ctx: ServiceContext, by: { id: string | null; name: string | null }): string {
  const who = by.id === ctx.actor.id ? "You" : (by.name ?? "Someone");
  return `${who} already marked this task finished. Refresh to see the latest.`;
}

export interface FinishTaskResult {
  /** Items that became approved because the task was counted as done for everyone. */
  credited: number;
  /** Items left not approved (closed, no credit): everyone's for "Just close it", else only the actor's own item. */
  closed: number;
}

/**
 * Mark the whole task finished ("Mark task finished"), for anyone who manages it:
 * - `credit: "everyone"` — every item that isn't approved yet (to do, checked off, sent back) becomes approved by
 *   the actor, with `finishedWithTask` and its old status in `statusBeforeFinish` so "Reopen task" can undo exactly
 *   that. The review note is left alone (pages say "marked done with the whole task" from the flag). Like reviewing,
 *   a subteam leader's own item isn't counted (all-scope staff's is): it stays as it is — and while it's checked off
 *   (waiting for someone else's review) this is a ConflictError, since a finished task's waiting items leave every
 *   review queue and nobody would be asked to approve it.
 * - `credit: "none"` — just close it: items stay as they are. Anything not approved is then closed, no credit.
 * One transaction with the task row locked (FOR UPDATE): finishing twice is a ConflictError, and the people on it
 * can't check off or leave in between (they lock the same row). No emails.
 */
export async function finishTask(ctx: ServiceContext, raw: unknown): Promise<FinishTaskResult> {
  requireStaff(ctx.actor);
  const { taskId, credit } = parseInput(finishInput, raw as Record<string, unknown>);
  const task = await ctx.db.task.findUnique({ where: { id: taskId }, select: { id: true, createdById: true, subteam: true } });
  if (!task || !canManageTask(ctx.actor, task)) throw new NotFoundError(TASK_NOT_FOUND);

  return ctx.db.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ completedAt: Date | null; completedById: string | null; completedByName: string | null }[]>`
      SELECT t."completedAt", t."completedById", u.name AS "completedByName"
      FROM "Task" t LEFT JOIN "User" u ON u.id = t."completedById"
      WHERE t.id = ${task.id}
      FOR UPDATE OF t`;
    if (locked.length === 0) throw new NotFoundError(TASK_NOT_FOUND);
    if (locked[0].completedAt) {
      throw new ConflictError(alreadyFinished(ctx, { id: locked[0].completedById, name: locked[0].completedByName }));
    }

    let credited = 0;
    if (credit === "everyone") {
      // A subteam leader's own checked-off item isn't counted, and on a finished task it would leave every review
      // queue — so nobody would ever be asked to approve it. Have it approved first (or just close the task).
      if (!hasAllScope(ctx.actor)) {
        const ownWaiting = await tx.taskAssignment.count({ where: { taskId: task.id, userId: ctx.actor.id, status: "SUBMITTED" } });
        if (ownWaiting > 0) throw new ConflictError(OWN_ITEM_WAITING);
      }
      const notOwnItem = hasAllScope(ctx.actor) ? Prisma.empty : Prisma.sql`AND "userId" <> ${ctx.actor.id}`;
      // One statement: each row's old status is read and replaced together, whatever happened to it a moment ago.
      credited = await tx.$executeRaw`
        UPDATE "TaskAssignment"
        SET "statusBeforeFinish" = status,
            status = 'APPROVED',
            "finishedWithTask" = true,
            "reviewedById" = ${ctx.actor.id},
            "reviewedAt" = ${ctx.now},
            "updatedAt" = ${ctx.now}
        WHERE "taskId" = ${task.id} AND status <> 'APPROVED' ${notOwnItem}`;
    }
    const closed = await tx.taskAssignment.count({ where: { taskId: task.id, status: { not: "APPROVED" } } });
    await tx.task.update({
      where: { id: task.id },
      data: { completedAt: ctx.now, completedById: ctx.actor.id },
      select: { id: true },
    });
    return { credited, closed };
  });
}

/**
 * Undo "Mark task finished" ("Reopen task"): the task is open again, and every item that was approved only because
 * the task was counted as done for everyone (still approved, `finishedWithTask`) goes back to the status it had —
 * its review fields cleared. Items a leader reviewed one by one stay as they are. Same people and lock as finishTask.
 */
export async function reopenTask(ctx: ServiceContext, raw: unknown): Promise<{ restored: number }> {
  requireStaff(ctx.actor);
  const { taskId } = parseInput(taskIdInput, raw as Record<string, unknown>);
  const task = await ctx.db.task.findUnique({ where: { id: taskId }, select: { id: true, createdById: true, subteam: true } });
  if (!task || !canManageTask(ctx.actor, task)) throw new NotFoundError(TASK_NOT_FOUND);

  return ctx.db.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ completedAt: Date | null }[]>`
      SELECT "completedAt" FROM "Task" WHERE id = ${task.id} FOR UPDATE`;
    if (locked.length === 0) throw new NotFoundError(TASK_NOT_FOUND);
    if (!locked[0].completedAt) throw new ConflictError("This task isn't marked finished anymore. Refresh to see the latest.");

    const restored = await tx.$executeRaw`
      UPDATE "TaskAssignment"
      SET status = COALESCE("statusBeforeFinish", 'TODO'),
          "statusBeforeFinish" = NULL,
          "finishedWithTask" = false,
          "reviewedById" = NULL,
          "reviewedAt" = NULL,
          "updatedAt" = ${ctx.now}
      WHERE "taskId" = ${task.id} AND "finishedWithTask" AND status = 'APPROVED'`;
    await tx.task.update({ where: { id: task.id }, data: { completedAt: null, completedById: null }, select: { id: true } });
    return { restored };
  });
}

/** Delete a task and every checklist item for it. Linked questions stay (their task link is cleared). */
export async function deleteTask(ctx: ServiceContext, raw: unknown): Promise<void> {
  requireStaff(ctx.actor);
  const { taskId } = parseInput(taskIdInput, raw as Record<string, unknown>);
  const task = await ctx.db.task.findUnique({ where: { id: taskId }, select: { id: true, createdById: true, subteam: true } });
  if (!task || !canManageTask(ctx.actor, task)) throw new NotFoundError(TASK_NOT_FOUND);
  await ctx.db.task.deleteMany({ where: { id: task.id } });
}

// ---------- review ----------

/**
 * Approve or send back one submitted checklist item. Sending back requires a note. On a task marked finished an
 * item that was still waiting can be approved (it then counts), but not sent back — nobody can check it off again.
 */
export async function reviewAssignment(ctx: ServiceContext, raw: unknown): Promise<void> {
  requireStaff(ctx.actor);
  const data = parseInput(reviewInput, raw as Record<string, unknown>);
  const assignment = await loadReviewableAssignment(ctx, data.assignmentId);
  if (data.decision === "reject" && !data.note) {
    throw new ValidationError("Tell them what to change.", { note: "Tell them what to change." });
  }
  const sendBack = data.decision === "reject";
  if (sendBack && assignment.task.completedAt) throw new ConflictError(NO_SEND_BACK_WHEN_FINISHED);

  const { count } = await ctx.db.taskAssignment.updateMany({
    // Sending back also needs the task still open (it may have been marked finished since we read it).
    where: { id: assignment.id, status: { in: allowedFrom(data.decision) }, ...(sendBack ? { task: { completedAt: null } } : {}) },
    data: {
      status: nextStatus(data.decision),
      reviewedById: ctx.actor.id,
      reviewedAt: ctx.now,
      reviewNote: data.note ?? null,
    },
  });
  if (count === 0) {
    const finished = sendBack && (await ctx.db.task.count({ where: { id: assignment.task.id, completedAt: { not: null } } })) > 0;
    throw new ConflictError(finished ? NO_SEND_BACK_WHEN_FINISHED : ALREADY_REVIEWED);
  }

  ctx.notifier.notify({ type: "task.reviewed", assignmentId: assignment.id });
}

/** Approve many submissions at once. Items the actor can't review or that aren't waiting are skipped. */
export async function approveMany(ctx: ServiceContext, raw: unknown): Promise<{ approved: number; skipped: number }> {
  requireStaff(ctx.actor);
  const { assignmentIds } = parseInput(approveManyInput, raw as Record<string, unknown>);

  const candidates = await ctx.db.taskAssignment.findMany({
    where: { AND: [{ id: { in: assignmentIds } }, reviewQueueWhere(ctx.actor)] },
    select: { id: true, userId: true, user: { select: { subteam: true } }, task: { select: { createdById: true, subteam: true } } },
  });
  const ids = candidates.filter((a) => canReviewAssignment(ctx.actor, a.task, reviewTarget(a))).map((a) => a.id);

  const approved = ids.length
    ? await ctx.db.taskAssignment.updateManyAndReturn({
        where: { id: { in: ids }, status: { in: allowedFrom("approve") } },
        data: { status: nextStatus("approve"), reviewedById: ctx.actor.id, reviewedAt: ctx.now, reviewNote: null },
        select: { id: true },
      })
    : [];

  for (const a of approved) ctx.notifier.notify({ type: "task.reviewed", assignmentId: a.id });
  return { approved: approved.length, skipped: assignmentIds.length - approved.length };
}

/**
 * Move an approved item back to the member's to-do list. Keeps the last feedback note. No email.
 * On a task marked finished it doesn't go back on their list: it just stops counting (closed, no credit) — how a
 * leader takes the credit back from one person after "Count it as done for everyone".
 */
export async function reopenAssignment(ctx: ServiceContext, raw: unknown): Promise<{ taskFinished: boolean }> {
  requireStaff(ctx.actor);
  const { assignmentId } = parseInput(assignmentIdInput, raw as Record<string, unknown>);
  const assignment = await loadReviewableAssignment(ctx, assignmentId);

  const { count } = await ctx.db.taskAssignment.updateMany({
    where: { id: assignment.id, status: { in: allowedFrom("reopen") } },
    // Reviewed by hand now: "Reopen task" mustn't put it back to what it was before the task was finished.
    data: { status: nextStatus("reopen"), reviewedAt: null, reviewedById: null, finishedWithTask: false, statusBeforeFinish: null },
  });
  if (count === 0) throw new ConflictError("This item isn't approved anymore. Refresh to see the latest.");
  return { taskFinished: assignment.task.completedAt !== null };
}

/**
 * Take one person off a task (deletes their checklist item). Task managers only — and, like
 * reviewing, a subteam leader can't remove their own item (only all-scope staff can).
 */
export async function removeAssignment(ctx: ServiceContext, raw: unknown): Promise<void> {
  requireStaff(ctx.actor);
  const { assignmentId } = parseInput(assignmentIdInput, raw as Record<string, unknown>);
  const assignment = await loadManagedAssignment(ctx, assignmentId);
  if (assignment.userId === ctx.actor.id && !hasAllScope(ctx.actor)) throw new ForbiddenError(REMOVE_SELF);
  await ctx.db.taskAssignment.deleteMany({ where: { id: assignment.id } });
}
