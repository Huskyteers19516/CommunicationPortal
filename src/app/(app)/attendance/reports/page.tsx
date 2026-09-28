import { ChartColumn, ChevronRight } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { BackLink } from "@/components/tasks/back-link";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { formatPeriod } from "@/lib/attendance";
import { formatDateOnly, todayInTimezone } from "@/lib/dates";
import { requireActiveUser } from "@/server/auth/session";
import { env } from "@/server/env";
import { canPlanAttendance } from "@/server/permissions";
import { listReports } from "@/server/queries/attendance";

export const metadata: Metadata = { title: "Attendance reports" };

function sessionsText(regular: number, flex: number) {
  if (regular + flex === 0) return "No attendance taken";
  const parts = [`${regular} Regular`, ...(flex > 0 ? [`${flex} Flex`] : [])];
  return parts.join(" · ");
}

/** Staff: every two-week period, current first. */
export default async function AttendanceReportsPage() {
  const actor = await requireActiveUser();
  if (!canPlanAttendance(actor)) redirect("/attendance");
  const today = todayInTimezone(env.teamTimezone);
  const list = await listReports(actor, today);
  if (!list) redirect("/attendance");

  return (
    <>
      <BackLink href="/attendance">Attendance</BackLink>
      <PageHeader
        title="Two-week reports"
        description={`When attendance was taken, who came, and what got done. Periods start ${formatDateOnly(list.settings.reportStart, today)}.`}
      />
      <Card className="max-w-3xl">
        {list.periods.length === 0 ? (
          <EmptyState
            icon={ChartColumn}
            title="No reports yet"
            description={`The first two weeks start ${formatDateOnly(list.settings.reportStart, today)}.`}
          />
        ) : (
          <ul className="divide-y divide-ink-100">
            {list.periods.map((p) => (
              <li key={p.index}>
                <Link
                  href={`/attendance/reports/${p.index}`}
                  className="flex min-h-14 items-center gap-3 px-4 py-3 hover:bg-ink-50 sm:px-5"
                >
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2 font-medium text-ink-900">
                      {formatPeriod(p, today)}
                      {p.current && <Badge tone="brand">Current</Badge>}
                    </p>
                    <p className="text-sm text-ink-500">{sessionsText(p.regular, p.flex)}</p>
                  </div>
                  <ChevronRight className="size-4 shrink-0 text-ink-400" aria-hidden />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
