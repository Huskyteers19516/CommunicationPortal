// Email templates for notification events: one function per event type, each returning
// { subject, text, html }. Every template is built from plain-text pieces that are escaped
// in exactly one place (render()), so user content can never inject HTML or mail headers.
//
// No "server-only" / next/* imports: this runs inside after() and in tests.
import type { Priority, ResourceType, Role, Subteam } from "@/generated/prisma/enums";
import {
  APP_NAME,
  PRIORITY_LABELS,
  RESOURCE_TYPE_LABELS,
  ROLE_LABELS,
  SUBTEAM_LABELS,
  TEAM_NAME,
  TEAM_NUMBER,
} from "@/lib/constants";
import { type DateOnly, daysBetween, formatDateOnly } from "@/lib/dates";
import { formatFileSize } from "@/lib/files";

export interface EmailContent {
  subject: string;
  text: string;
  html: string;
}

export const EMAIL_COLORS = {
  /** Brand green: thin accents only (quote border). White text on it is 3.2:1 and fails WCAG AA. */
  brand: "#4CA256",
  /** Darker brand green (app `brand-600`): header bar and button behind white text (4.55:1), and links. */
  brandStrong: "#3A8543",
  gray: "#6D6E73",
  ink: "#1F2023",
  canvas: "#F3F4F1",
  border: "#E4E5E1",
  quote: "#F4F8F3",
  white: "#FFFFFF",
} as const;

/** Max characters of user-written text (question body, reply, description) quoted in an email. */
export const EXCERPT_MAX = 500;
const SUBJECT_MAX = 180;
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

// ---------------------------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------------------------

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escape text for use in HTML element content and double-quoted attributes. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);
}

/** C0/C1 control characters plus Unicode line/paragraph separators. */
function isControl(code: number): boolean {
  return code < 0x20 || code === 0x7f || (code >= 0x80 && code < 0xa0) || code === 0x2028 || code === 0x2029;
}

/** Turn any text into one line: control characters and newlines become spaces, whitespace collapses. */
export function singleLine(value: string): string {
  let out = "";
  for (const ch of value) out += isControl(ch.codePointAt(0) ?? 0) ? " " : ch;
  return out.replace(/\s+/g, " ").trim();
}

/** Shorten to at most `max` characters (code points), ending with "…" when cut. */
export function truncate(value: string, max: number): string {
  const chars = Array.from(value);
  if (chars.length <= max) return value;
  return `${chars.slice(0, Math.max(0, max - 1)).join("").trimEnd()}…`;
}

/**
 * A safe email subject: no CR/LF or other control characters (so it can't inject headers),
 * whitespace collapsed, and a sensible length.
 */
export function cleanSubject(value: string): string {
  return truncate(singleLine(value), SUBJECT_MAX);
}

/** Multi-line user text for quoting: normalised newlines, no control characters, ≤ `max` characters. */
export function excerpt(value: string, max = EXCERPT_MAX): string {
  let out = "";
  for (const ch of value.replace(/\r\n?/g, "\n")) {
    const code = ch.codePointAt(0) ?? 0;
    out += ch === "\n" ? "\n" : isControl(code) ? " " : ch;
  }
  out = out
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return truncate(out, max);
}

function firstName(name: string): string {
  return singleLine(name).split(" ")[0] || "there";
}

/** "Build member", "Software Leader", "Captain"… */
export function roleLabel(role: Role, subteam: Subteam | null): string {
  if (role === "MEMBER") return subteam ? `${SUBTEAM_LABELS[subteam]} member` : "Member";
  return ROLE_LABELS[role];
}

/** "Mon, Sep 28 (tomorrow)". */
export function formatDue(due: DateOnly, today: DateOnly): string {
  const diff = daysBetween(today, due);
  const suffix = diff === 0 ? " (today)" : diff === 1 ? " (tomorrow)" : diff < 0 ? " (overdue)" : "";
  return `${formatDateOnly(due, today)}${suffix}`;
}

function quoted(title: string): string {
  return `“${singleLine(title)}”`;
}

/** Only http(s) links make it into an email; anything else falls back to the app's home page. */
function safeUrl(url: string, appUrl: string): string {
  return /^https?:\/\//i.test(url) ? url : appUrl;
}

function joinUrl(appUrl: string, path: string): string {
  return `${appUrl.replace(/\/+$/, "")}${path}`;
}

// ---------------------------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------------------------

type Inline = string | { strong: string };
type Paragraph = Inline[];

interface EmailLayout {
  appUrl: string;
  subject: string;
  /** Inbox preview text. */
  preheader: string;
  heading: string;
  greeting?: string;
  paragraphs: Paragraph[];
  details?: Array<[label: string, value: string] | null>;
  quote?: { label: string; text: string } | null;
  closing?: Paragraph[];
  cta: { label: string; url: string };
  /** Small print under the button. */
  notes?: string[];
  /** "preferences" adds the notification-settings footer (for emails a user can turn off). */
  footer: "preferences" | "none";
}

const S = {
  p: `margin:0 0 14px;font-family:${FONT};font-size:15px;line-height:1.55;color:${EMAIL_COLORS.ink};`,
  small: `margin:0 0 8px;font-family:${FONT};font-size:13px;line-height:1.5;color:${EMAIL_COLORS.gray};`,
  link: `color:${EMAIL_COLORS.brandStrong};text-decoration:underline;word-break:break-all;`,
};

function inlineHtml(parts: Paragraph): string {
  return parts
    .map((part) =>
      typeof part === "string"
        ? escapeHtml(part)
        : `<strong style="font-weight:600;color:${EMAIL_COLORS.ink};">${escapeHtml(part.strong)}</strong>`,
    )
    .join("");
}

function inlineText(parts: Paragraph): string {
  return parts.map((part) => (typeof part === "string" ? part : part.strong)).join("");
}

function renderHtml(l: EmailLayout, subject: string, ctaUrl: string): string {
  const out: string[] = [];
  out.push(
    `<h1 style="margin:0 0 16px;font-family:${FONT};font-size:20px;line-height:1.3;font-weight:700;color:${EMAIL_COLORS.ink};">${escapeHtml(l.heading)}</h1>`,
  );
  if (l.greeting) out.push(`<p style="${S.p}">${escapeHtml(l.greeting)}</p>`);
  for (const para of l.paragraphs) out.push(`<p style="${S.p}">${inlineHtml(para)}</p>`);

  const details = (l.details ?? []).filter((d): d is [string, string] => d !== null);
  if (details.length) {
    const rows = details
      .map(
        ([label, value]) =>
          `<tr><td valign="top" style="padding:4px 12px 4px 0;font-family:${FONT};font-size:14px;line-height:1.45;color:${EMAIL_COLORS.gray};white-space:nowrap;">${escapeHtml(label)}</td>` +
          `<td valign="top" style="padding:4px 0;font-family:${FONT};font-size:14px;line-height:1.45;color:${EMAIL_COLORS.ink};word-break:break-word;">${escapeHtml(value)}</td></tr>`,
      )
      .join("");
    out.push(
      `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px;border-collapse:collapse;">${rows}</table>`,
    );
  }

  if (l.quote && l.quote.text) {
    const body = escapeHtml(l.quote.text).replace(/\n/g, "<br>");
    out.push(
      `<p style="${S.small}">${escapeHtml(l.quote.label)}</p>` +
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px;border-collapse:collapse;">` +
        `<tr><td bgcolor="${EMAIL_COLORS.quote}" style="background-color:${EMAIL_COLORS.quote};border-left:3px solid ${EMAIL_COLORS.brand};padding:12px 14px;font-family:${FONT};font-size:14px;line-height:1.55;color:${EMAIL_COLORS.ink};word-break:break-word;">${body}</td></tr></table>`,
    );
  }

  for (const para of l.closing ?? []) out.push(`<p style="${S.p}">${inlineHtml(para)}</p>`);

  const href = escapeHtml(ctaUrl);
  out.push(
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:22px 0 18px;">` +
      `<tr><td align="center" bgcolor="${EMAIL_COLORS.brandStrong}" style="background-color:${EMAIL_COLORS.brandStrong};border-radius:6px;">` +
      `<a href="${href}" target="_blank" style="display:inline-block;padding:12px 24px;font-family:${FONT};font-size:15px;line-height:20px;font-weight:700;color:${EMAIL_COLORS.white};text-decoration:none;border-radius:6px;">${escapeHtml(l.cta.label)}</a>` +
      `</td></tr></table>`,
  );
  for (const note of l.notes ?? []) out.push(`<p style="${S.small}">${escapeHtml(note)}</p>`);
  out.push(
    `<p style="${S.small}">Button not working? Copy this link into your browser:<br><a href="${href}" target="_blank" style="${S.link}">${href}</a></p>`,
  );

  const settingsUrl = escapeHtml(joinUrl(l.appUrl, "/settings"));
  const footer: string[] = [];
  if (l.footer === "preferences") {
    footer.push(
      `You're getting this because of your notification settings. Change them at <a href="${settingsUrl}" target="_blank" style="color:${EMAIL_COLORS.gray};text-decoration:underline;">${settingsUrl}</a>`,
    );
  }
  footer.push(`${escapeHtml(TEAM_NAME)} &middot; FTC Team ${TEAM_NUMBER} &middot; ${escapeHtml(APP_NAME)}`);

  return [
    `<!DOCTYPE html>`,
    `<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="x-apple-disable-message-reformatting"><title>${escapeHtml(subject)}</title></head>`,
    `<body style="margin:0;padding:0;background-color:${EMAIL_COLORS.canvas};">`,
    `<div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;mso-hide:all;font-size:1px;line-height:1px;color:${EMAIL_COLORS.canvas};">${escapeHtml(l.preheader)}</div>`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${EMAIL_COLORS.canvas}" style="background-color:${EMAIL_COLORS.canvas};border-collapse:collapse;">`,
    `<tr><td align="center" style="padding:24px 12px;">`,
    `<!--[if mso]><table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%;border-collapse:separate;">`,
    `<tr><td bgcolor="${EMAIL_COLORS.brandStrong}" style="background-color:${EMAIL_COLORS.brandStrong};padding:14px 24px;border-radius:8px 8px 0 0;font-family:${FONT};font-size:13px;line-height:18px;font-weight:700;letter-spacing:2px;color:${EMAIL_COLORS.white};">THE HUSKYTEERS &middot; ${TEAM_NUMBER}</td></tr>`,
    `<tr><td bgcolor="${EMAIL_COLORS.white}" style="background-color:${EMAIL_COLORS.white};padding:28px 24px 20px;border:1px solid ${EMAIL_COLORS.border};border-top:0;border-radius:0 0 8px 8px;">`,
    out.join("\n"),
    `</td></tr>`,
    `<tr><td align="center" style="padding:16px 24px 8px;font-family:${FONT};font-size:12px;line-height:1.5;color:${EMAIL_COLORS.gray};">${footer.join("<br>")}</td></tr>`,
    `</table>`,
    `<!--[if mso]></td></tr></table><![endif]-->`,
    `</td></tr></table>`,
    `</body></html>`,
  ].join("\n");
}

function renderText(l: EmailLayout, ctaUrl: string): string {
  const blocks: string[] = [];
  if (l.greeting) blocks.push(l.greeting);
  for (const para of l.paragraphs) blocks.push(inlineText(para));
  const details = (l.details ?? []).filter((d): d is [string, string] => d !== null);
  if (details.length) blocks.push(details.map(([label, value]) => `${label}: ${value}`).join("\n"));
  if (l.quote && l.quote.text) {
    blocks.push(`${l.quote.label}\n${l.quote.text.split("\n").map((line) => (line ? `> ${line}` : ">")).join("\n")}`);
  }
  for (const para of l.closing ?? []) blocks.push(inlineText(para));
  blocks.push(`${l.cta.label}: ${ctaUrl}`);
  for (const note of l.notes ?? []) blocks.push(note);
  const footer: string[] = [];
  if (l.footer === "preferences") {
    footer.push(
      `You're getting this because of your notification settings. Change them at ${joinUrl(l.appUrl, "/settings")}`,
    );
  }
  footer.push(`${TEAM_NAME} · FTC Team ${TEAM_NUMBER} · ${APP_NAME}`);
  blocks.push(`--\n${footer.join("\n")}`);
  return `${blocks.join("\n\n")}\n`;
}

function render(layout: EmailLayout): EmailContent {
  const subject = cleanSubject(layout.subject);
  const ctaUrl = safeUrl(layout.cta.url, layout.appUrl);
  return { subject, text: renderText(layout, ctaUrl), html: renderHtml(layout, subject, ctaUrl) };
}

// ---------------------------------------------------------------------------------------------
// Templates (one per event type)
// ---------------------------------------------------------------------------------------------

export interface EmailPerson {
  name: string;
  role: Role;
  subteam: Subteam | null;
}

interface TemplateBase {
  appUrl: string;
  recipient: { id: string; name: string };
}

function describe(person: EmailPerson): string {
  return `${singleLine(person.name)} (${roleLabel(person.role, person.subteam)})`;
}

function preview(text: string): string {
  return truncate(singleLine(text), 140);
}

export interface QuestionAskedInput extends TemplateBase {
  question: {
    id: string;
    title: string;
    body: string;
    subteam: Subteam | null;
    recipientId: string | null;
    taskTitle: string | null;
  };
  asker: EmailPerson;
}

export function questionAskedEmail(input: QuestionAskedInput): EmailContent {
  const { question: q, asker } = input;
  const direct = q.recipientId === input.recipient.id;
  const audience = direct
    ? " asked you a question."
    : q.subteam
      ? ` asked a question for the ${SUBTEAM_LABELS[q.subteam]} subteam.`
      : " asked a question for the whole team.";
  return render({
    appUrl: input.appUrl,
    subject: `New question from ${singleLine(asker.name)}: ${singleLine(q.title)}`,
    preheader: preview(q.body),
    heading: "New question",
    greeting: `Hi ${firstName(input.recipient.name)},`,
    paragraphs: [[{ strong: describe(asker) }, audience]],
    details: [["Question", singleLine(q.title)], q.taskTitle ? ["About task", singleLine(q.taskTitle)] : null],
    quote: { label: "What they asked:", text: excerpt(q.body) },
    cta: { label: "Open the question", url: joinUrl(input.appUrl, `/questions/${encodeURIComponent(q.id)}`) },
    footer: "preferences",
  });
}

export interface QuestionRepliedInput extends TemplateBase {
  /** "asker": staff replied, the email goes to the asker. "staff": the asker followed up. */
  audience: "asker" | "staff";
  question: { id: string; title: string };
  author: EmailPerson;
  reply: { body: string };
}

export function questionRepliedEmail(input: QuestionRepliedInput): EmailContent {
  const { question: q, author } = input;
  const toAsker = input.audience === "asker";
  return render({
    appUrl: input.appUrl,
    subject: toAsker
      ? `${singleLine(author.name)} replied: ${singleLine(q.title)}`
      : `${singleLine(author.name)} followed up: ${singleLine(q.title)}`,
    preheader: preview(input.reply.body),
    heading: toAsker ? "New reply to your question" : "Follow-up on a question",
    greeting: `Hi ${firstName(input.recipient.name)},`,
    paragraphs: [
      toAsker
        ? [{ strong: describe(author) }, " replied to your question ", { strong: quoted(q.title) }, "."]
        : [{ strong: describe(author) }, " added a follow-up to ", { strong: quoted(q.title) }, "."],
    ],
    quote: { label: toAsker ? "Their reply:" : "Their follow-up:", text: excerpt(input.reply.body) },
    cta: {
      label: toAsker ? "View the reply" : "Open the question",
      url: joinUrl(input.appUrl, `/questions/${encodeURIComponent(q.id)}`),
    },
    footer: "preferences",
  });
}

export interface TaskSubmittedInput extends TemplateBase {
  /**
   * Where the "Review it" button goes: the task page (default), or the Review queue for someone who
   * reviews this item but can't open the task (a subteam leader on a whole-team task).
   */
  reviewFrom?: "task" | "queue";
  task: { id: string; title: string; dueDate: DateOnly };
  submitter: EmailPerson;
  submissionNote: string | null;
  today: DateOnly;
}

export function taskSubmittedEmail(input: TaskSubmittedInput): EmailContent {
  const { task, submitter } = input;
  const note = input.submissionNote ? excerpt(input.submissionNote, 1000) : "";
  return render({
    appUrl: input.appUrl,
    subject: `${singleLine(submitter.name)} checked off ${quoted(task.title)}`,
    preheader: `It counts as done once you approve it.`,
    heading: "Ready for your review",
    greeting: `Hi ${firstName(input.recipient.name)},`,
    paragraphs: [
      [
        { strong: describe(submitter) },
        " checked off ",
        { strong: quoted(task.title) },
        ". It counts as done once you approve it.",
      ],
    ],
    details: [["Due", formatDue(task.dueDate, input.today)]],
    quote: note ? { label: "Their note:", text: note } : null,
    cta: {
      label: "Review it",
      url: joinUrl(
        input.appUrl,
        input.reviewFrom === "queue" ? "/manage/review" : `/manage/tasks/${encodeURIComponent(task.id)}`,
      ),
    },
    footer: "preferences",
  });
}

export interface TaskReviewedInput extends TemplateBase {
  status: "APPROVED" | "REJECTED";
  task: { title: string; dueDate: DateOnly };
  reviewerName: string | null;
  reviewNote: string | null;
  today: DateOnly;
}

export function taskReviewedEmail(input: TaskReviewedInput): EmailContent {
  const { task } = input;
  const reviewer = input.reviewerName ? singleLine(input.reviewerName) : "A leader";
  const note = input.reviewNote ? excerpt(input.reviewNote, 1000) : "";
  const todayUrl = joinUrl(input.appUrl, "/today");
  const greeting = `Hi ${firstName(input.recipient.name)},`;
  if (input.status === "APPROVED") {
    return render({
      appUrl: input.appUrl,
      subject: `Approved: ${singleLine(task.title)}`,
      preheader: `${reviewer} approved it. It now officially counts as done.`,
      heading: "Approved. Nice work!",
      greeting,
      paragraphs: [[{ strong: reviewer }, " approved ", { strong: quoted(task.title) }, ". It now officially counts as done."]],
      quote: note ? { label: `Note from ${reviewer}:`, text: note } : null,
      cta: { label: "Open Today", url: todayUrl },
      footer: "preferences",
    });
  }
  return render({
    appUrl: input.appUrl,
    subject: `Changes requested: ${singleLine(task.title)}`,
    preheader: note ? preview(note) : `${reviewer} sent it back with a note.`,
    heading: "Changes requested",
    greeting,
    paragraphs: [[{ strong: reviewer }, " looked at ", { strong: quoted(task.title) }, " and asked for a few changes."]],
    details: [["Due", formatDue(task.dueDate, input.today)]],
    quote: note ? { label: "What to fix:", text: note } : null,
    closing: [["Make the changes, then check it off again on your Today list."]],
    cta: { label: "Open Today", url: todayUrl },
    footer: "preferences",
  });
}

export interface TaskAssignedInput extends TemplateBase {
  task: { title: string; description: string; dueDate: DateOnly; priority: Priority; subteam: Subteam | null };
  creatorName: string;
  today: DateOnly;
}

export function taskAssignedEmail(input: TaskAssignedInput): EmailContent {
  const { task } = input;
  const due = formatDue(task.dueDate, input.today);
  const description = task.description ? excerpt(task.description) : "";
  return render({
    appUrl: input.appUrl,
    subject: `New task: ${singleLine(task.title)}`,
    preheader: `Due ${due}. From ${singleLine(input.creatorName)}.`,
    heading: "You have a new task",
    greeting: `Hi ${firstName(input.recipient.name)},`,
    paragraphs: [[{ strong: singleLine(input.creatorName) }, " assigned you ", { strong: quoted(task.title) }, "."]],
    details: [
      ["Due", due],
      ["Priority", PRIORITY_LABELS[task.priority]],
      ["Subteam", task.subteam ? SUBTEAM_LABELS[task.subteam] : "Whole team"],
    ],
    quote: description ? { label: "Details:", text: description } : null,
    closing: [["It's on your Today checklist. Check it off when you're done."]],
    cta: { label: "Open Today", url: joinUrl(input.appUrl, "/today") },
    footer: "preferences",
  });
}

export interface AccountPendingInput extends TemplateBase {
  user: { name: string; email: string; role: Role; subteam: Subteam | null };
}

export function accountPendingEmail(input: AccountPendingInput): EmailContent {
  const { user } = input;
  const role = roleLabel(user.role, user.subteam);
  return render({
    appUrl: input.appUrl,
    subject: `Approval needed: ${singleLine(user.name)} signed up as ${role}`,
    preheader: `${singleLine(user.name)} is waiting for your approval.`,
    heading: "New sign-up waiting for approval",
    greeting: `Hi ${firstName(input.recipient.name)},`,
    paragraphs: [[{ strong: singleLine(user.name) }, ` signed up as ${role} and is waiting for your approval.`]],
    details: [
      ["Name", singleLine(user.name)],
      ["Email", singleLine(user.email)],
      ["Role", ROLE_LABELS[user.role]],
      user.subteam ? ["Subteam", SUBTEAM_LABELS[user.subteam]] : null,
    ],
    closing: [["Make sure they're really on the team before you approve."]],
    cta: { label: "Review sign-ups", url: joinUrl(input.appUrl, "/admin") },
    footer: "preferences",
  });
}

export interface AccountApprovedInput extends TemplateBase {
  role: Role;
  subteam: Subteam | null;
}

export function accountApprovedEmail(input: AccountApprovedInput): EmailContent {
  return render({
    appUrl: input.appUrl,
    subject: `You're approved — welcome to the ${APP_NAME}`,
    preheader: "Your account is ready. Sign in to get started.",
    heading: `Welcome, ${firstName(input.recipient.name)}!`,
    paragraphs: [
      ["Your account was approved. You're all set as ", { strong: roleLabel(input.role, input.subteam) }, "."],
      ["Sign in to see your checklist, tasks, and team questions."],
    ],
    cta: { label: "Sign in", url: joinUrl(input.appUrl, "/login") },
    footer: "none",
  });
}

export interface PasswordResetInput extends TemplateBase {
  resetUrl: string;
}

export function passwordResetEmail(input: PasswordResetInput): EmailContent {
  return render({
    appUrl: input.appUrl,
    subject: `Reset your ${APP_NAME} password`,
    preheader: "Use this link to choose a new password. It expires in 1 hour.",
    heading: "Reset your password",
    greeting: `Hi ${firstName(input.recipient.name)},`,
    paragraphs: [[`We got a request to reset the password for your ${APP_NAME} account. Tap the button to choose a new one.`]],
    cta: { label: "Reset password", url: input.resetUrl },
    notes: ["This link expires in 1 hour. If you didn't ask for this, ignore this email."],
    footer: "none",
  });
}

export type PasswordChangedInput = TemplateBase;

export function passwordChangedEmail(input: PasswordChangedInput): EmailContent {
  return render({
    appUrl: input.appUrl,
    subject: `Your ${APP_NAME} password was changed`,
    preheader: "If this was you, there's nothing to do.",
    heading: "Your password was changed",
    greeting: `Hi ${firstName(input.recipient.name)},`,
    paragraphs: [
      [`The password for your ${APP_NAME} account was just changed, and your other devices were signed out.`],
      ["If this was you, there's nothing else to do. If it wasn't, reset your password right away and tell the team admin."],
    ],
    cta: { label: "Reset my password", url: joinUrl(input.appUrl, "/forgot-password") },
    footer: "none",
  });
}

export interface ResourceSubmittedInput extends TemplateBase {
  resource: {
    id: string;
    title: string;
    description: string;
    type: ResourceType;
    url: string;
    file: { filename: string; size: number } | null;
  };
  submitter: EmailPerson;
}

export function resourceSubmittedEmail(input: ResourceSubmittedInput): EmailContent {
  const { resource: r, submitter } = input;
  const description = r.description ? excerpt(r.description) : "";
  return render({
    appUrl: input.appUrl,
    subject: `Approval needed: ${singleLine(submitter.name)} shared ${quoted(r.title)}`,
    preheader: "The team sees it once someone approves it.",
    heading: "A resource is waiting for approval",
    greeting: `Hi ${firstName(input.recipient.name)},`,
    paragraphs: [
      [
        { strong: describe(submitter) },
        " shared ",
        { strong: quoted(r.title) },
        " on the Resources page. The team sees it once someone approves it.",
      ],
    ],
    details: [
      ["Type", RESOURCE_TYPE_LABELS[r.type]],
      r.file
        ? ["File", `${singleLine(r.file.filename)} (${formatFileSize(r.file.size)})`]
        : ["Link", truncate(singleLine(r.url), 200)],
    ],
    quote: description ? { label: "What it is:", text: description } : null,
    closing: [["Check that it's right for the team, then approve it or say what to change."]],
    cta: { label: "Review it", url: joinUrl(input.appUrl, `/resources/${encodeURIComponent(r.id)}`) },
    footer: "preferences",
  });
}

export interface ResourceReviewedInput extends TemplateBase {
  status: "APPROVED" | "REJECTED";
  resource: { id: string; title: string };
  reviewerName: string | null;
  reviewNote: string | null;
}

export function resourceReviewedEmail(input: ResourceReviewedInput): EmailContent {
  const { resource: r } = input;
  const reviewer = input.reviewerName ? singleLine(input.reviewerName) : "A leader";
  const note = input.reviewNote ? excerpt(input.reviewNote, 1000) : "";
  const greeting = `Hi ${firstName(input.recipient.name)},`;
  const cta = { label: "Open it", url: joinUrl(input.appUrl, `/resources/${encodeURIComponent(r.id)}`) };
  if (input.status === "APPROVED") {
    return render({
      appUrl: input.appUrl,
      subject: `Your resource ${quoted(r.title)} was approved`,
      preheader: `${reviewer} approved it. The whole team can see it now.`,
      heading: "Your resource is live",
      greeting,
      paragraphs: [
        [{ strong: reviewer }, " approved ", { strong: quoted(r.title) }, ". Everyone on the team can see it on the Resources page now."],
      ],
      quote: note ? { label: `Note from ${reviewer}:`, text: note } : null,
      cta,
      footer: "preferences",
    });
  }
  return render({
    appUrl: input.appUrl,
    subject: `Your resource ${quoted(r.title)} was sent back`,
    preheader: note ? preview(note) : `${reviewer} looked at it and sent it back.`,
    heading: "Your resource was sent back",
    greeting,
    paragraphs: [[{ strong: reviewer }, " looked at ", { strong: quoted(r.title) }, " and sent it back to you."]],
    quote: note ? { label: "Why:", text: note } : null,
    closing: [["You can change it and send it again, or remove it. Until then only you and the leaders can see it."]],
    cta,
    footer: "preferences",
  });
}
