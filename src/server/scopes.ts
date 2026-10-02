// Prisma where-clauses that mirror ./permissions.ts for list/count queries.
// Keep these two files in sync — tests in tests/permissions.test.ts check they agree.

import type { Prisma } from "@/generated/prisma/client";
import type { Subteam } from "@/generated/prisma/enums";
import type { Actor } from "./actor";
import { canCreateWholeTeamTask, canReviewResources, hasAllScope, isStaff, ledSubteam } from "./permissions";

type ActorLike = Pick<Actor, "id" | "role" | "subteam" | "isAdmin">;

/** A where-clause that matches nothing. */
const NONE = { id: { in: [] as string[] } };

/** Tasks the actor can manage (mirror of canManageTask). */
export function manageableTasksWhere(actor: ActorLike): Prisma.TaskWhereInput {
  if (!isStaff(actor)) return NONE;
  if (hasAllScope(actor)) return {};
  const led = ledSubteam(actor);
  return led ? { OR: [{ subteam: led }, { createdById: actor.id }] } : { createdById: actor.id };
}

/** Assignments this actor may review, any status (mirror of canReviewAssignment). */
export function reviewableAssignmentsWhere(actor: ActorLike): Prisma.TaskAssignmentWhereInput {
  if (!isStaff(actor)) return NONE;
  if (hasAllScope(actor)) return {};
  const led = ledSubteam(actor);
  const or: Prisma.TaskAssignmentWhereInput[] = [{ task: manageableTasksWhere(actor) }];
  // Subteam leaders also review their own members' items on whole-team tasks.
  if (led) or.push({ task: { subteam: null }, user: { subteam: led } });
  return { userId: { not: actor.id }, OR: or };
}

/**
 * Submitted assignments waiting for this actor's review. Items of a task someone marked finished ("Just close it")
 * aren't waiting for anyone anymore, so they leave the queue (a manager can still approve them on the task's page).
 */
export function reviewQueueWhere(actor: ActorLike): Prisma.TaskAssignmentWhereInput {
  if (!isStaff(actor)) return NONE;
  return { AND: [{ status: "SUBMITTED", task: { completedAt: null } }, reviewableAssignmentsWhere(actor)] };
}

/** Questions the actor can see (mirror of canViewQuestion). */
export function visibleQuestionsWhere(actor: ActorLike): Prisma.QuestionWhereInput {
  if (hasAllScope(actor)) return {};
  const led = ledSubteam(actor);
  const or: Prisma.QuestionWhereInput[] = [{ askerId: actor.id }, { recipientId: actor.id }];
  if (led) or.push({ subteam: led });
  return { OR: or };
}

/** Staff inbox: questions in scope that someone else asked. */
export function questionInboxWhere(actor: ActorLike): Prisma.QuestionWhereInput {
  if (!isStaff(actor)) return NONE;
  return { AND: [visibleQuestionsWhere(actor), { askerId: { not: actor.id } }] };
}

/** ACTIVE users whose progress the actor can see (mirror of canViewMemberProgress; includes the actor if in scope). */
export function manageableMembersWhere(actor: ActorLike): Prisma.UserWhereInput {
  if (!isStaff(actor)) return NONE;
  if (hasAllScope(actor)) return { status: "ACTIVE" };
  const led = ledSubteam(actor);
  return led ? { status: "ACTIVE", subteam: led } : NONE;
}

/**
 * Users the actor may put on a task of `taskSubteam` (null = whole team) — mirror of canAssignTo: all-scope staff and
 * (on whole-team tasks) the Business leader: everyone ACTIVE; subteam leaders: ACTIVE people in their own subteam.
 */
export function assignableUsersWhere(actor: ActorLike, taskSubteam: Subteam | null): Prisma.UserWhereInput {
  if (!isStaff(actor)) return NONE;
  if (hasAllScope(actor)) return { status: "ACTIVE" };
  const led = ledSubteam(actor);
  if (!led) return NONE;
  if (taskSubteam === null && canCreateWholeTeamTask(actor)) return { status: "ACTIVE" };
  return { status: "ACTIVE", subteam: led };
}

/** Resources the actor can see (mirror of canViewResource). */
export function visibleResourcesWhere(actor: ActorLike): Prisma.ResourceWhereInput {
  if (canReviewResources(actor)) return {};
  return { OR: [{ status: "APPROVED" }, { createdById: actor.id }] };
}

/** Members' resources waiting for this actor's approval. */
export function resourceReviewQueueWhere(actor: ActorLike): Prisma.ResourceWhereInput {
  if (!canReviewResources(actor)) return NONE;
  return { status: "PENDING" };
}
