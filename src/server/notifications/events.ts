// Events that services emit after a successful write. The notifications module decides
// who gets an email (respecting each person's preferences) — services never send email directly.

export type NotificationEvent =
  /** A member asked a question. Recipient(s): the addressed person, else the subteam's leaders, else captains. */
  | { type: "question.asked"; questionId: string }
  /** Someone posted in a question thread. If staff replied -> the asker; if the asker followed up -> staff on the question. */
  | { type: "question.replied"; questionId: string; replyId: string }
  /** A question was deleted. Its copies in the leaders' Discord channel are removed (no email). */
  | { type: "question.deleted"; questionId: string; discordMessageIds: string[] }
  /** A member checked off a checklist item. Recipient: the task's creator, or (if they can't review it) the subteam's leaders → captains → admins. */
  | { type: "task.submitted"; assignmentId: string }
  /** A leader approved or sent back a submission. Recipient: the assignee. */
  | { type: "task.reviewed"; assignmentId: string }
  /** New assignments were created. Recipients: those users except whoever made the change (opt-in preference). */
  | { type: "task.assigned"; taskId: string; userIds: string[]; actorId?: string }
  /** Someone registered and is waiting for approval. Recipients: admins. */
  | { type: "account.pending"; userId: string }
  /** An admin approved an account. Recipient: that user. */
  | { type: "account.approved"; userId: string }
  /** Password reset requested. Recipient: that user. `resetUrl` contains the one-time token. */
  | { type: "password.reset"; userId: string; resetUrl: string }
  /** The password was changed (settings or reset link). Recipient: that user — a security notice. */
  | { type: "password.changed"; userId: string }
  /**
   * A member shared (or edited and re-sent) a resource that needs approval. Recipients: owners plus the
   * leaders of the member's subteam (captains when there are none).
   */
  | { type: "resource.submitted"; resourceId: string }
  /** Someone approved or turned down a member's resource. Recipient: the person who shared it. */
  | { type: "resource.reviewed"; resourceId: string };

export type NotificationType = NotificationEvent["type"];

export interface Notifier {
  /** Fire-and-forget. Must never throw into the caller. */
  notify(event: NotificationEvent): void;
}

/** Collects events instead of sending — for tests. */
export class CollectingNotifier implements Notifier {
  readonly events: NotificationEvent[] = [];
  notify(event: NotificationEvent): void {
    this.events.push(event);
  }
  ofType<T extends NotificationType>(type: T): Extract<NotificationEvent, { type: T }>[] {
    return this.events.filter((e): e is Extract<NotificationEvent, { type: T }> => e.type === type);
  }
}

export const noopNotifier: Notifier = { notify() {} };
