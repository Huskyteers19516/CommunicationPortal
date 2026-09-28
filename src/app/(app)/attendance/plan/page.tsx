import { CalendarDays, CalendarPlus, ClipboardPlus } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { DayTileList } from "@/components/attendance/day-tile-list";
import { ExtraMeetingBadge, ExtraMeetingLinks } from "@/components/attendance/extra-meeting";
import { DayPlanForm } from "@/components/attendance/session-forms";
import { WeekPill } from "@/components/attendance/week-progress";
import { BackLink } from "@/components/tasks/back-link";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import type { Subteam } from "@/generated/prisma/enums";
import { formatPeriod, nearDayLabel } from "@/lib/attendance";
import { cn } from "@/lib/cn";
import { SUBTEAM_LABELS, SUBTEAMS } from "@/lib/constants";
import { formatDateOnly, todayInTimezone } from "@/lib/dates";
import { requireActiveUser } from "@/server/auth/session";
import { env } from "@/server/env";
import { canManageCalendar, canPlanAttendance } from "@/server/permissions";
import { type ComingPerson, getComingOverview } from "@/server/queries/attendance";

export const metadata: Metadata = { title: "Who's coming" };

function first(v: string | string[] | undefined) {
  return Array.isArray(v) ? v[0] : v;
}

const GROUP_ORDER: (Subteam | null)[] = [...SUBTEAMS, null];

/** People grouped by subteam (then no subteam: captain, mentors…), with their notes and their week so far. */
function PeopleList({ people, empty, target }: { people: ComingPerson[]; empty: string; target: number }) {
  if (people.length === 0) return <p className="text-sm text-ink-500">{empty}</p>;
  return (
    <div className="space-y-3">
      {GROUP_ORDER.map((subteam) => {
        const group = people.filter((p) => p.subteam === subteam);
        if (group.length === 0) return null;
        return (
          <div key={subteam ?? "none"}>
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-500">
              {subteam ? SUBTEAM_LABELS[subteam] : "No subteam"} ({group.length})
            </p>
            <ul className="space-y-1">
              {group.map((p) => (
                <li key={p.id} className="text-sm text-ink-900">
                  <span className="font-medium wrap-anywhere">{p.name}</span> <WeekPill total={p.week.total} target={target} label="that week so far" />
                  {p.note && <span className="text-ink-500 wrap-anywhere"> — {p.note}</span>}
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

function AnswerBlock({
  title,
  tone,
  people,
  empty,
  target,
}: {
  title: string;
  tone: string;
  people: ComingPerson[];
  empty: string;
  target: number;
}) {
  return (
    <div className="rounded-xl border border-ink-200 bg-white p-4">
      <h3 className="mb-2 flex items-center gap-2 font-semibold text-ink-900">
        <span className={cn("inline-block size-2.5 rounded-full", tone)} aria-hidden />
        {title} <span className="font-normal text-ink-500">({people.length})</span>
      </h3>
      <PeopleList people={people} empty={empty} target={target} />
    </div>
  );
}

/** Staff: who's coming on each of the next team days, and the plan for the day. */
export default async function PlanPage({ searchParams }: PageProps<"/attendance/plan">) {
  const actor = await requireActiveUser();
  if (!canPlanAttendance(actor)) redirect("/attendance");
  const sp = await searchParams;
  const today = todayInTimezone(env.teamTimezone);
  const overview = await getComingOverview(actor, today, first(sp.day));
  if (!overview) redirect("/attendance");
  const { days, selected, week, weeklyTarget: target } = overview;

  const coming = selected ? [...selected.regular.YES, ...selected.regular.HALF, ...selected.flex.YES] : [];
  const comingIds = [...new Set(coming.map((p) => p.id))];
  // Extra meetings are Team calendar events ("Extra meeting"): whoever can change the calendar adds them.
  const addMeeting = canManageCalendar(actor) && (
    <ButtonLink href="/calendar/new?kind=MEETING&from=plan" variant="secondary">
      <CalendarPlus className="size-4" aria-hidden />
      Add an extra meeting
    </ButtonLink>
  );

  return (
    <>
      <BackLink href="/attendance">Attendance</BackLink>
      <PageHeader
        title="Who's coming"
        description="Answers for the next team days (regular meetings and extra meetings), so you can plan what everyone will do."
        actions={addMeeting || undefined}
      />

      {days.length === 0 ? (
        <Card>
          <EmptyState icon={CalendarDays} title="No team days coming up" description="Check the schedule in Attendance → Schedule." />
        </Card>
      ) : (
        <div className="space-y-6">
          <nav aria-label="Pick a day">
            {/* Phones: one row that scrolls sideways (inside itself, never the page); wider: a grid. */}
            <DayTileList
              selected={selected?.date ?? null}
              className="-mx-4 flex snap-x gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:grid sm:grid-cols-4 sm:overflow-visible sm:px-0 sm:pb-0 lg:grid-cols-7"
            >
              {days.map((d) => {
                const active = d.date === selected?.date;
                const near = nearDayLabel(d.date, today);
                const counts =
                  d.answered === 0
                    ? "No answers yet"
                    : [d.regularDay ? `${d.yes + d.half} coming` : "No regular", ...(d.flexDay ? [`Flex ${d.flexYes}`] : [])].join(" · ");
                return (
                  <li key={d.date} className="w-36 shrink-0 snap-start sm:w-auto">
                    <Link
                      href={`/attendance/plan?day=${d.date}`}
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        // Full height, so a row with an extra meeting's taller tile stays even.
                        "block h-full min-h-10 rounded-lg border px-3 py-2 text-sm transition-colors",
                        active ? "border-brand-500 bg-brand-50 ring-1 ring-brand-500" : "border-ink-200 bg-white hover:border-brand-300",
                      )}
                    >
                      <span className="block font-medium text-ink-900">{near ?? formatDateOnly(d.date, today)}</span>
                      {d.extraMeetings.length > 0 && <span className="block text-xs font-medium text-teal-800">Extra meeting</span>}
                      <span className="block text-xs text-ink-500">
                        {counts}
                        {d.hasPlan ? " · planned" : ""}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </DayTileList>
          </nav>

          {selected && (
            <section aria-labelledby="day-heading" className="space-y-4">
              {/* The day (and its extra meeting) first; on wider screens the button sits to the right. */}
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0 space-y-2 sm:flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 id="day-heading" className="text-lg font-semibold text-ink-900">
                      {formatDateOnly(selected.date, today)}
                    </h2>
                    {selected.flexDay && <Badge tone="purple">Flex day</Badge>}
                    <ExtraMeetingBadge meetings={selected.extraMeetings} />
                  </div>
                  <ExtraMeetingLinks meetings={selected.extraMeetings} />
                  {week && (
                    <p className="text-sm text-ink-500">
                      Next to each name: how much they&apos;ve come so far that week ({formatPeriod(week, today)}), out of {target}.
                    </p>
                  )}
                </div>
                {comingIds.length > 0 && (
                  <ButtonLink
                    href={`/manage/tasks/new?${new URLSearchParams({
                      people: comingIds.join(","),
                      due: selected.date,
                      back: `/attendance/plan?day=${selected.date}`,
                    })}`}
                    variant="secondary"
                  >
                    <ClipboardPlus className="size-4" aria-hidden />
                    Assign a task to the people coming
                  </ButtonLink>
                )}
              </div>

              <Card>
                <CardHeader
                  title="Plan"
                  description={selected.planUpdatedByName ? `Last changed by ${selected.planUpdatedByName}.` : undefined}
                />
                <CardBody>
                  <DayPlanForm key={selected.date} date={selected.date} plan={selected.plan} />
                </CardBody>
              </Card>

              {selected.regularDay && (
                <div className="space-y-3">
                  <h3 className="font-semibold text-ink-900">Regular practice</h3>
                  <div className="grid gap-3 md:grid-cols-2">
                    <AnswerBlock title="Yes" tone="bg-brand-600" people={selected.regular.YES} empty="No one yet." target={target} />
                    <AnswerBlock title="Half" tone="bg-amber-500" people={selected.regular.HALF} empty="No one." target={target} />
                    <AnswerBlock title="No" tone="bg-ink-700" people={selected.regular.NO} empty="No one." target={target} />
                    <AnswerBlock title="No answer" tone="bg-ink-300" people={selected.regular.NONE} empty="Everyone answered." target={target} />
                  </div>
                </div>
              )}

              {selected.flexDay && (
                <div className="space-y-3">
                  <h3 className="font-semibold text-ink-900">Flex</h3>
                  <div className="grid gap-3 md:grid-cols-2">
                    <AnswerBlock title="Yes" tone="bg-brand-600" people={selected.flex.YES} empty="No one yet." target={target} />
                    <AnswerBlock title="No" tone="bg-ink-700" people={selected.flex.NO} empty="No one." target={target} />
                    <AnswerBlock title="No answer" tone="bg-ink-300" people={selected.flex.NONE} empty="Everyone answered." target={target} />
                  </div>
                </div>
              )}
            </section>
          )}
          <p className="text-xs text-ink-500">
            Mentors and teachers are only listed when they answer.
          </p>
        </div>
      )}
    </>
  );
}
