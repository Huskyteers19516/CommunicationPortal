import { ChevronRight, PenLine, ScrollText } from "lucide-react";
import Link from "next/link";
import { SubteamBadge } from "@/components/app/badges";
import { SUBTEAM_LABELS } from "@/lib/constants";
import { meetingUpdateFocusHref, newMeetingUpdateHref } from "@/lib/meeting-updates";
import type { TodayUpdateStatus } from "@/server/queries/meeting-updates";

type Written = TodayUpdateStatus["subteams"][number]["updates"];

/** "you", "Ethan Chen", "Ethan Chen and you", "Ethan Chen and 2 others". */
function writers(updates: Written): string {
  const names = [...new Set(updates.map((u) => (u.mine ? "you" : (u.authorName ?? "a former member"))))];
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names[0]} and ${names.length - 1} others`;
}

const linkRow =
  "flex min-h-12 items-center gap-3 rounded-xl border px-4 py-3 text-sm font-medium shadow-sm transition-colors";

/**
 * Today page: whether today's meeting update is written for the viewer's subteam — "Write today's Build
 * meeting update" or "Build's update for today: written by …". People who write for every subteam (the
 * captain, mentors, teachers, owners) get one small card with all three. Renders nothing for `null`
 * (nobody to nudge: see getTodayUpdateStatus).
 */
export function TodayUpdateNudge({ status }: { status: TodayUpdateStatus | null }) {
  if (!status || status.subteams.length === 0) return null;

  if (status.subteams.length === 1) {
    const { subteam, updates } = status.subteams[0];
    const label = SUBTEAM_LABELS[subteam];
    if (updates.length === 0) {
      return (
        <Link
          href={newMeetingUpdateHref(status.today, subteam)}
          className={`${linkRow} border-brand-200 bg-brand-50 text-brand-900 hover:border-brand-300 hover:bg-brand-100`}
        >
          <PenLine className="size-5 shrink-0 text-brand-600" aria-hidden />
          <span className="flex-1">Write today&apos;s {label} meeting update</span>
          <ChevronRight className="size-4 shrink-0 text-brand-700" aria-hidden />
        </Link>
      );
    }
    return (
      <Link
        href={meetingUpdateFocusHref(updates[0].id)}
        className={`${linkRow} border-ink-200 bg-white text-ink-800 hover:bg-ink-50`}
      >
        <ScrollText className="size-5 shrink-0 text-ink-500" aria-hidden />
        <span className="min-w-0 flex-1 wrap-anywhere">
          {label}&apos;s update for today: written by {writers(updates)}
        </span>
        <ChevronRight className="size-4 shrink-0 text-ink-500" aria-hidden />
      </Link>
    );
  }

  return (
    <section aria-labelledby="today-updates-heading" className="rounded-xl border border-ink-200 bg-white shadow-sm">
      <div className="flex items-center justify-between gap-3 border-b border-ink-100 px-4 py-2">
        <h2 id="today-updates-heading" className="flex items-center gap-2 text-sm font-semibold text-ink-900">
          <ScrollText className="size-4 text-ink-500" aria-hidden />
          Today&apos;s meeting updates
        </h2>
        <Link
          href="/updates"
          className="-mr-2 inline-flex h-10 items-center rounded-lg px-2 text-sm font-medium text-brand-700 hover:bg-brand-50 hover:text-brand-800"
        >
          See all
        </Link>
      </div>
      <ul className="divide-y divide-ink-100">
        {status.subteams.map(({ subteam, updates }) => (
          <li key={subteam} className="flex min-h-12 flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 py-1.5 text-sm">
            <span className="flex min-w-0 items-center gap-2">
              <SubteamBadge subteam={subteam} />
              {updates.length > 0 ? (
                <span className="min-w-0 text-ink-700 wrap-anywhere">Written by {writers(updates)}</span>
              ) : (
                <span className="text-ink-500">Not written yet</span>
              )}
            </span>
            {updates.length > 0 ? (
              <Link
                href={meetingUpdateFocusHref(updates[0].id)}
                className="-mr-2 inline-flex h-10 items-center rounded-lg px-2 font-medium text-brand-700 hover:bg-brand-50 hover:text-brand-800"
              >
                Read<span className="sr-only"> today&apos;s {SUBTEAM_LABELS[subteam]} update</span>
              </Link>
            ) : (
              <Link
                href={newMeetingUpdateHref(status.today, subteam)}
                className="-mr-2 inline-flex h-10 items-center gap-1.5 rounded-lg px-2 font-medium text-brand-700 hover:bg-brand-50 hover:text-brand-800"
              >
                <PenLine className="size-4" aria-hidden />
                Write it<span className="sr-only"> — today&apos;s {SUBTEAM_LABELS[subteam]} update</span>
              </Link>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
