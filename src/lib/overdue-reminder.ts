// The overdue reminder (Manage → Progress → Overdue reminder): plain text a leader pastes into their own email,
// since the portal can't send it from a team address. Only what the Task dashboard already shows everyone — who's on
// what and when it was due — never notes, review notes, or whether an item was sent back.
import { type DateOnly, daysBetween, dateOnlyToDb } from "./dates";

export interface ReminderItem {
  title: string;
  dueDate: DateOnly;
}

export interface ReminderPerson {
  name: string;
  email: string;
  items: ReminderItem[];
}

export interface OverdueReminderText {
  /** The people's emails, comma-separated, for the To line. */
  recipients: string;
  subject: string;
  body: string;
}

/** Names and titles on one line each: line breaks or runs of spaces would break the layout of the message. */
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

/** "Oct 11" */
function shortDate(value: DateOnly): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" }).format(dateOnlyToDb(value));
}

/** "Mon, Sep 28" (the year too when it isn't this year's). */
function dueDate(value: DateOnly, today: DateOnly): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(value.slice(0, 4) === today.slice(0, 4) ? {} : { year: "numeric" }),
  }).format(dateOnlyToDb(value));
}

function daysLate(due: DateOnly, today: DateOnly): string {
  const days = daysBetween(due, today);
  return days === 1 ? "1 day late" : `${days} days late`;
}

/**
 * The reminder for `people` (already sorted, each with at least one item). `groupLabel` is the subteam ("Build") or
 * null for the whole team; `myTasksUrl` is where people check things off; `senderName` signs it.
 */
export function buildOverdueReminder(input: {
  people: ReminderPerson[];
  groupLabel: string | null;
  today: DateOnly;
  myTasksUrl: string;
  senderName: string;
}): OverdueReminderText {
  const { people, groupLabel, today } = input;
  const recipients = [...new Set(people.map((p) => p.email.trim().toLowerCase()).filter(Boolean))].join(", ");
  const subject = groupLabel
    ? `Reminder: overdue tasks for the ${groupLabel} team (${shortDate(today)})`
    : `Reminder: overdue tasks (${shortDate(today)})`;

  const lists = people.map((person) =>
    [
      oneLine(person.name),
      ...person.items.map((item) => `- ${oneLine(item.title)} — due ${dueDate(item.dueDate, today)} (${daysLate(item.dueDate, today)})`),
    ].join("\n"),
  );
  const body = [
    groupLabel ? `Hi ${groupLabel} team,` : "Hi everyone,",
    "These tasks are past their due date and haven't been checked off yet:",
    ...lists,
    `Please finish them and check them off in the portal: ${input.myTasksUrl}`,
    "If you're stuck or need more time, just reply and let me know.",
    `Thanks,\n${oneLine(input.senderName)}`,
  ].join("\n\n");

  return { recipients, subject, body };
}

/** Phones' mail apps can't take a very long mailto: link; past this, people copy and paste instead. */
export const MAILTO_MAX = 1800;

/** A mailto: link that opens the reminder in the email app, or null when it's too long for one. */
export function reminderMailto({ recipients, subject, body }: OverdueReminderText): string | null {
  const to = recipients
    .split(", ")
    .filter(Boolean)
    .map((email) => encodeURIComponent(email))
    .join(",");
  const href = `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  return href.length <= MAILTO_MAX ? href : null;
}
