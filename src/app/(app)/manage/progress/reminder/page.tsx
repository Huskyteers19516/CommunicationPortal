import { PartyPopper } from "lucide-react";
import type { Metadata } from "next";
import { overdueReminderHref, scopeLabel, subteamGroupLabel, teamProgressHref } from "@/components/manage/progress-links";
import { OverdueReminderComposer } from "@/components/manage/overdue-reminder-composer";
import { BackLink } from "@/components/tasks/back-link";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { LinkTabs } from "@/components/ui/link-tabs";
import { PageHeader } from "@/components/ui/page-header";
import { SUBTEAMS } from "@/lib/constants";
import { formatDateOnly, relativeDueLabel, todayInTimezone } from "@/lib/dates";
import { buildOverdueReminder } from "@/lib/overdue-reminder";
import { requireAdminUser } from "@/server/auth/session";
import { env } from "@/server/env";
import { getOverdueReminder, OVERDUE_REMINDER_MAX } from "@/server/queries/overdue-reminder";
import { parseProgressRange } from "@/server/queries/progress";

export const metadata: Metadata = { title: "Overdue reminder" };

/**
 * Overdue reminder (admin access): who has overdue tasks, as an email to copy — the portal can't send it from a team
 * address, so a leader pastes it into their own. All-scope staff pick the whole team or one subteam.
 */
export default async function OverdueReminderPage({ searchParams }: PageProps<"/manage/progress/reminder">) {
  const actor = await requireAdminUser();
  const sp = await searchParams;
  const today = todayInTimezone(env.teamTimezone);
  const data = await getOverdueReminder(actor, { subteam: sp.subteam }, today);
  // Team progress's range rides along (unused here) so "← Team progress" lands back where they were.
  const range = sp.range === undefined ? undefined : parseProgressRange(sp.range);
  const pickedSubteam = data.canPickSubteam ? data.subteam : null;
  const groupLabel = data.subteam ? subteamGroupLabel(data.subteam) : null;
  const reminder = buildOverdueReminder({
    people: data.people,
    groupLabel,
    today,
    myTasksUrl: `${env.appUrl}/my-tasks`,
    senderName: actor.name,
  });
  const where = groupLabel ? `the ${groupLabel} team` : "the team";

  return (
    <>
      <BackLink href={teamProgressHref({ range, subteam: pickedSubteam })}>Team progress</BackLink>
      <PageHeader
        eyebrow={scopeLabel(actor)}
        title="Overdue reminder"
        description="Everyone with tasks past their due date, written up as an email. Copy it into your own email — nothing is sent from here."
      />

      {data.canPickSubteam && (
        <LinkTabs
          className="mb-6"
          tabs={[
            { href: overdueReminderHref({ range }), label: "Whole team", active: data.subteam === null, count: data.peopleCounts.all },
            ...SUBTEAMS.map((s) => ({
              href: overdueReminderHref({ range, subteam: s }),
              label: subteamGroupLabel(s),
              active: data.subteam === s,
              count: data.peopleCounts[s],
            })),
          ]}
        />
      )}

      {data.people.length === 0 ? (
        <Card>
          <EmptyState
            icon={PartyPopper}
            title="Nobody is behind"
            description={`No one on ${where} has an overdue task as of ${formatDateOnly(today, today)}. Nothing to send.`}
          />
        </Card>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] lg:items-start">
          <Card>
            <CardHeader
              title="Email"
              description={`${data.people.length} ${data.people.length === 1 ? "person" : "people"} · ${data.itemCount} overdue ${data.itemCount === 1 ? "task" : "tasks"}`}
            />
            <CardBody>
              {data.truncated && (
                <p className="mb-4 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
                  Only the {OVERDUE_REMINDER_MAX} oldest overdue tasks are listed.
                </p>
              )}
              {/* Keyed by the text itself: new data (another group, someone caught up, a new day) starts fresh, while
                  a refresh that changes nothing keeps any edits. */}
              <OverdueReminderComposer key={`${reminder.subject}\n${reminder.body}`} reminder={reminder} />
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Who's on it" description="By name · oldest task first" />
            <ul className="divide-y divide-ink-100">
              {data.people.map((person) => (
                <li key={person.id} className="px-4 py-3 sm:px-5">
                  <p className="text-sm font-semibold text-ink-900">{person.name}</p>
                  <ul className="mt-1 space-y-1">
                    {person.items.map((item, i) => (
                      <li key={i} className="flex items-baseline justify-between gap-3 text-sm">
                        <span className="min-w-0 break-words text-ink-700">{item.title}</span>
                        <span className="shrink-0 text-xs font-medium text-red-700">{relativeDueLabel(item.dueDate, today)}</span>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      )}
    </>
  );
}
