import { Clock, MessageCircle, Sparkles } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { QuestionStatusBadge, SubteamBadge } from "@/components/app/badges";
import { UserChipWithPhoto } from "@/components/app/user-avatar";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/cn";
import { formatDateTime, timeAgo } from "@/lib/dates";
import type { InboxRow, MyQuestionRow } from "@/server/queries/questions";
import { audienceLabel, repliesLabel, waitingLabel, type WaitLevel } from "./labels";

const waitTone: Record<WaitLevel, string> = {
  fresh: "text-amber-700",
  waiting: "font-semibold text-amber-700",
  late: "font-semibold text-red-600",
};

function Meta({ children }: { children: ReactNode }) {
  return <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm text-ink-500">{children}</div>;
}

function ReplyCount({ count }: { count: number }) {
  return (
    <span className="inline-flex items-center gap-1">
      <MessageCircle className="size-3.5" aria-hidden />
      {repliesLabel(count)}
    </span>
  );
}

/** The asker's own questions. ANSWERED ones stand out — there's something new to read. */
export function MyQuestionList({ items, now, timeZone }: { items: MyQuestionRow[]; now: Date; timeZone: string }) {
  return (
    <Card className="overflow-hidden">
      <ul className="divide-y divide-ink-100">
        {items.map((q) => {
          const isNew = q.status === "ANSWERED";
          return (
            <li key={q.id}>
              <Link
                href={`/questions/${q.id}`}
                className={cn(
                  "relative block px-4 py-3.5 transition-colors sm:px-5",
                  isNew ? "bg-brand-50/70 hover:bg-brand-50" : "hover:bg-ink-50",
                )}
              >
                {isNew && <span className="absolute inset-y-0 left-0 w-1 bg-brand-500" aria-hidden />}
                <div className="flex items-start justify-between gap-3">
                  <p className={cn("min-w-0 break-words text-ink-900", isNew ? "font-semibold" : "font-medium")}>{q.title}</p>
                  <QuestionStatusBadge status={q.status} />
                </div>
                {isNew && (
                  <p className="mt-1 inline-flex items-center gap-1.5 text-sm font-semibold text-brand-700">
                    <Sparkles className="size-4" aria-hidden />
                    New answer{q.lastReply && !q.lastReply.byMe ? ` from ${q.lastReply.authorName}` : ""}
                  </p>
                )}
                <Meta>
                  <span className="min-w-0 truncate">to {audienceLabel(q.recipientName, q.subteam)}</span>
                  <ReplyCount count={q.replyCount} />
                  <time
                    className="whitespace-nowrap"
                    dateTime={q.lastActivityAt.toISOString()}
                    title={formatDateTime(q.lastActivityAt, timeZone)}
                  >
                    {timeAgo(q.lastActivityAt, now, timeZone)}
                  </time>
                </Meta>
              </Link>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

/** Staff inbox rows: who asked, where it belongs, and how long it has been waiting. */
export function InboxList({ items, now, timeZone }: { items: InboxRow[]; now: Date; timeZone: string }) {
  return (
    <Card className="overflow-hidden">
      <ul className="divide-y divide-ink-100">
        {items.map((q) => {
          const wait = q.status === "OPEN" ? waitingLabel(q.lastActivityAt, now) : null;
          return (
            <li key={q.id}>
              <Link href={`/questions/${q.id}`} className="block px-4 py-3.5 transition-colors hover:bg-ink-50 sm:px-5">
                <div className="flex items-start justify-between gap-3">
                  <UserChipWithPhoto userId={q.asker.id} name={q.asker.name} role={q.asker.role} subteam={q.asker.subteam} size="sm" />
                  <QuestionStatusBadge status={q.status} />
                </div>
                <p className="mt-2 break-words font-medium text-ink-900">{q.title}</p>
                <Meta>
                  <SubteamBadge subteam={q.subteam} />
                  {q.toMe ? (
                    <Badge tone="brand">To you</Badge>
                  ) : (
                    q.recipientName && <span className="min-w-0 truncate">to {q.recipientName}</span>
                  )}
                  <ReplyCount count={q.replyCount} />
                  {wait ? (
                    <span className={cn("inline-flex items-center gap-1", waitTone[wait.level])}>
                      <Clock className="size-3.5" aria-hidden />
                      {wait.label}
                    </span>
                  ) : (
                    <time
                      className="whitespace-nowrap"
                      dateTime={q.lastActivityAt.toISOString()}
                      title={formatDateTime(q.lastActivityAt, timeZone)}
                    >
                      {timeAgo(q.lastActivityAt, now, timeZone)}
                    </time>
                  )}
                </Meta>
              </Link>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

export interface StatusFilterItem {
  href: string;
  label: string;
  count: number;
  active: boolean;
}

/** Pill filters under the Inbox tab (Open / Answered / Resolved / All). */
export function StatusFilter({ items }: { items: StatusFilterItem[] }) {
  return (
    <nav aria-label="Filter by status" className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
      <ul className="flex gap-2 pb-1">
        {items.map((f) => (
          <li key={f.href} className="shrink-0">
            <Link
              href={f.href}
              aria-current={f.active ? "page" : undefined}
              className={cn(
                "inline-flex h-10 items-center gap-2 rounded-full border px-4 text-sm font-medium transition-colors",
                f.active
                  ? "border-brand-500 bg-brand-50 text-brand-800"
                  : "border-ink-200 bg-white text-ink-600 hover:bg-ink-50 hover:text-ink-900",
              )}
            >
              {f.label}
              <span className={cn("text-xs tabular-nums", f.active ? "text-brand-700" : "text-ink-500")}>{f.count}</span>
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
