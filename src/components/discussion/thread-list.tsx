import Link from "next/link";
import { cn } from "@/lib/cn";
import { formatDateTime, timeAgo } from "@/lib/dates";
import { discussionHref, repliesLabel } from "@/lib/discussion";
import type { DiscussionThreadCard } from "@/server/queries/discussion";
import {
  DiscussionCategoryBadge,
  DiscussionLockedBadge,
  DiscussionPinnedBadge,
  DiscussionUnreadMarker,
  discussionUnreadText,
} from "./badges";

const FORMER = "a former member";

/**
 * Discussions as cards: category, pinned, locked, what's new for me, the title (the link, stretched over the card;
 * its name also says what's new, e.g. "Intake jams (2 new replies)"), who started it, how many replies, and the
 * last activity ("last reply 2 h ago by Ethan Chen").
 */
export function DiscussionThreadList({ threads, now, timeZone }: { threads: DiscussionThreadCard[]; now: Date; timeZone: string }) {
  return (
    <ul className="space-y-3">
      {threads.map((t) => {
        const who = t.lastActivityMine ? "you" : (t.lastActivityByName ?? FORMER);
        return (
          <li key={t.id} className="min-w-0">
            <article
              className={cn(
                "relative min-w-0 rounded-xl border bg-white p-4 shadow-sm transition-colors focus-within:border-brand-300 hover:border-brand-300",
                t.unread ? "border-brand-200" : "border-ink-200",
              )}
            >
              <div className="flex flex-wrap items-center gap-1.5">
                {t.unread && <DiscussionUnreadMarker isNew={t.isNew} newReplies={t.newReplies} />}
                <DiscussionCategoryBadge category={t.category} />
                {t.pinned && <DiscussionPinnedBadge />}
                {t.locked && <DiscussionLockedBadge />}
              </div>
              <h2 className={cn("mt-1.5 text-base text-ink-900 wrap-anywhere", t.unread ? "font-semibold" : "font-medium")}>
                {/* The whole card opens it; nothing else in the card is clickable. Its focus shows as the card's ring
                    only (`!`: the global :focus-visible outline would otherwise draw a second one around the title). */}
                <Link
                  href={discussionHref(t.id)}
                  className="rounded after:absolute after:inset-0 after:rounded-xl hover:text-brand-800 focus-visible:outline-none! focus-visible:after:ring-2 focus-visible:after:ring-brand-500/50"
                >
                  {t.title}
                  {t.unread && <span className="sr-only"> ({discussionUnreadText(t.isNew, t.newReplies)})</span>}
                </Link>
              </h2>
              <p className="mt-1 text-xs text-ink-500 wrap-anywhere">
                {/* "Started by Maya Patel · 3 replies · last reply 2 h ago by Ethan Chen" / "Started by you · No replies yet · posted 5 min ago" */}
                <span>Started by {t.mine ? "you" : (t.authorName ?? FORMER)}</span>
                <span aria-hidden> · </span>
                <span className="whitespace-nowrap">{repliesLabel(t.replyCount)}</span>
                <span aria-hidden> · </span>
                <span>
                  {t.replyCount > 0 ? "last reply " : "posted "}
                  <time dateTime={t.lastActivityAt.toISOString()} title={formatDateTime(t.lastActivityAt, timeZone)} className="whitespace-nowrap">
                    {timeAgo(t.lastActivityAt, now, timeZone)}
                  </time>
                  {t.replyCount > 0 && <> by {who}</>}
                </span>
              </p>
            </article>
          </li>
        );
      })}
    </ul>
  );
}
