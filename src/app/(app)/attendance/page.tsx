import { CalendarCheck, CalendarDays, ChartColumn, ChevronDown, CircleCheck, ClipboardList, History, Settings2, Users } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { CheckInPanel } from "@/components/attendance/check-in-panel";
import { ExtraMeetingBadge, ExtraMeetingLinks } from "@/components/attendance/extra-meeting";
import { TodayCredits } from "@/components/attendance/my-credits";
import { RsvpDay } from "@/components/attendance/rsvp-day";
import { StartAttendanceButton } from "@/components/attendance/session-forms";
import { WeekProgress } from "@/components/attendance/week-progress";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import type { AttendanceKind } from "@/generated/prisma/enums";
import {
  ATTENDANCE_KIND_LABELS,
  CHECK_IN_METHOD_LABELS,
  creditLabel,
  formatClock,
  formatPeriod,
  isFlexDay,
  isRegularDay,
  nearDayLabel,
  scanOrigins,
} from "@/lib/attendance";
import { type DateOnly, formatDateOnly, isDateOnly, todayInTimezone } from "@/lib/dates";
import { cn } from "@/lib/cn";
import { requireActiveUser } from "@/server/auth/session";
import { env } from "@/server/env";
import { type AttendanceHome, getAttendanceHome, type RecentSession, type RsvpDay as RsvpDayData, type Tally, type TodaySession } from "@/server/queries/attendance";

export const metadata: Metadata = { title: "Attendance" };

/** How many upcoming team days show before "Show N more days" (the rest are a tap away). */
const DAYS_SHOWN = 5;

/** ?deleted=REGULAR-2026-09-27 (after deleting a session started by mistake). */
function parseDeleted(value: string | string[] | undefined): { kind: AttendanceKind; date: DateOnly } | null {
  const m = typeof value === "string" ? /^(REGULAR|FLEX)-(\d{4}-\d{2}-\d{2})$/.exec(value) : null;
  return m && isDateOnly(m[2]) ? { kind: m[1] as AttendanceKind, date: m[2] } : null;
}

function tallyText(t: Tally) {
  return t.held === 0 ? "None yet" : `${t.attended} of ${t.held}`;
}

function SummaryCard({ summary, weeks, today }: { summary: AttendanceHome["summary"]; weeks: AttendanceHome["weeks"]; today: string }) {
  const rows = [
    { label: `These two weeks (${formatPeriod(summary.period, today)})`, value: summary.thisPeriod },
    ...(summary.season ? [{ label: `This season (since ${formatDateOnly(summary.season.start, today)})`, value: summary.season }] : []),
  ];
  return (
    <Card>
      <CardHeader
        title="Your attendance"
        description={
          weeks
            ? `The goal is ${weeks.target} a week (Monday to Sunday). Regular, EC, and Flex all count.`
            : "Times you checked in, out of the times attendance was taken."
        }
      />
      <CardBody className="space-y-3">
        {weeks && (
          <div className="grid gap-2 sm:grid-cols-2">
            {[
              { label: "This week", week: weeks.thisWeek },
              { label: "Last week", week: weeks.lastWeek },
            ].map(({ label, week }) => (
              <div key={label}>
                <p className="text-sm font-medium text-ink-800">
                  {label} <span className="font-normal text-ink-500">({formatPeriod(week, today)})</span>
                </p>
                {/* The heading above says which week: just "1 of 2". */}
                <WeekProgress week={week.credit} target={weeks.target} label="" breakdown className="mt-1" />
              </div>
            ))}
          </div>
        )}
        {weeks && <p className="pt-1 text-sm text-ink-500">Times you checked in, out of the times attendance was taken:</p>}
        {rows.map((row) => (
          <div key={row.label}>
            <p className="text-sm font-medium text-ink-800">{row.label}</p>
            <dl className="mt-1 grid grid-cols-2 gap-2">
              <div className="rounded-lg bg-ink-50 px-3 py-2">
                <dt className="text-xs text-ink-500">Regular</dt>
                <dd className="font-display text-xl font-semibold tabular-nums text-ink-900">{tallyText(row.value.regular)}</dd>
              </div>
              <div className="rounded-lg bg-ink-50 px-3 py-2">
                <dt className="text-xs text-ink-500">Flex</dt>
                <dd className="font-display text-xl font-semibold tabular-nums text-ink-900">{tallyText(row.value.flex)}</dd>
              </div>
            </dl>
          </div>
        ))}
      </CardBody>
    </Card>
  );
}

/**
 * Admins: today's sessions and the last few before today, to fix who was there and their credits. Runners
 * (teachers, the Business leader, the captain, mentors, owners) also start today's attendance or go back to it.
 */
function SessionsCard({
  canRun,
  sessions,
  recent,
  flexToday,
  regularToday,
  today,
}: {
  canRun: boolean;
  sessions: TodaySession[];
  recent: RecentSession[];
  flexToday: boolean;
  regularToday: boolean;
  today: DateOnly;
}) {
  const kinds: AttendanceKind[] = ["REGULAR", "FLEX"];
  return (
    <Card>
      <CardHeader
        title={canRun ? "Take attendance" : "Fix attendance"}
        description={
          canRun
            ? "Start it, then show the QR code on the screen. Everyone scans it (or types its code)."
            : "Open a session to add someone by hand, take them off, or change what it counts as."
        }
      />
      <CardBody className="space-y-4">
        {sessions.length > 0 && (
          <ul className="divide-y divide-ink-100 rounded-lg border border-ink-200" aria-label="Today's attendance">
            {sessions.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
                <Link
                  href={`/attendance/sessions/${s.id}`}
                  className="inline-flex min-h-10 items-center font-medium text-brand-700 underline-offset-2 hover:underline"
                >
                  {ATTENDANCE_KIND_LABELS[s.kind]} attendance
                </Link>
                <Badge tone={s.open ? "green" : "gray"}>{s.open ? "Open" : "Closed"}</Badge>
                <span className="text-sm text-ink-500">
                  {s.count ?? 0} checked in{s.openedByName ? ` · started by ${s.openedByName}` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
        {canRun && (
          <div className="flex flex-wrap gap-2">
            {kinds.map((kind) => {
              const session = sessions.find((s) => s.kind === kind);
              const usual = kind === "REGULAR" ? regularToday : flexToday;
              if (session?.open) {
                return (
                  <ButtonLink key={kind} href={`/attendance/sessions/${session.id}`} variant={usual ? "primary" : "secondary"}>
                    <CalendarCheck className="size-4" aria-hidden />
                    Show {ATTENDANCE_KIND_LABELS[kind]} code
                  </ButtonLink>
                );
              }
              if (!session && !usual && kind === "FLEX") return null; // Flex only on Flex days
              return (
                <StartAttendanceButton
                  key={kind}
                  kind={kind}
                  variant={usual ? "primary" : "secondary"}
                  label={session ? `Reopen ${ATTENDANCE_KIND_LABELS[kind]}` : `Start ${ATTENDANCE_KIND_LABELS[kind]} attendance`}
                  confirm={
                    !session && !usual
                      ? "There's no regular practice or extra meeting today. Start Regular attendance anyway?"
                      : undefined
                  }
                />
              );
            })}
          </div>
        )}
        {!canRun && sessions.length === 0 && recent.length === 0 && (
          <p className="text-sm text-ink-500">No attendance has been taken yet.</p>
        )}
        {recent.length > 0 && (
          <div className="space-y-1.5">
            <h3 className="text-sm font-medium text-ink-800">
              Earlier (to fix a list{canRun ? " or “What we did”" : " or credits"})
            </h3>
            <ul className="divide-y divide-ink-100 rounded-lg border border-ink-200" aria-label="Earlier attendance">
              {recent.map((r) => (
                <li key={r.id}>
                  <Link
                    href={`/attendance/sessions/${r.id}`}
                    className="flex min-h-10 flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2 text-sm hover:bg-ink-50"
                  >
                    <span className="font-medium text-brand-700">
                      {formatDateOnly(r.date, today)} · {ATTENDANCE_KIND_LABELS[r.kind]}
                    </span>
                    <span className="text-ink-500">{r.count} came</span>
                    {r.open && <Badge tone="yellow">Still open</Badge>}
                    {!r.hasNote && <Badge tone="yellow">No “What we did” yet</Badge>}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardBody>
    </Card>
  );
}

/**
 * One day's "Coming?" card. `id="day-YYYY-MM-DD"`, so links can go straight to it (an extra meeting's "Say if you're
 * coming" opens /attendance?day=…#day-…); that day's card is outlined.
 */
function DayCard({ day, today, picked }: { day: RsvpDayData; today: DateOnly; picked: boolean }) {
  const label = formatDateOnly(day.date, today);
  const near = nearDayLabel(day.date, today);
  return (
    <Card id={`day-${day.date}`} className={cn("scroll-mt-20", picked && "ring-2 ring-teal-500")}>
      <article aria-label={label} className="space-y-3 px-4 py-3 sm:px-5">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="font-semibold text-ink-900">{label}</h3>
          {near && <Badge tone="brand">{near}</Badge>}
          {day.flexDay && <Badge tone="purple">Flex day</Badge>}
          <ExtraMeetingBadge meetings={day.extraMeetings} />
        </div>
        <ExtraMeetingLinks meetings={day.extraMeetings} />
        {day.plan && (
          <div className="flex gap-2 rounded-lg bg-sky-50 px-3 py-2 text-sm text-sky-900">
            <ClipboardList className="mt-0.5 size-4 shrink-0" aria-hidden />
            <p className="min-w-0 whitespace-pre-line wrap-anywhere">
              <span className="font-medium">Plan: </span>
              {day.plan}
            </p>
          </div>
        )}
        <RsvpDay day={day} dayLabel={label} />
      </article>
    </Card>
  );
}

/** Everyone: check in, say when you're coming, and see your attendance. */
export default async function AttendancePage({ searchParams }: PageProps<"/attendance">) {
  const actor = await requireActiveUser();
  const timeZone = env.teamTimezone;
  const today = todayInTimezone(timeZone);
  const [home, sp] = await Promise.all([getAttendanceHome(actor, today, timeZone), searchParams]);
  const deleted = home.canRun ? parseDeleted(sp.deleted) : null;
  const open = home.sessions.filter((s) => s.open);
  const notYet = open.filter((s) => !s.checkedIn);
  const checkedIn = home.sessions.filter((s) => s.checkedIn);
  // On today's list (checked in, or marked "No credit" by an admin): what each counts as.
  const onList = home.sessions.filter((s) => s.myCredit !== null);
  const checkedInText = checkedIn.map((s) => ATTENDANCE_KIND_LABELS[s.kind]).join(" and ");
  const checkedInLine = `You're checked in for ${checkedInText} ✓`;
  const origins = scanOrigins(env.appUrl);
  // ?day=YYYY-MM-DD (with #day-YYYY-MM-DD): that day's card is outlined, and "Show more days" starts open for it.
  const pickedDay = typeof sp.day === "string" && isDateOnly(sp.day) ? sp.day : null;
  const pickedIndex = pickedDay ? home.days.findIndex((d) => d.date === pickedDay) : -1;

  const staffLinks = home.canPlan && (
    <>
      <ButtonLink href="/attendance/plan" variant="secondary">
        <Users className="size-4" aria-hidden />
        Who&apos;s coming
      </ButtonLink>
      <ButtonLink href="/attendance/reports" variant="secondary">
        <ChartColumn className="size-4" aria-hidden />
        Reports
      </ButtonLink>
      {home.canViewChanges && (
        <ButtonLink href="/attendance/changes" variant="secondary">
          <History className="size-4" aria-hidden />
          Changes
        </ButtonLink>
      )}
      {home.canRun && (
        <ButtonLink href="/attendance/settings" variant="ghost">
          <Settings2 className="size-4" aria-hidden />
          Schedule
        </ButtonLink>
      )}
    </>
  );

  return (
    <>
      <PageHeader title="Attendance" description="Say when you're coming, and check in at practice." actions={staffLinks || undefined} />

      <div className="max-w-3xl space-y-6">
        {deleted && (
          <Alert tone="success" title="Deleted">
            {ATTENDANCE_KIND_LABELS[deleted.kind]} attendance for {formatDateOnly(deleted.date, today)} is gone and won&apos;t count in
            the reports.
          </Alert>
        )}
        <Card>
          <CardHeader
            title="Check in"
            description={
              open.length > 0 && notYet.length === 0
                ? "You're checked in for today."
                : open.length > 0
                  ? `${notYet.map((s) => ATTENDANCE_KIND_LABELS[s.kind]).join(" and ")} attendance is open. Scan the QR code on the screen, or type its code.`
                  : "When attendance starts, scan the QR code on the screen (or type its code)."
            }
          />
          <CardBody className="space-y-4">
            {open.length === 0 && checkedIn.length > 0 && (
              <p className="flex items-center gap-2 rounded-lg bg-brand-50 px-3 py-2 text-sm font-medium text-brand-800">
                <CircleCheck className="size-5 shrink-0" aria-hidden />
                {checkedInLine}
              </p>
            )}
            {/* Nothing open and already checked in today: nothing to scan or type. */}
            {(open.length > 0 || checkedIn.length === 0) && (
              <CheckInPanel
                origins={origins}
                done={open.length > 0 && notYet.length === 0}
                doneText={checkedInLine}
              />
            )}
            {/* Right after checking in: what it counts as (at Flex, "How long are you at Flex?") and this week. */}
            {onList.length > 0 && (
              <TodayCredits sessions={onList} week={home.weeks?.thisWeek.credit ?? null} target={home.settings.weeklyTarget} />
            )}
          </CardBody>
        </Card>

        {home.canFix && (
          <SessionsCard
            canRun={home.canRun}
            sessions={home.sessions}
            recent={home.recentSessions}
            regularToday={isRegularDay(home.settings, today)}
            flexToday={isFlexDay(home.settings, today)}
            today={today}
          />
        )}

        <section aria-labelledby="coming-heading" className="space-y-3">
          <div>
            <h2 id="coming-heading" className="text-lg font-semibold text-ink-900">
              Coming?
            </h2>
            <p className="mt-0.5 text-sm text-ink-500">
              Let the captain know which days you&apos;ll be there, so there&apos;s a plan for you. Half = part of the time.
            </p>
          </div>
          {home.days.length === 0 ? (
            <Card>
              <EmptyState icon={CalendarDays} title="No team days coming up" description="When there's practice again, the days show up here." />
            </Card>
          ) : (
            <>
              <ul className="space-y-3" aria-label="Upcoming team days">
                {home.days.slice(0, DAYS_SHOWN).map((day) => (
                  <li key={day.date}>
                    <DayCard day={day} today={today} picked={day.date === pickedDay} />
                  </li>
                ))}
              </ul>
              {home.days.length > DAYS_SHOWN && (
                <details className="group space-y-3" open={pickedIndex >= DAYS_SHOWN || undefined}>
                  <summary className="flex min-h-10 cursor-pointer list-none items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-brand-700 hover:bg-brand-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/50 [&::-webkit-details-marker]:hidden">
                    <ChevronDown className="size-4 transition-transform group-open:rotate-180" aria-hidden />
                    <span className="group-open:hidden">Show {home.days.length - DAYS_SHOWN} more days</span>
                    <span className="hidden group-open:inline">Show fewer days</span>
                  </summary>
                  <ul className="space-y-3" aria-label="More team days">
                    {home.days.slice(DAYS_SHOWN).map((day) => (
                      <li key={day.date}>
                        <DayCard day={day} today={today} picked={day.date === pickedDay} />
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </>
          )}
        </section>

        <SummaryCard summary={home.summary} weeks={home.weeks} today={today} />

        <Card>
          <CardHeader title="Recent check-ins" />
          {home.history.length === 0 ? (
            <EmptyState title="No check-ins yet" description="After you scan the code at practice, it shows up here." />
          ) : (
            <ul className="divide-y divide-ink-100">
              {home.history.map((h) => (
                <li key={`${h.date}-${h.kind}`} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 px-4 py-2.5 text-sm sm:px-5">
                  <span className="font-medium text-ink-900">
                    {formatDateOnly(h.date, today)} · {ATTENDANCE_KIND_LABELS[h.kind]}
                    <span className="font-normal text-ink-600">
                      {h.credit > 0 ? ` · counts ${creditLabel(h.credit, h.creditKind)}` : " · No credit (marked as not here)"}
                    </span>
                  </span>
                  <span className="text-ink-500">
                    {CHECK_IN_METHOD_LABELS[h.method]} · {formatClock(h.checkedInAt, env.teamTimezone)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
