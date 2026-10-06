import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { ProgressBar } from "@/components/ui/progress-bar";
import { cn } from "@/lib/cn";
import type { ProgressRange, SubteamProgress, TeamProgressRow } from "@/server/queries/progress";
import { PersonLabel } from "./person-label";
import { lastSeenLabel, memberProgressHref, subteamGroupLabel } from "./progress-links";

function rateLabel(rate: number | null): string {
  return rate === null ? "—" : `${rate}%`;
}

/** One small card per subteam: approved/total, completion rate, overdue. */
export function SubteamSummaryStrip({ groups, className }: { groups: SubteamProgress[]; className?: string }) {
  if (groups.length === 0) return null;
  return (
    <ul
      className={cn(
        "grid gap-3",
        groups.length === 1 ? "grid-cols-1 sm:max-w-xs" : "grid-cols-2",
        groups.length === 3 && "md:grid-cols-3",
        groups.length >= 4 && "md:grid-cols-4",
        className,
      )}
    >
      {groups.map((g) => (
        <li key={g.subteam ?? "none"} className="rounded-xl border border-ink-200 bg-white p-3 shadow-sm sm:p-4">
          <div className="flex items-baseline justify-between gap-2">
            <p className="truncate text-sm font-medium text-ink-800">{subteamGroupLabel(g.subteam)}</p>
            <p className="shrink-0 text-xs text-ink-500">
              {g.people} {g.people === 1 ? "person" : "people"}
            </p>
          </div>
          <p className="mt-1 font-display text-2xl font-semibold tabular-nums text-ink-900">
            {g.approved}
            <span className="text-base text-ink-500">/{g.total}</span>
          </p>
          <ProgressBar done={g.approved} pending={g.submitted} total={g.total} showLabel={false} className="mt-2" />
          <p className="mt-2 flex flex-wrap items-center gap-x-2 text-xs text-ink-500">
            <span>{g.completionRate === null ? "Nothing due" : `${g.completionRate}% approved`}</span>
            {g.overdue > 0 && <span className="font-medium text-red-600">{g.overdue} overdue</span>}
          </p>
        </li>
      ))}
    </ul>
  );
}

function OverdueBadge({ count }: { count: number }) {
  if (count === 0) return <span className="text-sm tabular-nums text-ink-500">0</span>;
  return <Badge tone="red">{count} overdue</Badge>;
}

/**
 * People and their numbers: a table on md+ screens, stacked cards on phones.
 * Names always show in full (they wrap instead of being cut off).
 */
export function TeamProgressList({
  rows,
  range,
  now,
  timeZone,
}: {
  rows: TeamProgressRow[];
  range: ProgressRange;
  now: Date;
  timeZone: string;
}) {
  return (
    <>
      {/* Phones: stacked cards */}
      <ul className="divide-y divide-ink-100 md:hidden">
        {rows.map((r) => (
          <li key={r.user.id}>
            <Link
              href={memberProgressHref(r.user.id, range)}
              className="block px-4 py-3.5 transition-colors hover:bg-ink-50 active:bg-ink-100"
            >
              <div className="flex items-center justify-between gap-3">
                <PersonLabel userId={r.user.id} name={r.user.name} role={r.user.role} subteam={r.user.subteam} />
                <ChevronRight className="size-5 shrink-0 text-ink-300" aria-hidden />
              </div>
              <ProgressBar done={r.approved} pending={r.submitted} total={r.total} className="mt-3" />
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-ink-500">
                {r.overdue > 0 && <Badge tone="red">{r.overdue} overdue</Badge>}
                {r.submitted > 0 && <Badge tone="yellow">{r.submitted} waiting</Badge>}
                <span>{r.completionRate === null ? "Nothing due" : `${r.completionRate}% approved`}</span>
                <span>Last seen {lastSeenLabel(r.user.lastSeenAt, now, timeZone)}</span>
              </div>
            </Link>
          </li>
        ))}
      </ul>

      {/* Tablets and up: table. The name column never collapses below a readable width; the
          separate "open" arrow only shows on wide screens (the name is the same link). */}
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-ink-100 text-xs font-medium uppercase tracking-wide text-ink-500">
              <th scope="col" className="px-5 py-2.5 font-medium">
                Person
              </th>
              <th scope="col" className="w-[22%] px-3 py-2.5 font-medium">
                Approved
              </th>
              <th scope="col" className="px-3 py-2.5 text-right font-medium">
                Rate
              </th>
              <th scope="col" className="px-3 py-2.5 text-right font-medium">
                Waiting
              </th>
              <th scope="col" className="px-3 py-2.5 font-medium">
                Overdue
              </th>
              <th scope="col" className="px-3 py-2.5 font-medium">
                Last seen
              </th>
              <th scope="col" className="hidden w-12 px-3 py-2.5 xl:table-cell">
                <span className="sr-only">Open</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {rows.map((r) => {
              const href = memberProgressHref(r.user.id, range);
              return (
                <tr key={r.user.id} className="transition-colors hover:bg-ink-50">
                  <td className="px-5 py-3">
                    <Link href={href} className="group block min-w-40 rounded-md py-0.5">
                      <PersonLabel
                        userId={r.user.id}
                        name={r.user.name}
                        role={r.user.role}
                        subteam={r.user.subteam}
                        nameClassName="group-hover:underline"
                      />
                    </Link>
                  </td>
                  <td className="px-3 py-3">
                    <ProgressBar done={r.approved} pending={r.submitted} total={r.total} className="min-w-28" />
                  </td>
                  <td className="px-3 py-3 text-right tabular-nums text-ink-700">{rateLabel(r.completionRate)}</td>
                  <td className={cn("px-3 py-3 text-right tabular-nums", r.submitted > 0 ? "font-medium text-amber-700" : "text-ink-500")}>
                    {r.submitted}
                  </td>
                  <td className="px-3 py-3">
                    <OverdueBadge count={r.overdue} />
                  </td>
                  <td className="whitespace-nowrap px-3 py-3 text-ink-500">{lastSeenLabel(r.user.lastSeenAt, now, timeZone)}</td>
                  <td className="hidden px-3 py-3 text-right xl:table-cell">
                    <Link
                      href={href}
                      aria-label={`Open ${r.user.name}'s progress`}
                      className="inline-flex size-10 items-center justify-center rounded-lg text-ink-400 hover:bg-ink-100 hover:text-ink-700"
                    >
                      <ChevronRight className="size-5" aria-hidden />
                    </Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
