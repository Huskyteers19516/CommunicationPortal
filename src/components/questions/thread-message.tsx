import type { Role } from "@/generated/prisma/enums";
import { RoleBadge } from "@/components/app/badges";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { RichText } from "@/components/ui/rich-text";
import { cn } from "@/lib/cn";
import { formatDateTime, timeAgo } from "@/lib/dates";

/**
 * One chat-style message in a question thread. Staff answers get a subtle brand-tinted bubble and a
 * role badge; the viewer's own messages sit on the right.
 */
export function ThreadMessage({
  author,
  body,
  createdAt,
  staff,
  mine,
  now,
  timeZone,
}: {
  author: { name: string; role: Role; isAdmin: boolean };
  body: string;
  createdAt: Date;
  /** A staff answer (not the asker). */
  staff: boolean;
  mine: boolean;
  now: Date;
  timeZone: string;
}) {
  return (
    <li className={cn("flex items-start gap-2.5", mine && "flex-row-reverse")}>
      <Avatar name={author.name} size="sm" className="mt-0.5" />
      <div
        className={cn(
          "min-w-0 max-w-[85%] rounded-2xl border px-3.5 py-2.5 shadow-sm sm:max-w-[75%]",
          staff ? "border-brand-200 bg-brand-50" : "border-ink-200 bg-white",
          mine ? "rounded-tr-md" : "rounded-tl-md",
        )}
      >
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm font-semibold text-ink-900">
            {author.name}
            {mine && <span className="font-normal text-ink-500"> (you)</span>}
          </span>
          {staff &&
            (author.role === "MEMBER" && author.isAdmin ? <Badge tone="brand">Owner</Badge> : <RoleBadge role={author.role} />)}
          <time
            className="whitespace-nowrap text-xs text-ink-500"
            dateTime={createdAt.toISOString()}
            title={formatDateTime(createdAt, timeZone)}
          >
            {timeAgo(createdAt, now, timeZone)}
          </time>
        </div>
        <RichText text={body} className="mt-1 text-sm text-ink-800" />
      </div>
    </li>
  );
}
