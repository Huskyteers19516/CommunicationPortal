import { AudioLines, CalendarDays, Clock } from "lucide-react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { type DateOnly, formatDateOnly } from "@/lib/dates";
import { meetingAudioUntilLabel, meetingRecapOrigin } from "@/lib/meeting-recap-view";
import { formatMeetingDuration, meetingRecapHref } from "@/lib/meeting-recaps";
import type { MeetingRecapCard as MeetingRecapCardData } from "@/server/queries/meeting-recaps";

/**
 * One recap on the list: its categories, the title (the link, stretched over the card), the meeting's day, length,
 * and who saved it, its first key points (and how many more), and whether its recording can still be played ("Recording
 * until Fri 3:40 PM") or is still uploading.
 */
export function MeetingRecapCard({ recap, today, timeZone }: { recap: MeetingRecapCardData; today: DateOnly; timeZone: string }) {
  const more = recap.keyPointCount - recap.keyPointsPreview.length;
  const titleId = `recap-${recap.id}-title`;
  return (
    <article
      aria-labelledby={titleId}
      className="relative min-w-0 rounded-xl border border-ink-200 bg-white p-4 shadow-sm transition-colors focus-within:border-brand-300 hover:border-brand-300 sm:px-5"
    >
      {recap.categories.length > 0 && (
        <div className="mb-1.5 flex flex-wrap gap-1.5">
          {recap.categories.map((c) => (
            <Badge key={c.id} tone="brand" className="max-w-full">
              <span className="truncate">{c.name}</span>
            </Badge>
          ))}
        </div>
      )}
      <h2 id={titleId} className="text-base font-semibold text-ink-900 wrap-anywhere">
        {/* The whole card opens it; its focus shows as the card's ring only. */}
        <Link
          href={meetingRecapHref(recap.id)}
          className="rounded after:absolute after:inset-0 after:rounded-xl hover:text-brand-800 focus-visible:outline-none! focus-visible:after:ring-2 focus-visible:after:ring-brand-500/50"
        >
          {recap.title}
        </Link>
      </h2>
      <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-500">
        <span className="inline-flex items-center gap-1 whitespace-nowrap">
          <CalendarDays className="size-3.5" aria-hidden />
          <time dateTime={recap.meetingDate}>{formatDateOnly(recap.meetingDate, today)}</time>
        </span>
        {recap.durationSec !== null && (
          <span className="inline-flex items-center gap-1 whitespace-nowrap">
            <Clock className="size-3.5" aria-hidden />
            {formatMeetingDuration(recap.durationSec)}
          </span>
        )}
        <span className="min-w-0 wrap-anywhere">
          {meetingRecapOrigin(recap)} by {recap.createdBy?.name ?? "a former member"}
        </span>
      </p>

      {recap.keyPointsPreview.length > 0 && (
        <ul className="mt-3 space-y-1 text-sm text-ink-700">
          {recap.keyPointsPreview.map((point, i) => (
            <li key={i} className="flex min-w-0 gap-2">
              <span className="mt-2 size-1.5 shrink-0 rounded-full bg-brand-500" aria-hidden />
              <span className="line-clamp-2 min-w-0 wrap-anywhere">{point}</span>
            </li>
          ))}
        </ul>
      )}
      {more > 0 && (
        <p className="mt-1 pl-3.5 text-xs text-ink-500">
          and {more} more {more === 1 ? "key point" : "key points"}
        </p>
      )}

      {recap.audio.state === "ready" && (
        <p className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-sky-50 px-2.5 py-1 text-xs font-medium text-sky-800">
          <AudioLines className="size-3.5" aria-hidden />
          Recording until {meetingAudioUntilLabel(recap.audio.expiresAt, timeZone)}
        </p>
      )}
      {recap.audio.state === "uploading" && (
        <p className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-800">
          <AudioLines className="size-3.5" aria-hidden />
          Recording still uploading
        </p>
      )}
    </article>
  );
}
