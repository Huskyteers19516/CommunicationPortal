import { CalendarDays, Clock, MapPin, Trophy } from "lucide-react";
import Link from "next/link";
import { Card } from "@/components/ui/card";
import { eventCountdown, formatEventDates, formatEventTimes, formatEventWhen, multiDayTimedEnds } from "@/lib/calendar";
import type { DateOnly } from "@/lib/dates";
import type { NextMeet } from "@/server/queries/calendar";
import { CalendarKindBadge } from "./kind-styles";
import { WhenText } from "./when-text";

/** The big countdown: "12" + "days", or "Today" / "Tomorrow" / "Happening now". */
function Countdown({ daysUntil, happeningNow }: { daysUntil: number; happeningNow: boolean }) {
  if (happeningNow || daysUntil <= 1) {
    const word = happeningNow ? "Happening now" : daysUntil === 0 ? "Today" : "Tomorrow";
    return <p className="font-display text-3xl font-semibold uppercase leading-tight tracking-wide break-words">{word}</p>;
  }
  return (
    <p className="flex items-baseline gap-2 sm:flex-col sm:items-center sm:gap-0">
      <span className="font-display text-5xl font-semibold leading-none tabular-nums sm:text-6xl">{daysUntil}</span>{" "}
      <span className="text-base font-medium text-white">days</span>
    </p>
  );
}

/**
 * Top of the Team calendar: how long until the next meet, and what's after it. Nothing when none is coming up.
 * `iltTbd`: this season's ILT isn't on the calendar yet, so say its date is still to be announced.
 */
export function NextMeetHero({ nextMeet, today, iltTbd = false }: { nextMeet: NextMeet | null; today: DateOnly; iltTbd?: boolean }) {
  if (!nextMeet) return null;
  const { event, following } = nextMeet;
  const countdown = eventCountdown(event, today);
  const ends = multiDayTimedEnds(event, today);
  return (
    <section aria-labelledby="next-meet-heading">
      <Card className="overflow-hidden">
        <div className="flex flex-col sm:flex-row">
          <div className="flex flex-col justify-center gap-1 bg-brand-600 px-5 py-4 text-white sm:w-52 sm:shrink-0 sm:items-center sm:py-6 sm:text-center">
            <h2 id="next-meet-heading" className="text-xs font-semibold uppercase tracking-wider text-white">
              Next meet
            </h2>
            <Countdown daysUntil={countdown.daysUntil} happeningNow={countdown.happeningNow} />
          </div>
          <div className="min-w-0 flex-1 space-y-2 px-4 py-4 sm:px-5">
            <CalendarKindBadge kind={event.kind} />
            <p className="text-lg font-semibold text-ink-900 wrap-anywhere">
              <Link href={`/calendar/${event.id}`} className="rounded hover:text-brand-700 hover:underline hover:underline-offset-2">
                {event.title}
              </Link>
            </p>
            <dl className="space-y-1 text-sm text-ink-700">
              {ends ? (
                // A multi-day event's times are its first day's start and last day's end, not daily hours.
                <>
                  <div className="flex items-start gap-2">
                    <dt>
                      <CalendarDays className="mt-0.5 size-4 shrink-0 text-ink-500" aria-hidden />
                      <span className="sr-only">Starts</span>
                    </dt>
                    <dd className="min-w-0">
                      <span aria-hidden className="text-ink-500">Starts </span>
                      <WhenText text={ends.starts} />
                    </dd>
                  </div>
                  <div className="flex items-start gap-2">
                    <dt>
                      <Clock className="mt-0.5 size-4 shrink-0 text-ink-500" aria-hidden />
                      <span className="sr-only">Ends</span>
                    </dt>
                    <dd className="min-w-0">
                      <span aria-hidden className="text-ink-500">Ends </span>
                      <WhenText text={ends.ends} />
                    </dd>
                  </div>
                </>
              ) : (
                <>
                  <div className="flex items-start gap-2">
                    <dt>
                      <CalendarDays className="mt-0.5 size-4 shrink-0 text-ink-500" aria-hidden />
                      <span className="sr-only">Date</span>
                    </dt>
                    <dd className="min-w-0">{formatEventDates(event, today)}</dd>
                  </div>
                  <div className="flex items-start gap-2">
                    <dt>
                      <Clock className="mt-0.5 size-4 shrink-0 text-ink-500" aria-hidden />
                      <span className="sr-only">Time</span>
                    </dt>
                    <dd className="min-w-0">
                      <WhenText text={formatEventTimes(event)} />
                    </dd>
                  </div>
                </>
              )}
              {event.location && (
                <div className="flex items-start gap-2">
                  <dt>
                    <MapPin className="mt-0.5 size-4 shrink-0 text-ink-500" aria-hidden />
                    <span className="sr-only">Where</span>
                  </dt>
                  <dd className="min-w-0 wrap-anywhere">{event.location}</dd>
                </div>
              )}
            </dl>
            {(following.length > 0 || iltTbd) && (
              <div className="space-y-1 border-t border-ink-100 pt-2 text-sm text-ink-600">
                {following.length > 0 && (
                  <>
                    <h3 className="sr-only">After that</h3>
                    <ul className="space-y-0.5">
                      {following.map((f) => (
                        <li key={f.id} className="wrap-anywhere">
                          <span className="text-ink-500">Then </span>
                          <Link href={`/calendar/${f.id}`} className="font-medium text-brand-700 underline-offset-2 hover:underline">
                            {f.title}
                          </Link>
                          <span className="text-ink-500">
                            {" · "}
                            <WhenText text={formatEventWhen(f, today)} />
                          </span>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                {iltTbd && (
                  <p className="flex items-start gap-1.5">
                    <Trophy className="mt-0.5 size-4 shrink-0 text-violet-600" aria-hidden />
                    <span className="min-w-0">
                      <span className="font-medium text-ink-800">Qualifying Tournament (ILT):</span> date TBD
                    </span>
                  </p>
                )}
              </div>
            )}
          </div>
        </div>
      </Card>
    </section>
  );
}
