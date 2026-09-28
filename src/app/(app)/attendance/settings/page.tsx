import { CalendarPlus, ChevronRight } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AttendanceSettingsForm } from "@/components/attendance/settings-form";
import { BackLink } from "@/components/tasks/back-link";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { formatWeekdays, nearDayLabel } from "@/lib/attendance";
import { formatEventWhen } from "@/lib/calendar";
import { todayInTimezone } from "@/lib/dates";
import { requireActiveUser } from "@/server/auth/session";
import { env } from "@/server/env";
import { canManageCalendar, canRunAttendance } from "@/server/permissions";
import { getSavedAttendanceSettings, getUpcomingExtraMeetings } from "@/server/queries/attendance-settings";

export const metadata: Metadata = { title: "Attendance schedule" };

/**
 * Teachers, the Business leader, the captain, mentors, and owners set the team's days and the weekly goal. Extra
 * meetings (other days) are Team calendar events of the kind "Extra meeting": listed here, added on the calendar.
 */
export default async function AttendanceSettingsPage() {
  const actor = await requireActiveUser();
  if (!canRunAttendance(actor)) redirect("/attendance");
  const today = todayInTimezone(env.teamTimezone);
  // The form gets only the saved schedule (never the days extra meetings add); they're listed below instead.
  const [settings, extraMeetings] = await Promise.all([getSavedAttendanceSettings(), getUpcomingExtraMeetings(today)]);
  const { regularDays, flexDays } = settings;
  const addMeeting = canManageCalendar(actor) && (
    <ButtonLink href="/calendar/new?kind=MEETING&from=schedule" variant="secondary">
      <CalendarPlus className="size-4" aria-hidden />
      Add an extra meeting
    </ButtonLink>
  );

  return (
    <>
      <BackLink href="/attendance">Attendance</BackLink>
      <PageHeader title="Schedule" description="Which days people are asked “Coming?”, how many times a week they should come, and when the two-week reports start." />
      <div className="max-w-2xl space-y-6">
        <Card>
          <CardHeader
            title="Meeting days"
            description={
              <>
                {/* Each list of days stays on one line (a phone wraps before it, not inside "Tue, Thu"). */}
                Regular meetings: <span className="font-medium whitespace-nowrap text-ink-800">{formatWeekdays(regularDays)}</span>
                {flexDays.length > 0 && (
                  <>
                    {" · "}Flex: <span className="font-medium whitespace-nowrap text-ink-800">{formatWeekdays(flexDays)}</span>
                  </>
                )}
              </>
            }
          />
          <CardBody>
            <AttendanceSettingsForm settings={settings} />
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Extra meetings"
            description="Meeting on another day? Add it to the Team calendar as an Extra meeting. Everyone's asked “Coming?” and attendance can be taken that day."
            actions={addMeeting || undefined}
          />
          {extraMeetings.length === 0 ? (
            <EmptyState title="No extra meetings coming up" description="Only the regular days for now." />
          ) : (
            <ul className="divide-y divide-ink-100" aria-label="Upcoming extra meetings">
              {extraMeetings.map((m) => {
                const near = nearDayLabel(m.startsOn, today);
                return (
                  <li key={m.id}>
                    <Link href={`/calendar/${m.id}`} className="flex min-h-12 items-center gap-3 px-4 py-2.5 text-sm hover:bg-ink-50 sm:px-5">
                      <span className="min-w-0 flex-1">
                        <span className="block font-medium text-ink-900 wrap-anywhere">{m.title}</span>
                        <span className="block text-ink-500">
                          {near && <span className="font-medium text-brand-700">{near} · </span>}
                          {formatEventWhen(m, today)}
                        </span>
                      </span>
                      <ChevronRight className="size-4 shrink-0 text-ink-400" aria-hidden />
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
