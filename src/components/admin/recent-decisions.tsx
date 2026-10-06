import Link from "next/link";
import { UserAvatar } from "@/components/app/user-avatar";
import { describeRole } from "@/components/app/user-chip";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader } from "@/components/ui/card";
import { formatDateTime, timeAgo } from "@/lib/dates";
import type { RecentDecision } from "@/server/queries/admin";

export function RecentDecisions({ decisions, now, timeZone }: { decisions: RecentDecision[]; now: Date; timeZone: string }) {
  return (
    <Card>
      <CardHeader title="Recently decided" />
      {decisions.length === 0 ? (
        <p className="px-4 py-6 text-center text-sm text-ink-500 sm:px-5">No approvals or rejections yet.</p>
      ) : (
        <ul className="divide-y divide-ink-100">
          {decisions.map((d) => (
            <li key={`${d.id}-${d.decision}`}>
              <Link
                href={`/admin/users/${d.id}`}
                className="flex min-h-14 items-center gap-3 px-4 py-2.5 transition-colors hover:bg-ink-50 sm:px-5"
              >
                <UserAvatar userId={d.id} name={d.name} size="sm" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-ink-900">{d.name}</p>
                  {/* When comes first and the line wraps, so the date is never the part that gets cut. */}
                  <p className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-ink-500">
                    <time
                      dateTime={d.decidedAt.toISOString()}
                      title={formatDateTime(d.decidedAt, timeZone)}
                      className="whitespace-nowrap font-medium text-ink-600"
                    >
                      {timeAgo(d.decidedAt, now, timeZone)}
                    </time>
                    <span className="min-w-0 break-words">
                      {d.decision === "APPROVED" ? `As ${describeRole(d.role, d.subteam)}` : describeRole(d.role, d.subteam)}
                    </span>
                    {d.decidedBy && <span className="min-w-0 break-words">by {d.decidedBy}</span>}
                  </p>
                </div>
                <Badge tone={d.decision === "APPROVED" ? "green" : "red"}>
                  {d.decision === "APPROVED" ? "Approved" : "Rejected"}
                </Badge>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
