import { Users } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { UserFilters } from "@/components/admin/user-filters";
import { UserList } from "@/components/admin/user-list";
import { Alert } from "@/components/ui/alert";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Pagination } from "@/components/ui/pagination";
import { requireAdminUser } from "@/server/auth/session";
import { env } from "@/server/env";
import { listUsers, parseUserFilters, type UserFilters as Filters } from "@/server/queries/admin";

export const metadata: Metadata = { title: "People" };

function hrefFor(filters: Filters, page: number) {
  const sp = new URLSearchParams();
  if (filters.q) sp.set("q", filters.q);
  if (filters.status) sp.set("status", filters.status);
  if (filters.role) sp.set("role", filters.role);
  if (filters.subteam) sp.set("subteam", filters.subteam);
  if (page > 1) sp.set("page", String(page));
  const qs = sp.toString();
  return qs ? `/admin/users?${qs}` : "/admin/users";
}

export default async function PeoplePage({ searchParams }: PageProps<"/admin/users">) {
  const actor = await requireAdminUser();
  const sp = await searchParams;
  const filters = parseUserFilters(sp);
  const result = await listUsers(actor, filters);
  const filtered = !!(filters.q || filters.status || filters.role || filters.subteam);
  const now = new Date();

  return (
    <>
      <PageHeader eyebrow="Admin" title="People" description="Everyone with an account. Tap a person to edit them." />

      <div className="space-y-4">
        {sp.deleted === "1" && <Alert tone="success">Sign-up deleted.</Alert>}

        {/* Keyed by the filters so "Clear filters" (a client navigation) resets the menus too. */}
        <UserFilters key={JSON.stringify([filters.q, filters.status, filters.role, filters.subteam])} filters={filters} />

        <div className="flex items-center justify-between gap-3 text-sm text-ink-500">
          <p>
            {result.total} {result.total === 1 ? "person" : "people"}
            {filtered ? " match" : ""}
          </p>
          {filtered && (
            <Link href="/admin/users" className="inline-flex min-h-10 items-center font-medium text-brand-700 hover:underline">
              Clear filters
            </Link>
          )}
        </div>

        {result.users.length === 0 ? (
          <Card>
            <EmptyState
              icon={Users}
              title={filtered ? "No one matches these filters." : "No accounts yet."}
              description={filtered ? "Try a different search or clear the filters." : undefined}
            />
          </Card>
        ) : (
          <UserList users={result.users} now={now} timeZone={env.teamTimezone} />
        )}

        <Pagination page={result.page} pageCount={result.pageCount} hrefFor={(p) => hrefFor(filters, p)} />
      </div>
    </>
  );
}
