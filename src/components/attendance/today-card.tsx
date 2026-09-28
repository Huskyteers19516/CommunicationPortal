import { CalendarCheck, ChartColumn, CircleCheck, ClipboardList, QrCode } from "lucide-react";
import Link from "next/link";
import { ATTENDANCE_KIND_LABELS, formatPeriod, scanOrigins } from "@/lib/attendance";
import { type DateOnly, formatDateOnly } from "@/lib/dates";
import type { Actor } from "@/server/actor";
import { env } from "@/server/env";
import { getTodayAttendance } from "@/server/queries/attendance";
import { ButtonLink } from "../ui/button";
import { Card } from "../ui/card";
import { CheckInPanel } from "./check-in-panel";
import { ExtraMeetingBadge, ExtraMeetingLinks } from "./extra-meeting";
import { TodayCredits } from "./my-credits";
import { RsvpDay } from "./rsvp-day";
import { WeekProgress } from "./week-progress";

/**
 * The Today page's small attendance card: on team days (extra meetings included, with a link to theirs on the
 * Team calendar) "Coming today?" (same answers as Attendance), and while
 * attendance is open a "Scan to check in" button until I'm checked in (runners also get "Show code" back to the
 * projector screen), then what today's check-ins count as (at Flex, "How long are you at Flex?"; added by hand, who
 * did and "scan the code if you're here now") and this week's "1 of 2 this week". Staff
 * see when a two-week report has just finished. Renders nothing otherwise.
 */
export async function TodayAttendanceCard({ actor, today }: { actor: Actor; today: DateOnly }) {
  const data = await getTodayAttendance(actor, today);
  if (!data) return null;
  const notYet = data.openSessions.filter((s) => !s.checkedIn);
  const checkedInLine = `You're checked in for ${data.checkedInKinds.map((k) => ATTENDANCE_KIND_LABELS[k]).join(" and ")} ✓`;
  const label = formatDateOnly(today, today);

  return (
    <Card>
      <section aria-labelledby="today-attendance" className="space-y-3 px-4 py-3 sm:px-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h2 id="today-attendance" className="flex items-center gap-2 font-semibold text-ink-900">
              <CalendarCheck className="size-5 text-brand-600" aria-hidden />
              {data.day ? "Coming today?" : "Attendance"}
            </h2>
            {/* Why it asks on a day without regular practice, like on Attendance's day cards. */}
            {data.day && <ExtraMeetingBadge meetings={data.day.extraMeetings} />}
          </div>
          <Link href="/attendance" className="inline-flex h-10 items-center rounded-lg px-2 text-sm font-medium text-brand-700 hover:bg-brand-50">
            All days
          </Link>
        </div>
        {data.reportReady && (
          <Link
            href={`/attendance/reports/${data.reportReady.index}`}
            className="flex min-h-10 items-center gap-2 rounded-lg bg-brand-50 px-3 py-2 text-sm font-medium text-brand-800 hover:bg-brand-100"
          >
            <ChartColumn className="size-4 shrink-0" aria-hidden />
            <span className="min-w-0">The {formatPeriod(data.reportReady, today)} report is ready</span>
          </Link>
        )}
        {data.day && <ExtraMeetingLinks meetings={data.day.extraMeetings} />}
        {data.day?.plan && (
          <div className="flex gap-2 rounded-lg bg-sky-50 px-3 py-2 text-sm text-sky-900">
            <ClipboardList className="mt-0.5 size-4 shrink-0" aria-hidden />
            <p className="min-w-0 whitespace-pre-line wrap-anywhere">
              <span className="font-medium">Plan: </span>
              {data.day.plan}
            </p>
          </div>
        )}
        {data.day && <RsvpDay day={data.day} dayLabel={`today, ${label}`} />}
        {data.openSessions.length === 0 && data.checkedInKinds.length > 0 && (
          <p className="flex items-center gap-2 rounded-lg bg-brand-50 px-3 py-2 text-sm font-medium text-brand-800">
            <CircleCheck className="size-5 shrink-0" aria-hidden />
            {checkedInLine}
          </p>
        )}
        {data.openSessions.length > 0 && (
          <div className="space-y-2">
            {notYet.length > 0 && (
              <p className="text-sm text-ink-600">{notYet.map((s) => ATTENDANCE_KIND_LABELS[s.kind]).join(" and ")} attendance is open.</p>
            )}
            {/* Stays mounted after checking in (it then says so), so focus isn't lost. */}
            <CheckInPanel
              origins={scanOrigins(env.appUrl)}
              size="md"
              scanLabel="Scan to check in"
              done={notYet.length === 0}
              doneText={checkedInLine}
            />
            {data.canRun && (
              <div className="flex flex-wrap gap-2">
                {data.openSessions.map((s) => (
                  <ButtonLink key={s.id} href={`/attendance/sessions/${s.id}`} variant="secondary">
                    <QrCode className="size-4" aria-hidden />
                    Show {ATTENDANCE_KIND_LABELS[s.kind]} code
                  </ButtonLink>
                ))}
              </div>
            )}
          </div>
        )}
        {data.creditSessions.length > 0 ? (
          <TodayCredits sessions={data.creditSessions} week={data.week?.credit ?? null} target={data.week?.target ?? 0} />
        ) : (
          data.week && <WeekProgress week={data.week.credit} target={data.week.target} />
        )}
      </section>
    </Card>
  );
}
