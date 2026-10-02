import { BadgeCheck, ChevronLeft, CircleCheck, ListChecks, TriangleAlert } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { RoleBadge, SubteamBadge } from "@/components/app/badges";
import { MemberAssignmentList } from "@/components/manage/member-assignments";
import { ProgressLegend, ProgressRangeTabs } from "@/components/manage/progress-filters";
import { describeRange, lastSeenLabel, memberProgressHref, teamProgressHref } from "@/components/manage/progress-links";
import { Avatar } from "@/components/ui/avatar";
import { Card, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { ProgressBar } from "@/components/ui/progress-bar";
import { StatCard } from "@/components/ui/stat-card";
import { todayInTimezone } from "@/lib/dates";
import { requireStaffUser } from "@/server/auth/session";
import { env } from "@/server/env";
import { getMemberProgress, MEMBER_ASSIGNMENTS_MAX } from "@/server/queries/progress";

export const metadata: Metadata = { title: "Member progress" };

/** Request time, read outside of render so relative labels are computed once per request. */
function requestTime(): Date {
  return new Date();
}

export default async function MemberProgressPage({ params, searchParams }: PageProps<"/manage/progress/[userId]">) {
  const actor = await requireStaffUser();
  const [{ userId }, sp] = await Promise.all([params, searchParams]);
  const now = requestTime();
  const timeZone = env.teamTimezone;
  const today = todayInTimezone(timeZone, now);
  const data = await getMemberProgress(actor, userId, { range: sp.range }, today);
  if (!data) notFound();

  const { user, summary, range } = data;
  const open = summary.todo + summary.rejected;
  const rangeText = describeRange(range, data.from, data.to, today);

  return (
    <>
      <Link
        href={teamProgressHref({ range })}
        className="-ml-2 mb-3 inline-flex h-10 items-center gap-1 rounded-lg px-2 text-sm font-medium text-ink-600 hover:bg-ink-100 hover:text-ink-900"
      >
        <ChevronLeft className="size-4" aria-hidden />
        Team progress
      </Link>

      <PageHeader
        eyebrow="Progress"
        title={
          <span className="flex min-w-0 items-center gap-3">
            <Avatar name={user.name} size="lg" />
            <span className="min-w-0 break-words">{user.name}</span>
          </span>
        }
        description={
          <span className="mt-1 flex flex-wrap items-center gap-2 text-sm">
            <RoleBadge role={user.role} />
            {user.subteam && <SubteamBadge subteam={user.subteam} />}
            <span className="text-ink-500">Last seen {lastSeenLabel(user.lastSeenAt, now, timeZone)}</span>
          </span>
        }
      />

      <ProgressRangeTabs range={range} hrefFor={(r) => memberProgressHref(user.id, r)} />

      <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Approved"
          value={`${summary.approved}/${summary.total}`}
          icon={CircleCheck}
          hint={
            summary.completionRate === null
              ? "Nothing due"
              : `${summary.completionRate}% done${summary.closed > 0 ? ` · ${summary.closed} closed with a finished task` : ""}`
          }
        />
        <StatCard label="Waiting for review" value={summary.submitted} icon={BadgeCheck} hint="Checked off, not reviewed yet" />
        <StatCard
          label="Still to do"
          value={open}
          icon={ListChecks}
          hint={summary.rejected > 0 ? `${summary.rejected} sent back for changes` : "Not checked off yet"}
        />
        <StatCard
          label="Overdue"
          value={summary.overdue}
          icon={TriangleAlert}
          tone={summary.overdue > 0 ? "attention" : "default"}
          hint={summary.overdue > 0 ? "Past due and still open" : "Nothing overdue"}
        />
      </div>

      {summary.total > 0 && (
        <div className="mt-4 space-y-2">
          <ProgressBar done={summary.approved} pending={summary.submitted} total={summary.total} />
          <ProgressLegend />
        </div>
      )}

      <Card className="mt-6">
        <CardHeader title="Checklist items" description={`Due ${rangeText}, plus anything overdue. Newest first.`} />
        <MemberAssignmentList
          items={data.assignments}
          today={today}
          timeZone={timeZone}
          emptyText={`Nothing was due ${range === "today" ? "today" : "in this range"} and nothing is overdue.`}
        />
        {data.truncated && (
          <p className="border-t border-ink-100 px-4 py-3 text-sm text-ink-500 sm:px-5">
            Showing the {MEMBER_ASSIGNMENTS_MAX} most recent items.
          </p>
        )}
      </Card>
    </>
  );
}
