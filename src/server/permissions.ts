// Pure permission rules — the single source of truth for "who can do what".
// Services MUST call these (UI hiding a button is not a security boundary).
// Mirrored as Prisma where-clauses in ./scopes.ts for list queries.

import type { AccountStatus, Role, Subteam } from "@/generated/prisma/enums";
import { ALL_SCOPE_ROLES, LEADER_ROLE_SUBTEAM, STAFF_ROLES, isSubteamLeaderRole } from "@/lib/constants";
import type { Actor } from "./actor";

type ActorLike = Pick<Actor, "id" | "role" | "subteam" | "isAdmin">;

/** Leaders, captain, mentors, teachers, and admins. Can assign tasks, review, answer questions. */
export function isStaff(actor: ActorLike): boolean {
  return actor.isAdmin || STAFF_ROLES.includes(actor.role);
}

/** Captain, mentors, teachers, and admins see and manage every subteam. */
export function hasAllScope(actor: ActorLike): boolean {
  return actor.isAdmin || ALL_SCOPE_ROLES.includes(actor.role);
}

/** The subteam a subteam leader leads, else null. */
export function ledSubteam(actor: ActorLike): Subteam | null {
  return isSubteamLeaderRole(actor.role) ? LEADER_ROLE_SUBTEAM[actor.role] : null;
}

/** Can manage tasks/people of `subteam` (null = whole-team, all-scope only). */
export function canManageSubteam(actor: ActorLike, subteam: Subteam | null): boolean {
  if (hasAllScope(actor)) return true;
  const led = ledSubteam(actor);
  return led !== null && subteam === led;
}

/** Can create a task that belongs to `subteam`. */
export function canCreateTask(actor: ActorLike, subteam: Subteam | null): boolean {
  return canManageSubteam(actor, subteam);
}

/**
 * Can assign a task to this person.
 * All-scope staff: any ACTIVE user. Subteam leaders: ACTIVE users in their own subteam.
 */
export function canAssignTo(
  actor: ActorLike,
  assignee: { subteam: Subteam | null; status: AccountStatus },
): boolean {
  if (assignee.status !== "ACTIVE") return false;
  if (hasAllScope(actor)) return true;
  const led = ledSubteam(actor);
  return led !== null && assignee.subteam === led;
}

/** Edit/delete a task, see its progress, review its submissions. */
export function canManageTask(actor: ActorLike, task: { createdById: string; subteam: Subteam | null }): boolean {
  if (!isStaff(actor)) return false;
  return task.createdById === actor.id || canManageSubteam(actor, task.subteam);
}

// Seeing a task needs no rule: every task is on the Task dashboard, which every ACTIVE person can open.

/** Add, rename, reorder, and delete the task categories of `subteam` (null = whole-team categories). */
export function canManageCategories(actor: ActorLike, subteam: Subteam | null): boolean {
  return canManageSubteam(actor, subteam);
}

/**
 * Sign yourself up for a task from the Task dashboard: sign-ups must be open, and the task must be
 * for your subteam (whole-team tasks: anyone). Spots, due date, and "already on it" are checked by the service.
 */
export function canSignUpForTask(actor: ActorLike, task: { subteam: Subteam | null; signupOpen: boolean }): boolean {
  if (!task.signupOpen) return false;
  return task.subteam === null || actor.subteam === task.subteam;
}

/**
 * Approve / send back / reopen a checklist item.
 * - Anyone who can manage the task.
 * - Subteam leaders also review their OWN members' items on whole-team tasks
 *   (pass `assigneeSubteam`; without it only the manage rule applies).
 * You can't review your own item unless you are all-scope staff (captain/mentor/teacher/admin).
 */
export function canReviewAssignment(
  actor: ActorLike,
  task: { createdById: string; subteam: Subteam | null },
  assignment: { userId: string; assigneeSubteam?: Subteam | null },
): boolean {
  if (!isStaff(actor)) return false;
  if (assignment.userId === actor.id && !hasAllScope(actor)) return false;
  if (canManageTask(actor, task)) return true;
  const led = ledSubteam(actor);
  return task.subteam === null && led !== null && assignment.assigneeSubteam === led;
}

type QuestionLike = { askerId: string; recipientId: string | null; subteam: Subteam | null };

/** Asker, the addressed recipient, all-scope staff, and leaders of the question's subteam. */
export function canViewQuestion(actor: ActorLike, q: QuestionLike): boolean {
  if (q.askerId === actor.id || q.recipientId === actor.id) return true;
  if (hasAllScope(actor)) return true;
  const led = ledSubteam(actor);
  return led !== null && q.subteam === led;
}

/** Post in the thread: the asker (follow-ups) or staff who can see it (answers). */
export function canReplyToQuestion(actor: ActorLike, q: QuestionLike): boolean {
  if (q.askerId === actor.id) return true;
  return isStaff(actor) && canViewQuestion(actor, q);
}

/** Mark resolved / reopen: the asker or staff who can see it. */
export function canChangeQuestionStatus(actor: ActorLike, q: QuestionLike): boolean {
  return canReplyToQuestion(actor, q);
}

/** A question can be addressed to any ACTIVE staff member (not to yourself). */
export function canBeQuestionRecipient(user: { id: string; role: Role; status: AccountStatus; isAdmin: boolean }): boolean {
  return user.status === "ACTIVE" && (STAFF_ROLES.includes(user.role) || user.isAdmin);
}

/** The site owner(s) (`isAdmin` flag). Only owners can change owners' accounts or make someone an owner. */
export function isOwner(actor: ActorLike): boolean {
  return actor.isAdmin;
}

/**
 * The Admin area: approve sign-ups and member resources, manage people, email log.
 * Owners plus every leader, the captain, mentors, and teachers.
 */
export function canAdminister(actor: ActorLike): boolean {
  return isStaff(actor);
}

/**
 * How much a position can do, for the guardrails on admin access: members < subteam leaders <
 * captain/mentors/teachers. Owners (the `isAdmin` flag) are above everyone.
 */
export const ROLE_RANK: Record<Role, number> = {
  MEMBER: 0,
  SOFTWARE_LEADER: 1,
  BUILD_LEADER: 1,
  BUSINESS_LEADER: 1,
  CAPTAIN: 2,
  MENTOR: 2,
  TEACHER: 2,
};

type AccountLike = { id: string; role: Role; status: AccountStatus; isAdmin: boolean };

function isWaiting(status: AccountStatus): boolean {
  return status === "PENDING" || status === "REJECTED";
}

/**
 * Change someone's account in Admin → People (edit, approve/reject, reset password, sign out, delete).
 * - Owners: anyone.
 * - Everyone else with admin access: never an owner; active accounts ranked below their own position
 *   (leaders → members; captain/mentors/teachers → leaders and members); sign-ups waiting for approval
 *   up to their own rank (so leaders can approve new leaders); and their own account.
 * Without this, a leader could turn a second account into a mentor, or take over the captain's account.
 */
export function canManageAccount(actor: ActorLike, target: AccountLike): boolean {
  if (!canAdminister(actor)) return false;
  if (isOwner(actor)) return true;
  if (target.isAdmin) return false;
  if (target.id === actor.id) return true;
  const rank = ROLE_RANK[target.role];
  return isWaiting(target.status) ? rank <= ROLE_RANK[actor.role] : rank < ROLE_RANK[actor.role];
}

/**
 * A position someone with admin access may give an account: owners any; others only below their own
 * rank, or — when approving a sign-up — up to their own rank.
 */
export function canGrantRole(actor: ActorLike, role: Role, opts: { approving?: boolean } = {}): boolean {
  if (!canAdminister(actor)) return false;
  if (isOwner(actor)) return true;
  return opts.approving ? ROLE_RANK[role] <= ROLE_RANK[actor.role] : ROLE_RANK[role] < ROLE_RANK[actor.role];
}

/** Positions this admin may give (for the Position menus). */
export function grantableRoles(actor: ActorLike, opts: { approving?: boolean } = {}): Role[] {
  return (Object.keys(ROLE_RANK) as Role[]).filter((r) => canGrantRole(actor, r, opts));
}

/**
 * The email log shows every notification's subject (e.g. who was sent back, private question titles),
 * so it stays with the owners.
 */
export function canViewEmailLog(actor: ActorLike): boolean {
  return isOwner(actor);
}

/** Can open the Manage area (dashboard, tasks, review, progress). */
export function canAccessManage(actor: ActorLike): boolean {
  return isStaff(actor);
}

/** Can see the progress of this person (manage-area progress pages). */
export function canViewMemberProgress(actor: ActorLike, member: { id: string; subteam: Subteam | null }): boolean {
  if (member.id === actor.id) return true;
  if (hasAllScope(actor)) return true;
  const led = ledSubteam(actor);
  return led !== null && member.subteam === led;
}

/**
 * Add resources that go live right away, and edit / remove / pin anyone's resources.
 * Everyone else (members) can still share resources, but theirs wait for approval (see canReviewResources).
 */
export function canManageResources(actor: ActorLike): boolean {
  return canAdminister(actor);
}

/** Approve or turn down resources that members shared. */
export function canReviewResources(actor: ActorLike): boolean {
  return canAdminister(actor);
}

type ResourceLike = { status: "PENDING" | "APPROVED" | "REJECTED"; createdById: string | null };

/** Approved resources: everyone. Pending / turned-down ones: the person who shared it and reviewers. */
export function canViewResource(actor: ActorLike, r: ResourceLike): boolean {
  return r.status === "APPROVED" || r.createdById === actor.id || canReviewResources(actor);
}

/** Managers: any resource. Members: their own, until it is approved (editing sends it back for approval). */
export function canEditResource(actor: ActorLike, r: ResourceLike): boolean {
  if (canManageResources(actor)) return true;
  return r.createdById === actor.id && r.status !== "APPROVED";
}

/** Managers: any resource. Members: anything they shared themselves. */
export function canDeleteResource(actor: ActorLike, r: ResourceLike): boolean {
  return canManageResources(actor) || (r.createdById !== null && r.createdById === actor.id);
}

// ── Sponsorships (Business team tracker) ──────────────────────────────────────

/** See and edit the Sponsorships tracker: the Business subteam plus staff (leaders, captain, mentors, teachers, owners). */
export function canUseSponsorships(actor: ActorLike): boolean {
  return actor.subteam === "BUSINESS" || isStaff(actor);
}

/** Delete a sponsorship: whoever added it, the Business leader, and all-scope staff. */
export function canDeleteSponsorship(actor: ActorLike, s: { createdById: string | null }): boolean {
  if (!canUseSponsorships(actor)) return false;
  return hasAllScope(actor) || ledSubteam(actor) === "BUSINESS" || (s.createdById !== null && s.createdById === actor.id);
}

// ── Parts queue ───────────────────────────────────────────────────────────────

/** Reorder the parts queue and change or remove anyone's parts: Build leaders and all-scope staff. */
export function canManageParts(actor: ActorLike): boolean {
  return hasAllScope(actor) || ledSubteam(actor) === "BUILD";
}

type PartLike = { requestedById: string | null; claimedById: string | null; status: "NEEDED" | "CLAIMED" | "DONE" };

/** Edit or remove a part: managers any; whoever asked for it while nobody has claimed it yet. */
export function canEditPart(actor: ActorLike, p: PartLike): boolean {
  if (canManageParts(actor)) return true;
  return p.requestedById !== null && p.requestedById === actor.id && p.status === "NEEDED";
}

/** Drop a claim or mark a part done: the person making it, and managers. */
export function canWorkOnPart(actor: ActorLike, p: PartLike): boolean {
  return canManageParts(actor) || (p.claimedById !== null && p.claimedById === actor.id);
}
