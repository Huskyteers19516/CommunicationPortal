import { ChevronRight, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { AccountStatusBadge } from "@/components/app/badges";
import { UserChip } from "@/components/app/user-chip";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { timeAgo } from "@/lib/dates";
import type { UserListItem } from "@/server/queries/admin";

/** Site owner (the `isAdmin` flag). Leaders, mentors, and teachers have admin access through their position. */
function AdminBadge() {
  return (
    <Badge tone="brand">
      <ShieldCheck className="size-3" aria-hidden />
      Owner
    </Badge>
  );
}

function lastSeen(u: UserListItem, now: Date, timeZone: string) {
  return u.lastSeenAt ? timeAgo(u.lastSeenAt, now, timeZone) : "Never";
}

/** People list: stacked cards on phones, a table from md up. */
export function UserList({ users, now, timeZone }: { users: UserListItem[]; now: Date; timeZone: string }) {
  return (
    <Card className="overflow-hidden">
      {/* Phones */}
      <ul className="divide-y divide-ink-100 md:hidden">
        {users.map((u) => (
          <li key={u.id}>
            <Link href={`/admin/users/${u.id}`} className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-ink-50">
              <div className="min-w-0 flex-1 space-y-1.5">
                <UserChip name={u.name} role={u.role} subteam={u.subteam} className="max-w-full" />
                <p className="truncate text-xs text-ink-500">{u.email}</p>
                <div className="flex flex-wrap items-center gap-1.5">
                  <AccountStatusBadge status={u.status} />
                  {u.isAdmin && <AdminBadge />}
                  <span className="text-xs text-ink-500">Seen {lastSeen(u, now, timeZone)}</span>
                </div>
              </div>
              <ChevronRight className="size-4 shrink-0 text-ink-300" aria-hidden />
            </Link>
          </li>
        ))}
      </ul>

      {/* Tablets and up */}
      <table className="hidden w-full table-fixed text-left text-sm md:table">
        <thead className="border-b border-ink-100 bg-ink-50/60 text-xs font-medium uppercase tracking-wide text-ink-500">
          <tr>
            <th scope="col" className="w-[34%] px-3 py-2.5 font-medium lg:px-4">
              Person
            </th>
            <th scope="col" className="w-[30%] px-3 py-2.5 font-medium lg:px-4">
              Email
            </th>
            <th scope="col" className="w-[21%] px-3 py-2.5 font-medium lg:px-4">
              Status
            </th>
            <th scope="col" className="w-[15%] px-3 py-2.5 text-right font-medium lg:px-4">
              Last seen
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-ink-100">
          {users.map((u) => (
            <tr key={u.id} className="transition-colors hover:bg-ink-50">
              <td className="px-3 py-2 lg:px-4">
                <Link href={`/admin/users/${u.id}`} className="flex min-h-10 min-w-0 items-center rounded-md hover:text-brand-700">
                  <UserChip name={u.name} role={u.role} subteam={u.subteam} className="max-w-full" />
                </Link>
              </td>
              <td className="truncate px-3 py-2 text-ink-600 lg:px-4" title={u.email}>
                {u.email}
              </td>
              <td className="px-3 py-2 lg:px-4">
                <div className="flex flex-wrap items-center gap-1.5">
                  <AccountStatusBadge status={u.status} />
                  {u.isAdmin && <AdminBadge />}
                </div>
              </td>
              <td className="truncate px-3 py-2 text-right text-ink-500 lg:px-4">{lastSeen(u, now, timeZone)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
