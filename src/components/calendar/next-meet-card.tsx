import { CalendarDays, ChevronRight } from "lucide-react";
import Link from "next/link";
import { eventCountdown, formatEventWhen } from "@/lib/calendar";
import type { DateOnly } from "@/lib/dates";
import type { NextMeet } from "@/server/queries/calendar";
import { WhenText } from "./when-text";

/** "Next meet in 12 days", "Next meet is tomorrow", "Next meet is today!", "Meet happening now". */
export function nextMeetHeadline(daysUntil: number, happeningNow: boolean): string {
  if (happeningNow) return "Meet happening now";
  if (daysUntil === 0) return "Next meet is today!";
  if (daysUntil === 1) return "Next meet is tomorrow";
  return `Next meet in ${daysUntil} days`;
}

/**
 * Today page: the countdown to the next league meet / ILT / scrimmage / competition (from getNextMeet), linking
 * to it and to the Team calendar. Renders nothing when no meet is coming up.
 */
export function NextMeetCard({ nextMeet, today }: { nextMeet: NextMeet | null; today: DateOnly }) {
  if (!nextMeet) return null;
  const { event } = nextMeet;
  const { daysUntil, happeningNow } = eventCountdown(event, today);
  const soon = happeningNow || daysUntil <= 1;
  return (
    <section
      aria-labelledby="next-meet-card-heading"
      className="flex flex-col gap-2 rounded-xl border border-brand-200 bg-brand-50 px-4 py-3 shadow-sm sm:flex-row sm:items-center sm:gap-3"
    >
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <CalendarDays className="mt-0.5 size-5 shrink-0 text-brand-600" aria-hidden />
        <div className="min-w-0">
          <h2 id="next-meet-card-heading" className={soon ? "text-sm font-bold text-brand-900" : "text-sm font-semibold text-brand-900"}>
            {nextMeetHeadline(daysUntil, happeningNow)}
          </h2>
          <p className="text-sm text-ink-700 wrap-anywhere">
            <Link href={`/calendar/${event.id}`} className="font-medium text-brand-800 underline underline-offset-2 hover:text-brand-900">
              {event.title}
            </Link>
            <span>
              {" · "}
              <WhenText text={formatEventWhen(event, today)} />
            </span>
            {event.location && <span> · {event.location}</span>}
          </p>
        </div>
      </div>
      <Link
        href="/calendar"
        className="-mx-2 inline-flex h-10 shrink-0 items-center gap-1 self-start rounded-lg px-2 text-sm font-medium text-brand-700 transition-colors hover:bg-brand-100 hover:text-brand-800 sm:mx-0 sm:self-center"
      >
        Team calendar
        <ChevronRight className="size-4" aria-hidden />
      </Link>
    </section>
  );
}
