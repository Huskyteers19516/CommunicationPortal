import type { ReactNode } from "react";
import { Card, CardHeader } from "@/components/ui/card";
import { cn } from "@/lib/cn";
import { ASSIGNMENT_STATUS_LABELS } from "@/lib/constants";
import { formatDateTime, timeAgo } from "@/lib/dates";
import type { UserDetail } from "@/server/queries/admin";

function Row({ label, children, sub }: { label: string; children: ReactNode; sub?: boolean }) {
  return (
    <div className={cn("flex items-baseline justify-between gap-4 px-4 text-sm sm:px-5", sub ? "py-1.5" : "py-2.5")}>
      <dt className={cn("text-ink-500", sub && "pl-3")}>{label}</dt>
      <dd className="min-w-0 text-right font-medium tabular-nums text-ink-900">{children}</dd>
    </div>
  );
}

export function UserStats({ user, now, timeZone }: { user: UserDetail; now: Date; timeZone: string }) {
  const a = user.assignments;
  const totalAssigned = a.TODO + a.SUBMITTED + a.APPROVED + a.REJECTED + user.closedAssignments;
  return (
    <Card>
      <CardHeader title="Activity" />
      <dl className="divide-y divide-ink-100">
        <Row label="Checklist items">{totalAssigned}</Row>
        {(["TODO", "SUBMITTED", "APPROVED", "REJECTED"] as const).map((s) => (
          <Row key={s} label={ASSIGNMENT_STATUS_LABELS[s]} sub>
            {a[s]}
          </Row>
        ))}
        {user.closedAssignments > 0 && (
          <Row label="Closed with a finished task" sub>
            {user.closedAssignments}
          </Row>
        )}
        <Row label="Tasks created">{user.tasksCreated}</Row>
        <Row label="Questions asked">{user.questionsAsked}</Row>
        <Row label="Signed in on">
          {user.activeSessions} device{user.activeSessions === 1 ? "" : "s"}
        </Row>
        <Row label="Last seen">
          {user.lastSeenAt ? <time title={formatDateTime(user.lastSeenAt, timeZone)}>{timeAgo(user.lastSeenAt, now, timeZone)}</time> : "Never"}
        </Row>
        <Row label="Registered">
          <time title={formatDateTime(user.createdAt, timeZone)}>{timeAgo(user.createdAt, now, timeZone)}</time>
        </Row>
        {user.approvedAt && (
          <Row label="Approved">
            {formatDateTime(user.approvedAt, timeZone)}
            {user.approvedBy ? ` by ${user.approvedBy}` : ""}
          </Row>
        )}
      </dl>
    </Card>
  );
}
