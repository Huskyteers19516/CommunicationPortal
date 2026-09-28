import { CalendarDays, Clock, Hourglass, ListChecks, PartyPopper, TriangleAlert } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { TodayAnnouncements } from "@/components/announcements/today-announcements";
import { TodayAttendanceCard } from "@/components/attendance/today-card";
import { TodayNoShowsCard } from "@/components/attendance/today-no-shows";
import { NextMeetCard } from "@/components/calendar/next-meet-card";
import { ChecklistList, ChecklistSection, DueGroupedList } from "@/components/checklist/checklist-list";
import { firstName, greetingFor, longDate } from "@/components/checklist/format";
import { ReviewQueueLink, TodaySummary } from "@/components/checklist/today-summary";
import { OrdersToOrderLink } from "@/components/orders/orders-to-order-link";
import { PartsMakingLink } from "@/components/parts/parts-making-link";
import { ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { timeInTimezone } from "@/lib/calendar";
import { todayInTimezone } from "@/lib/dates";
import { requireActiveUser } from "@/server/auth/session";
import { env } from "@/server/env";
import { canAccessManage } from "@/server/permissions";
import { listUnreadAnnouncements } from "@/server/queries/announcements";
import { getNextMeet } from "@/server/queries/calendar";
import { getTodayView } from "@/server/queries/checklist";
import { getNavCounts } from "@/server/queries/nav";
import { countPartsImMaking } from "@/server/queries/parts";

export const metadata: Metadata = { title: "Today" };

/** Request time, read outside of render so relative labels line up between server and browser. */
function requestTime(): Date {
  return new Date();
}

export default async function TodayPage() {
  const actor = await requireActiveUser();
  const now = requestTime();
  const timeZone = env.teamTimezone;
  const today = todayInTimezone(timeZone, now);
  const nowIso = now.toISOString();

  const [view, navCounts, partsMaking, nextMeet, unreadAnnouncements] = await Promise.all([
    getTodayView(actor, today),
    // Cached per request — the layout already loaded these for the nav badges.
    canAccessManage(actor) ? getNavCounts(actor) : null,
    countPartsImMaking(actor),
    getNextMeet(today, timeInTimezone(timeZone, now)),
    listUnreadAnnouncements(actor),
  ]);
  const reviewCount = navCounts?.reviewQueue ?? 0;

  const allEmpty =
    view.needsChanges.length === 0 &&
    view.overdue.length === 0 &&
    view.today.length === 0 &&
    view.waiting.length === 0 &&
    view.upcoming.length === 0;

  return (
    <>
      <PageHeader title={`${greetingFor(now, timeZone)}, ${firstName(actor.name)}`} description={longDate(today)} />

      <div className="max-w-3xl space-y-6">
        <TodayAnnouncements items={unreadAnnouncements.items} total={unreadAnnouncements.total} now={now} timeZone={timeZone} />
        <NextMeetCard nextMeet={nextMeet} today={today} />
        <TodayAttendanceCard actor={actor} today={today} />
        <TodayNoShowsCard actor={actor} today={today} />
        {!allEmpty && <TodaySummary summary={view.summary} />}
        <ReviewQueueLink count={reviewCount} />
        <PartsMakingLink count={partsMaking} />
        <OrdersToOrderLink actor={actor} />

        {allEmpty ? (
          <Card>
            <EmptyState
              icon={PartyPopper}
              title="You're all caught up"
              description="Nothing is due in the next week. New tasks from your leaders will show up here."
              action={
                <ButtonLink href="/my-tasks?tab=done" variant="secondary">
                  See what you&apos;ve finished
                </ButtonLink>
              }
            />
          </Card>
        ) : (
          <>
            {view.needsChanges.length > 0 && (
              <ChecklistSection
                id="needs-changes"
                title="Needs changes"
                count={view.needsChanges.length}
                tone="danger"
                icon={TriangleAlert}
                description="A leader sent these back. Read the feedback, fix it, then check it off again."
              >
                <ChecklistList items={view.needsChanges} today={today} now={nowIso} timeZone={timeZone} />
              </ChecklistSection>
            )}

            {view.overdue.length > 0 && (
              <ChecklistSection id="overdue" title="Overdue" count={view.summary.overdueCount} tone="danger" icon={Clock}>
                <ChecklistList items={view.overdue} today={today} now={nowIso} timeZone={timeZone} />
                {view.hiddenOverdue > 0 && (
                  <p className="mt-2 text-sm text-ink-500">
                    {view.hiddenOverdue} older overdue {view.hiddenOverdue === 1 ? "item isn't" : "items aren't"} shown here.{" "}
                    <Link href="/my-tasks" className="font-medium text-brand-700 underline underline-offset-2">
                      See all in My tasks
                    </Link>
                  </p>
                )}
              </ChecklistSection>
            )}

            {view.today.length > 0 && (
              <ChecklistSection id="due-today" title="Today" count={view.today.length} tone="brand" icon={ListChecks}>
                <ChecklistList items={view.today} today={today} now={nowIso} timeZone={timeZone} showDue={false} />
              </ChecklistSection>
            )}

            {view.waiting.length > 0 && (
              <ChecklistSection
                id="waiting"
                title="Waiting for review"
                count={view.waiting.length}
                tone="warning"
                icon={Hourglass}
                description="You checked these off earlier. A leader will review them soon."
              >
                <ChecklistList items={view.waiting} today={today} now={nowIso} timeZone={timeZone} />
              </ChecklistSection>
            )}

            {view.upcoming.length > 0 && (
              <ChecklistSection
                id="coming-up"
                title="Coming up"
                count={view.upcoming.length}
                icon={CalendarDays}
                description="Due in the next 7 days."
              >
                <DueGroupedList items={view.upcoming} today={today} now={nowIso} timeZone={timeZone} />
              </ChecklistSection>
            )}

            <div className="flex justify-center">
              <Link
                href="/my-tasks"
                className="inline-flex h-10 items-center rounded-lg px-3 text-sm font-medium text-brand-700 transition-colors hover:bg-brand-50 hover:text-brand-800"
              >
                See all my tasks
              </Link>
            </div>
          </>
        )}
      </div>
    </>
  );
}
