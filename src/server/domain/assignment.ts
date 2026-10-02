// The checklist item state machine. Both the member side (submit/withdraw) and the
// leader side (approve/send back/reopen) MUST go through these guards.
//
//   TODO ──submit──▶ SUBMITTED ──approve──▶ APPROVED   (officially done)
//    ▲                 │   │                   │
//    └────withdraw─────┘   └─send back─▶ REJECTED ──submit──▶ SUBMITTED
//    ▲                                                        
//    └──────────────────────reopen (manager)───────────────────┘ (from APPROVED)
//
// A whole task can also be marked finished (Task.completedAt, "Mark task finished" — services/tasks.ts):
// - "Count it as done for everyone": every item that isn't APPROVED becomes APPROVED with finishedWithTask = true
//   and statusBeforeFinish = what it was, so "Reopen task" can put exactly those items back.
// - "Just close it": items stay as they are. Anything not APPROVED is then *closed* — no credit, off everyone's
//   open lists, never overdue, out of the review queue — see isClosedItem.
// While a task is finished its people can't check off, uncheck, sign up, or leave.

import type { AssignmentStatus } from "@/generated/prisma/enums";

export type AssignmentTransition = "submit" | "withdraw" | "approve" | "reject" | "reopen";

const TRANSITIONS: Record<AssignmentTransition, { from: readonly AssignmentStatus[]; to: AssignmentStatus }> = {
  submit: { from: ["TODO", "REJECTED"], to: "SUBMITTED" },
  withdraw: { from: ["SUBMITTED"], to: "TODO" },
  approve: { from: ["SUBMITTED"], to: "APPROVED" },
  reject: { from: ["SUBMITTED"], to: "REJECTED" },
  reopen: { from: ["APPROVED"], to: "TODO" },
};

export function canTransition(from: AssignmentStatus, action: AssignmentTransition): boolean {
  return TRANSITIONS[action].from.includes(from);
}

export function nextStatus(action: AssignmentTransition): AssignmentStatus {
  return TRANSITIONS[action].to;
}

/** Statuses a transition may start from — use in `updateMany({ where: { status: { in } } })` to avoid races. */
export function allowedFrom(action: AssignmentTransition): AssignmentStatus[] {
  return [...TRANSITIONS[action].from];
}

/** Counts as finished for progress bars. */
export function isDone(status: AssignmentStatus): boolean {
  return status === "APPROVED";
}

/** An item of a task that was marked finished without it being approved: closed, no credit. */
export function isClosedItem(status: AssignmentStatus, taskCompletedAt: Date | string | null): boolean {
  return taskCompletedAt !== null && status !== "APPROVED";
}

/** Still on the member's plate (shows in Today / overdue): to do or sent back, and the task isn't marked finished. */
export function isOpenForMember(status: AssignmentStatus, taskCompletedAt: Date | string | null = null): boolean {
  return (status === "TODO" || status === "REJECTED") && taskCompletedAt === null;
}
