// Turns a NotificationEvent into emails: load what the event is about, decide who gets it
// (./recipients.ts, respecting preferences), render it (./templates.ts), and send each email via
// sendEmail(), which records every attempt in EmailLog and never throws.
//
// If the thing an event points at no longer exists (or has moved on, e.g. a withdrawn submission),
// nothing is sent. No "server-only" / next/* imports: this runs inside after() and in tests.
import { type DateOnly, dbToDateOnly, todayInTimezone } from "@/lib/dates";
import type { Db } from "../db";
import { type EmailTransport, getTransport, sendEmail } from "../email/transport";
import { env } from "../env";
import { type DiscordOptions, deliverDiscord } from "./discord";
import type { NotificationEvent } from "./events";
import {
  accountApprovedRecipients,
  accountPendingRecipients,
  passwordResetRecipients,
  questionAskedRecipients,
  questionRepliedRecipients,
  type Recipient,
  recipientSelect,
  resourceReviewedRecipients,
  resourceSubmittedRecipients,
  type SubmissionRecipient,
  taskAssignedRecipients,
  taskReviewedRecipients,
  taskSubmittedRecipients,
} from "./recipients";
import {
  accountApprovedEmail,
  accountPendingEmail,
  type EmailContent,
  passwordChangedEmail,
  passwordResetEmail,
  questionAskedEmail,
  questionRepliedEmail,
  resourceReviewedEmail,
  resourceSubmittedEmail,
  taskAssignedEmail,
  taskReviewedEmail,
  taskSubmittedEmail,
} from "./templates";

export interface DeliverOptions {
  /** Override the transport (tests pass a fake). Defaults to getTransport(); null = log only (SKIPPED). */
  transport?: EmailTransport | null;
  appUrl?: string;
  teamTimezone?: string;
  /** Clock override for due-date wording (tests). Defaults to the current time. */
  now?: Date;
  /** Discord webhook overrides (tests). Defaults to DISCORD_WEBHOOK_URL. */
  discord?: DiscordOptions;
}

interface DeliverConfig {
  appUrl: string;
  today: DateOnly;
}

/** `render` is only ever called with this plan's own recipients. */
interface Plan<R extends Recipient = Recipient> {
  recipients: R[];
  render(recipient: R): EmailContent;
}

const personSelect = { name: true, role: true, subteam: true } as const;

export async function deliverNotification(db: Db, event: NotificationEvent, options: DeliverOptions = {}): Promise<void> {
  const transport = options.transport === undefined ? getTransport() : options.transport;
  const cfg: DeliverConfig = {
    appUrl: (options.appUrl ?? env.appUrl).replace(/\/+$/, ""),
    today: todayInTimezone(options.teamTimezone ?? env.teamTimezone, options.now ?? new Date()),
  };

  // Question activity also goes to the leaders' Discord channel (if configured), alongside the emails.
  const discord = deliverDiscord(db, event, { appUrl: cfg.appUrl, ...options.discord }).catch((e) =>
    console.error(`[notify] ${event.type}: Discord post failed`, e),
  );

  try {
    const plan = await planFor(db, event, cfg);
    if (!plan || plan.recipients.length === 0) return;

    await Promise.all(
      plan.recipients.map(async (recipient) => {
        try {
          const content = plan.render(recipient);
          await sendEmail(db, { to: recipient.email, ...content, kind: event.type }, transport);
        } catch (e) {
          // sendEmail never throws; this guards rendering bugs so one recipient can't block the rest.
          console.error(`[notify] ${event.type}: could not email user ${recipient.id}`, e);
        }
      }),
    );
  } finally {
    // Even if loading email recipients fails, finish the Discord post before after() returns.
    await discord;
  }
}

function planFor(db: Db, event: NotificationEvent, cfg: DeliverConfig): Promise<Plan | null> {
  switch (event.type) {
    case "question.asked":
      return planQuestionAsked(db, event, cfg);
    case "question.replied":
      return planQuestionReplied(db, event, cfg);
    case "task.submitted":
      return planTaskSubmitted(db, event, cfg);
    case "task.reviewed":
      return planTaskReviewed(db, event, cfg);
    case "task.assigned":
      return planTaskAssigned(db, event, cfg);
    case "account.pending":
      return planAccountPending(db, event, cfg);
    case "account.approved":
      return planAccountApproved(db, event, cfg);
    case "password.reset":
      return planPasswordReset(db, event, cfg);
    case "password.changed":
      return planPasswordChanged(db, event, cfg);
    case "resource.submitted":
      return planResourceSubmitted(db, event, cfg);
    case "resource.reviewed":
      return planResourceReviewed(db, event, cfg);
    case "question.deleted":
      return Promise.resolve(null); // Discord-only (deliverDiscord removes the posts)
    default: {
      const unknown: never = event;
      console.warn("[notify] unknown event", unknown);
      return Promise.resolve(null);
    }
  }
}

type EventOf<T extends NotificationEvent["type"]> = Extract<NotificationEvent, { type: T }>;

async function planQuestionAsked(db: Db, event: EventOf<"question.asked">, cfg: DeliverConfig): Promise<Plan | null> {
  const q = await db.question.findUnique({
    where: { id: event.questionId },
    select: {
      id: true,
      title: true,
      body: true,
      askerId: true,
      recipientId: true,
      subteam: true,
      asker: { select: personSelect },
      task: { select: { title: true } },
    },
  });
  if (!q) return null;
  return {
    recipients: await questionAskedRecipients(db, q),
    render: (recipient) =>
      questionAskedEmail({
        appUrl: cfg.appUrl,
        recipient,
        question: {
          id: q.id,
          title: q.title,
          body: q.body,
          subteam: q.subteam,
          recipientId: q.recipientId,
          taskTitle: q.task?.title ?? null,
        },
        asker: q.asker,
      }),
  };
}

async function planQuestionReplied(db: Db, event: EventOf<"question.replied">, cfg: DeliverConfig): Promise<Plan | null> {
  const reply = await db.questionReply.findUnique({
    where: { id: event.replyId },
    select: {
      id: true,
      body: true,
      authorId: true,
      createdAt: true,
      questionId: true,
      author: { select: personSelect },
      question: {
        select: {
          id: true,
          title: true,
          askerId: true,
          recipientId: true,
          subteam: true,
          asker: { select: recipientSelect },
        },
      },
    },
  });
  if (!reply || reply.questionId !== event.questionId) return null;
  const q = reply.question;
  const { audience, recipients } = await questionRepliedRecipients(db, q, reply);
  return {
    recipients,
    render: (recipient) =>
      questionRepliedEmail({
        appUrl: cfg.appUrl,
        recipient,
        audience,
        question: { id: q.id, title: q.title },
        author: reply.author,
        reply: { body: reply.body },
      }),
  };
}

async function planTaskSubmitted(
  db: Db,
  event: EventOf<"task.submitted">,
  cfg: DeliverConfig,
): Promise<Plan<SubmissionRecipient> | null> {
  const a = await db.taskAssignment.findUnique({
    where: { id: event.assignmentId },
    select: {
      userId: true,
      status: true,
      submissionNote: true,
      user: { select: personSelect },
      task: {
        select: {
          id: true,
          title: true,
          dueDate: true,
          subteam: true,
          createdById: true,
          createdBy: { select: recipientSelect },
        },
      },
    },
  });
  // Withdrawn (or already reviewed) before we got here: nothing to review any more.
  if (!a || a.status !== "SUBMITTED") return null;
  return {
    recipients: await taskSubmittedRecipients(db, a),
    render: (recipient) =>
      taskSubmittedEmail({
        appUrl: cfg.appUrl,
        recipient,
        // Leaders reviewing their members' items on a whole-team task can't open the task page.
        reviewFrom: recipient.canManageTask ? "task" : "queue",
        task: { id: a.task.id, title: a.task.title, dueDate: dbToDateOnly(a.task.dueDate) },
        submitter: a.user,
        submissionNote: a.submissionNote,
        today: cfg.today,
      }),
  };
}

async function planTaskReviewed(db: Db, event: EventOf<"task.reviewed">, cfg: DeliverConfig): Promise<Plan | null> {
  const a = await db.taskAssignment.findUnique({
    where: { id: event.assignmentId },
    select: {
      status: true,
      reviewNote: true,
      reviewedById: true,
      reviewedBy: { select: { name: true } },
      user: { select: recipientSelect },
      task: { select: { title: true, dueDate: true } },
    },
  });
  if (!a) return null;
  const status = a.status;
  // Reopened or resubmitted since the review: the review email would be stale.
  if (status !== "APPROVED" && status !== "REJECTED") return null;
  return {
    recipients: taskReviewedRecipients(a),
    render: (recipient) =>
      taskReviewedEmail({
        appUrl: cfg.appUrl,
        recipient,
        status,
        task: { title: a.task.title, dueDate: dbToDateOnly(a.task.dueDate) },
        reviewerName: a.reviewedBy?.name ?? null,
        reviewNote: a.reviewNote,
        today: cfg.today,
      }),
  };
}

async function planTaskAssigned(db: Db, event: EventOf<"task.assigned">, cfg: DeliverConfig): Promise<Plan | null> {
  const task = await db.task.findUnique({
    where: { id: event.taskId },
    select: {
      id: true,
      title: true,
      description: true,
      dueDate: true,
      priority: true,
      subteam: true,
      createdById: true,
      createdBy: { select: { name: true } },
    },
  });
  if (!task) return null;
  return {
    recipients: await taskAssignedRecipients(db, task, event.userIds, event.actorId),
    render: (recipient) =>
      taskAssignedEmail({
        appUrl: cfg.appUrl,
        recipient,
        task: {
          title: task.title,
          description: task.description,
          dueDate: dbToDateOnly(task.dueDate),
          priority: task.priority,
          subteam: task.subteam,
        },
        creatorName: task.createdBy.name,
        today: cfg.today,
      }),
  };
}

async function planAccountPending(db: Db, event: EventOf<"account.pending">, cfg: DeliverConfig): Promise<Plan | null> {
  const user = await db.user.findUnique({
    where: { id: event.userId },
    select: { id: true, name: true, email: true, role: true, subteam: true, status: true },
  });
  // Already approved/rejected (or deleted) by the time we got here: nothing to ask the admins.
  if (!user || user.status !== "PENDING") return null;
  return {
    recipients: await accountPendingRecipients(db, user.id),
    render: (recipient) => accountPendingEmail({ appUrl: cfg.appUrl, recipient, user }),
  };
}

async function planAccountApproved(db: Db, event: EventOf<"account.approved">, cfg: DeliverConfig): Promise<Plan | null> {
  const user = await db.user.findUnique({ where: { id: event.userId }, select: recipientSelect });
  if (!user) return null;
  return {
    recipients: accountApprovedRecipients(user),
    render: (recipient) =>
      accountApprovedEmail({ appUrl: cfg.appUrl, recipient, role: user.role, subteam: user.subteam }),
  };
}

async function planPasswordReset(db: Db, event: EventOf<"password.reset">, cfg: DeliverConfig): Promise<Plan | null> {
  const user = await db.user.findUnique({ where: { id: event.userId }, select: recipientSelect });
  if (!user) return null;
  return {
    recipients: passwordResetRecipients(user),
    render: (recipient) => passwordResetEmail({ appUrl: cfg.appUrl, recipient, resetUrl: event.resetUrl }),
  };
}

async function planPasswordChanged(db: Db, event: EventOf<"password.changed">, cfg: DeliverConfig): Promise<Plan | null> {
  const user = await db.user.findUnique({ where: { id: event.userId }, select: recipientSelect });
  if (!user) return null;
  return {
    // Same audience rule as reset links: always sent (no preference), never to DISABLED accounts.
    recipients: passwordResetRecipients(user),
    render: (recipient) => passwordChangedEmail({ appUrl: cfg.appUrl, recipient }),
  };
}

async function planResourceSubmitted(db: Db, event: EventOf<"resource.submitted">, cfg: DeliverConfig): Promise<Plan | null> {
  const r = await db.resource.findUnique({
    where: { id: event.resourceId },
    select: {
      id: true,
      title: true,
      description: true,
      type: true,
      url: true,
      status: true,
      createdById: true,
      createdBy: { select: personSelect },
      file: { select: { filename: true, size: true } },
    },
  });
  // Already reviewed (or removed) by the time we got here: nothing to approve any more.
  if (!r || r.status !== "PENDING" || !r.createdById || !r.createdBy) return null;
  const submitter = r.createdBy;
  return {
    recipients: await resourceSubmittedRecipients(db, { createdById: r.createdById, submitterSubteam: submitter.subteam }),
    render: (recipient) =>
      resourceSubmittedEmail({
        appUrl: cfg.appUrl,
        recipient,
        resource: { id: r.id, title: r.title, description: r.description, type: r.type, url: r.url, file: r.file },
        submitter,
      }),
  };
}

async function planResourceReviewed(db: Db, event: EventOf<"resource.reviewed">, cfg: DeliverConfig): Promise<Plan | null> {
  const r = await db.resource.findUnique({
    where: { id: event.resourceId },
    select: {
      id: true,
      title: true,
      status: true,
      reviewNote: true,
      reviewedById: true,
      reviewedBy: { select: { name: true } },
      createdBy: { select: recipientSelect },
    },
  });
  if (!r) return null;
  const status = r.status;
  // Edited and sent again since the review: the review email would be stale.
  if (status !== "APPROVED" && status !== "REJECTED") return null;
  return {
    recipients: resourceReviewedRecipients(r),
    render: (recipient) =>
      resourceReviewedEmail({
        appUrl: cfg.appUrl,
        recipient,
        status,
        resource: { id: r.id, title: r.title },
        reviewerName: r.reviewedBy?.name ?? null,
        reviewNote: r.reviewNote,
      }),
  };
}
