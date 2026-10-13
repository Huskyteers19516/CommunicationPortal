import { Mail, Users } from "lucide-react";
import type { Metadata } from "next";
import { ProgressLegend, ProgressRangeTabs, SubteamChips } from "@/components/manage/progress-filters";
import {
  describeRange,
  overdueReminderHref,
  scopeLabel,
  subteamGroupLabel,
  teamProgressHref,
} from "@/components/manage/progress-links";
import { SubteamSummaryStrip, TeamProgressList } from "@/components/manage/team-progress";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Pagination, parsePage } from "@/components/ui/pagination";
import { todayInTimezone } from "@/lib/dates";
import { requireStaffUser } from "@/server/auth/session";
import { env } from "@/server/env";
import { canAdminister } from "@/server/permissions";
import { getTeamProgress } from "@/server/queries/progress";

export const metadata: Metadata = { title: "Team progress" };

/** Request time, read outside of render so relative labels are computed once per request. */
function requestTime(): Date {
  return new Date();
}

export default async function TeamProgressPage({ searchParams }: PageProps<"/manage/progress">) {
  const actor = await requireStaffUser();
  const sp = await searchParams;
  const now = requestTime();
  const today = todayInTimezone(env.teamTimezone, now);
  const data = await getTeamProgress(actor, { range: sp.range, subteam: sp.subteam, page: parsePage(sp.page) }, today);
  const { range, subteam, totals } = data;
  // Subteam leaders are locked to their subteam, so never put it in their URLs.
  const filterSubteam = data.canFilterSubteam ? subteam : null;

  const listTitle = data.canFilterSubteam && subteam ? `${subteamGroupLabel(subteam)} people` : "People";
  // Non-breaking space before each "·" keeps the dot on the line it belongs to when the text wraps.
  const listDescription =
    data.peopleCount === 0
      ? undefined
      : `${data.peopleCount} ${data.peopleCount === 1 ? "person" : "people"}\u00a0· ${totals.approved}/${totals.total} approved` +
        (totals.overdue > 0 ? `\u00a0· ${totals.overdue} overdue` : "");

  return (
    <>
      <PageHeader
        eyebrow={scopeLabel(actor)}
        title="Team progress"
        description={`Who has finished what, for tasks due ${describeRange(range, data.from, data.to, today)}.`}
        actions={
          canAdminister(actor) && (
            <ButtonLink variant="secondary" href={overdueReminderHref({ range, subteam: filterSubteam })}>
              <Mail className="size-4" aria-hidden />
              Overdue reminder
            </ButtonLink>
          )
        }
      />

      <ProgressRangeTabs range={range} hrefFor={(r) => teamProgressHref({ range: r, subteam: filterSubteam })} />

      {data.canFilterSubteam && (
        <SubteamChips
          subteam={subteam}
          hrefFor={(s) => teamProgressHref({ range, subteam: s })}
          className="mt-4"
        />
      )}

      <SubteamSummaryStrip groups={data.subteams} className="mt-4" />

      <Card className="mt-6">
        <CardHeader title={listTitle} description={listDescription} actions={<ProgressLegend className="hidden sm:flex" />} />
        {data.rows.length === 0 ? (
          <EmptyState
            icon={Users}
            title="No one here yet"
            description="Active people in this group will show up here once they join the portal."
          />
        ) : (
          <>
            <ProgressLegend className="border-b border-ink-100 px-4 py-2 sm:hidden" />
            <TeamProgressList rows={data.rows} range={range} now={now} timeZone={env.teamTimezone} />
          </>
        )}
      </Card>

      <Pagination
        page={data.page}
        pageCount={data.pageCount}
        hrefFor={(page) => teamProgressHref({ range, subteam: filterSubteam, page })}
      />
    </>
  );
}
