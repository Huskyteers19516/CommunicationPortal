import { ChevronRight } from "lucide-react";
import Link from "next/link";
import type { ExtraMeetingRef } from "@/server/queries/attendance";
import { CALENDAR_KIND_ICONS, CalendarKindBadge } from "../calendar/kind-styles";

const MeetingIcon = CALENDAR_KIND_ICONS.MEETING;

/** The small "Extra meeting" badge (the Team calendar's color for it) next to a day's date. Nothing when there's none. */
export function ExtraMeetingBadge({ meetings }: { meetings: ExtraMeetingRef[] }) {
  return meetings.length > 0 ? <CalendarKindBadge kind="MEETING" /> : null;
}

/** Each extra meeting on a day, by its title, opening its Team calendar page (times, place, notes). */
export function ExtraMeetingLinks({ meetings }: { meetings: ExtraMeetingRef[] }) {
  if (meetings.length === 0) return null;
  return (
    <div className="space-y-1.5">
      {meetings.map((m) => (
        <Link
          key={m.id}
          href={`/calendar/${m.id}`}
          className="flex min-h-10 items-center gap-2 rounded-lg bg-teal-50 px-3 py-2 text-sm text-teal-900 transition-colors hover:bg-teal-100"
        >
          <MeetingIcon className="size-4 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1 wrap-anywhere">
            <span className="sr-only">Extra meeting: </span>
            <span className="font-medium">{m.title}</span>
          </span>
          <ChevronRight className="size-4 shrink-0" aria-hidden />
        </Link>
      ))}
    </div>
  );
}
