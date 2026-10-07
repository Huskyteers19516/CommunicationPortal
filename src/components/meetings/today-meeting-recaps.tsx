import { AudioLines, ChevronRight } from "lucide-react";
import Link from "next/link";
import { type DateOnly, formatDateOnly } from "@/lib/dates";
import { meetingAudioUntilLabel } from "@/lib/meeting-recap-view";
import { meetingRecapHref } from "@/lib/meeting-recaps";
import type { MeetingRecapCard } from "@/server/queries/meeting-recaps";

/**
 * Today page: recaps saved in the last 3 days (getRecentMeetingRecaps, up to 3) — title, the meeting's day, its
 * categories, and whether the recording can still be played — each opening the recap, with "See all". Renders nothing
 * when there are none.
 */
export function TodayMeetingRecaps({ items, today, timeZone }: { items: MeetingRecapCard[]; today: DateOnly; timeZone: string }) {
  if (items.length === 0) return null;
  return (
    <section aria-labelledby="today-meeting-recaps-heading" className="rounded-xl border border-ink-200 bg-white shadow-sm">
      <div className="flex items-center justify-between gap-3 border-b border-ink-100 py-1 pl-4 pr-2">
        <h2 id="today-meeting-recaps-heading" className="flex items-center gap-2 text-sm font-semibold text-ink-900">
          <AudioLines className="size-4 text-brand-600" aria-hidden />
          Meeting recaps
        </h2>
        <Link
          href="/meetings"
          className="inline-flex h-10 shrink-0 items-center gap-1 rounded-lg px-2 text-sm font-medium text-brand-700 transition-colors hover:bg-brand-50 hover:text-brand-800"
        >
          See all
          <span className="sr-only"> meeting recaps</span>
          <ChevronRight className="size-4" aria-hidden />
        </Link>
      </div>
      <ul className="divide-y divide-ink-100">
        {items.map((r) => (
          <li key={r.id}>
            <Link
              href={meetingRecapHref(r.id)}
              className="block min-h-12 px-4 py-2.5 transition-colors hover:bg-ink-50 focus-visible:bg-ink-50"
            >
              <span className="block text-sm font-medium text-ink-900 wrap-anywhere">{r.title}</span>
              <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-500">
                <time dateTime={r.meetingDate} className="whitespace-nowrap">
                  {formatDateOnly(r.meetingDate, today)}
                </time>
                {r.categories.length > 0 && (
                  <>
                    <span aria-hidden>·</span>
                    <span className="min-w-0 wrap-anywhere">{r.categories.map((c) => c.name).join(", ")}</span>
                  </>
                )}
                {r.audio.state === "ready" && (
                  <>
                    <span aria-hidden>·</span>
                    <span className="whitespace-nowrap text-sky-700">
                      Recording until {meetingAudioUntilLabel(r.audio.expiresAt, timeZone)}
                    </span>
                  </>
                )}
              </span>
            </Link>
          </li>
        ))}
      </ul>
      <p className="border-t border-ink-100 px-4 py-2 text-xs text-ink-500">Saved in the last 3 days.</p>
    </section>
  );
}
