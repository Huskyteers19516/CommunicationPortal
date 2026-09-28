import { ChevronRight, Megaphone } from "lucide-react";
import Link from "next/link";
import { SubteamBadge } from "@/components/app/badges";
import { announcementFocusHref } from "@/lib/announcements";
import { formatDateTime, timeAgo } from "@/lib/dates";
import type { UnreadAnnouncement } from "@/server/queries/announcements";

/**
 * Today page: the newest announcements for this person they haven't seen yet (title, who, when — each opens it on
 * Announcements), with "See all". Renders nothing when there are none.
 */
export function TodayAnnouncements({
  items,
  total,
  now,
  timeZone,
}: {
  items: UnreadAnnouncement[];
  total: number;
  now: Date;
  timeZone: string;
}) {
  if (items.length === 0) return null;
  const more = total - items.length;
  return (
    <section aria-labelledby="today-announcements-heading" className="rounded-xl border border-brand-200 bg-white shadow-sm">
      <div className="flex items-center justify-between gap-3 border-b border-ink-100 py-1 pl-4 pr-2">
        <h2 id="today-announcements-heading" className="flex items-center gap-2 text-sm font-semibold text-ink-900">
          <Megaphone className="size-4 text-brand-600" aria-hidden />
          {total === 1 ? "New announcement" : `${total} new announcements`}
        </h2>
        <Link
          href="/announcements"
          className="inline-flex h-10 shrink-0 items-center gap-1 rounded-lg px-2 text-sm font-medium text-brand-700 transition-colors hover:bg-brand-50 hover:text-brand-800"
        >
          See all
          <span className="sr-only"> announcements</span>
          <ChevronRight className="size-4" aria-hidden />
        </Link>
      </div>
      <ul className="divide-y divide-ink-100">
        {items.map((a) => (
          <li key={a.id}>
            <Link
              href={announcementFocusHref(a.id)}
              className="block min-h-12 px-4 py-2.5 transition-colors hover:bg-ink-50 focus-visible:bg-ink-50"
            >
              <span className="block text-sm font-medium text-ink-900 wrap-anywhere">{a.title}</span>
              <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-500">
                <span className="min-w-0 wrap-anywhere">{a.authorName ?? "A former member"}</span>
                <span aria-hidden>·</span>
                <time dateTime={a.createdAt.toISOString()} title={formatDateTime(a.createdAt, timeZone)} className="whitespace-nowrap">
                  {timeAgo(a.createdAt, now, timeZone)}
                </time>
                <span className="sr-only">, for</span>
                <SubteamBadge subteam={a.subteam} />
              </span>
            </Link>
          </li>
        ))}
      </ul>
      {more > 0 && (
        <p className="border-t border-ink-100 px-4 py-2 text-xs text-ink-500">
          {more === 1 ? "1 more is waiting" : `${more} more are waiting`} on Announcements.
        </p>
      )}
    </section>
  );
}
