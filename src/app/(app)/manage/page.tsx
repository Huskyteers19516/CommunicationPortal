import { BadgeCheck, CalendarCheck, MessageCircleQuestionMark, TriangleAlert } from "lucide-react";
import type { Metadata } from "next";
import { AttentionCard, QuickActions, RecentActivityCard, TodaysTasksCard } from "@/components/manage/overview-cards";
import { scopeLabel, teamProgressHref } from "@/components/manage/progress-links";
import { PageHeader } from "@/components/ui/page-header";
import { StatCard } from "@/components/ui/stat-card";
import { dateOnlyToDb, todayInTimezone } from "@/lib/dates";
import { requireStaffUser } from "@/server/auth/session";
import { env } from "@/server/env";
import { canAdminister } from "@/server/permissions";
import { getOverview } from "@/server/queries/progress";

export const metadata: Metadata = { title: "Overview" };

/** Request time, read outside of render so relative labels are computed once per request. */
function requestTime(): Date {
  return new Date();
}

function longDate(today: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long", month: "long", day: "numeric" }).format(
    dateOnlyToDb(today),
  );
}

export default async function ManageOverviewPage() {
  const actor = await requireStaffUser();
  const now = requestTime();
  const today = todayInTimezone(env.teamTimezone, now);
  const o = await getOverview(actor, today);

  const dueHint =
    o.dueToday.total === 0
      ? "Nothing due today"
      : o.dueToday.submitted > 0
        ? `approved\u00a0· ${o.dueToday.submitted} waiting`
        : "approved";

  return (
    <>
      <PageHeader eyebrow={scopeLabel(actor)} title="Overview" description={longDate(today)} />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Waiting for your review"
          value={o.reviewQueueCount}
          icon={BadgeCheck}
          href="/manage/review"
          tone={o.reviewQueueCount > 0 ? "attention" : "default"}
          hint={o.reviewQueueCount > 0 ? "Tap to review" : "All caught up"}
        />
        <StatCard
          label="Open questions"
          value={o.openQuestionCount}
          icon={MessageCircleQuestionMark}
          href="/questions"
          hint={o.openQuestionCount > 0 ? "Waiting for a reply" : "No one is waiting"}
        />
        <StatCard
          label="Due today"
          value={`${o.dueToday.approved}/${o.dueToday.total}`}
          icon={CalendarCheck}
          href={teamProgressHref({ range: "today" })}
          hint={dueHint}
        />
        <StatCard
          label="Overdue items"
          value={o.overdueOpenCount}
          icon={TriangleAlert}
          href={teamProgressHref({ range: "week" })}
          hint={o.overdueOpenCount > 0 ? "Past due and still open" : "Nothing overdue"}
        />
      </div>

      <QuickActions reviewCount={o.reviewQueueCount} className="mt-4" />

      <div className="mt-6 grid gap-6 lg:grid-cols-5">
        <TodaysTasksCard tasks={o.todaysTasks} total={o.todaysTaskTotal} className="lg:col-span-3 lg:self-start" />
        <div className="space-y-6 lg:col-span-2">
          <AttentionCard people={o.attention} reminderHref={canAdminister(actor) ? "/manage/progress/reminder" : undefined} />
          <RecentActivityCard items={o.recentActivity} now={now} timeZone={env.teamTimezone} />
        </div>
      </div>
    </>
  );
}
