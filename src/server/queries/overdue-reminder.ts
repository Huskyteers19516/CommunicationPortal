// The overdue reminder (Manage → Progress → Overdue reminder): who in the actor's scope has overdue checklist items,
// for a leader to paste into an email. Admin access only. Same scope as the progress pages — all-scope staff pick the
// whole team or one subteam; subteam leaders always get their own subteam. Same overdue definition as every overdue
// count (overdueItemsWhere). Selects only names, emails, task titles, and due dates.
import "server-only";
import { type Subteam } from "@/generated/prisma/enums";
import { SUBTEAMS } from "@/lib/constants";
import { type DateOnly, dbToDateOnly } from "@/lib/dates";
import type { ReminderPerson } from "@/lib/overdue-reminder";
import type { Actor } from "../actor";
import { type Db, prisma } from "../db";
import { ForbiddenError } from "../errors";
import { canAdminister, hasAllScope, ledSubteam } from "../permissions";
import { manageableMembersWhere } from "../scopes";
import { isOverdueWhere, overdueItemsWhere, parseSubteamFilter } from "./progress";

/** Most overdue items listed (far more than the team ever has); the page says when there are more. */
export const OVERDUE_REMINDER_MAX = 500;

export interface OverdueReminderPerson extends ReminderPerson {
  id: string;
}

export interface OverdueReminderData {
  /** All-scope staff choose the group; subteam leaders are locked to theirs. */
  canPickSubteam: boolean;
  /** The group shown: a subteam, or null for everyone in scope (the whole team). */
  subteam: Subteam | null;
  /** How many people in each group have something overdue (for the group tabs). */
  peopleCounts: { all: number } & Record<Subteam, number>;
  /** By name; each person's items by due date (oldest first), then title. */
  people: OverdueReminderPerson[];
  /** Overdue items in the group, including any past OVERDUE_REMINDER_MAX. */
  itemCount: number;
  /** More than OVERDUE_REMINDER_MAX items: `people` lists only the oldest ones. */
  truncated: boolean;
}

const byName = new Intl.Collator("en", { sensitivity: "base" });

export async function getOverdueReminder(
  actor: Actor,
  options: { subteam?: unknown },
  today: DateOnly,
  db: Db = prisma,
): Promise<OverdueReminderData> {
  if (!canAdminister(actor)) throw new ForbiddenError();
  const canPickSubteam = hasAllScope(actor);
  // Subteam leaders are locked to their own subteam no matter what the URL says.
  const subteam = canPickSubteam ? (parseSubteamFilter(options.subteam) ?? null) : ledSubteam(actor);

  const scope = manageableMembersWhere(actor);
  const people = subteam ? { AND: [scope, { subteam }] } : scope;
  const overdue = overdueItemsWhere(people, today);

  const [rows, itemCount, behind] = await Promise.all([
    db.taskAssignment.findMany({
      where: overdue,
      select: {
        user: { select: { id: true, name: true, email: true } },
        task: { select: { title: true, dueDate: true } },
      },
      orderBy: [{ task: { dueDate: "asc" } }, { id: "asc" }],
      take: OVERDUE_REMINDER_MAX,
    }),
    db.taskAssignment.count({ where: overdue }),
    db.user.findMany({ where: { AND: [scope, { assignments: { some: isOverdueWhere(today) } }] }, select: { subteam: true } }),
  ]);

  const peopleCounts = { all: behind.length, ...Object.fromEntries(SUBTEAMS.map((s) => [s, 0])) } as OverdueReminderData["peopleCounts"];
  for (const person of behind) if (person.subteam) peopleCounts[person.subteam] += 1;

  const byPerson = new Map<string, OverdueReminderPerson>();
  for (const row of rows) {
    let person = byPerson.get(row.user.id);
    if (!person) byPerson.set(row.user.id, (person = { ...row.user, items: [] }));
    person.items.push({ title: row.task.title, dueDate: dbToDateOnly(row.task.dueDate) });
  }
  const list = [...byPerson.values()].sort((a, b) => byName.compare(a.name, b.name) || a.id.localeCompare(b.id));
  for (const person of list) {
    person.items.sort((a, b) => a.dueDate.localeCompare(b.dueDate) || byName.compare(a.title, b.title));
  }

  return { canPickSubteam, subteam, peopleCounts, people: list, itemCount, truncated: itemCount > rows.length };
}
