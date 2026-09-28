import { Settings2, Users } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { TeamMemberFilters } from "@/components/people/team-member-filters";
import { TeamMemberList } from "@/components/people/team-member-list";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { requireActiveUser } from "@/server/auth/session";
import { env } from "@/server/env";
import { canAdminister } from "@/server/permissions";
import {
  hasTeamMemberFilters,
  listTeamMembers,
  parseTeamMemberFilters,
  teamMemberAdminHref,
} from "@/server/queries/people";

export const metadata: Metadata = { title: "Team members" };

/** Request time, read outside of render so "Seen 6 h ago" lines up with the data. */
function requestTime(): Date {
  return new Date();
}

/** Everyone on the team (ACTIVE accounts only), for every member: who's who and their email. */
export default async function TeamMembersPage({ searchParams }: PageProps<"/people">) {
  const actor = await requireActiveUser();
  const filters = parseTeamMemberFilters(await searchParams);
  const { people, total } = await listTeamMembers(actor, filters);
  const admin = canAdminister(actor);
  // Members get null everywhere (canManageAccount needs admin access).
  const rows = people.map((p) => ({ ...p, adminHref: teamMemberAdminHref(actor, p) }));
  const filtered = hasTeamMemberFilters(filters);
  const now = requestTime();

  return (
    <>
      <PageHeader
        title="Team members"
        description="Everyone on the team. Tap an email to write to them."
        actions={
          admin ? (
            <Link
              href="/admin/users"
              className="inline-flex min-h-10 items-center gap-1.5 text-sm font-medium text-brand-700 hover:underline"
            >
              <Settings2 className="size-4" aria-hidden />
              Manage people in Admin → People
            </Link>
          ) : undefined
        }
      />

      <div className="space-y-4">
        {/* Keyed by the filters so "Clear filters" or the menu link (client navigations) reset the menus too. */}
        <TeamMemberFilters key={JSON.stringify([filters.q, filters.role, filters.subteam])} filters={filters} />

        <div className="flex flex-wrap items-center justify-between gap-x-3 text-sm text-ink-500">
          <p>
            {total} {total === 1 ? "person" : "people"}
            {filtered ? (total === 1 ? " matches" : " match") : ""}
            {people.length < total ? ` · showing the first ${people.length}` : ""}
          </p>
          {filtered && (
            <Link href="/people" className="inline-flex min-h-10 items-center font-medium text-brand-700 hover:underline">
              Clear filters
            </Link>
          )}
        </div>

        {rows.length === 0 ? (
          <Card>
            <EmptyState
              icon={Users}
              title={filtered ? "No one matches these filters." : "No one here yet."}
              description={filtered ? "Try a different search or clear the filters." : undefined}
            />
          </Card>
        ) : (
          <TeamMemberList people={rows} now={now} timeZone={env.teamTimezone} />
        )}
      </div>
    </>
  );
}
