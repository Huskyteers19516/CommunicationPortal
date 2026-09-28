import { MapPin } from "lucide-react";
import Link from "next/link";
import { cn } from "@/lib/cn";
import { eventCountdown, formatEventWhen, formatMonth, type MonthKey, monthOf } from "@/lib/calendar";
import { type DateOnly, dateOnlyToDb } from "@/lib/dates";
import type { CalendarEventItem } from "@/server/queries/calendar";
import { CALENDAR_KIND_STYLES, CalendarKindBadge } from "./kind-styles";
import { WhenText } from "./when-text";

const blockFormat = {
  weekday: new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short" }),
  month: new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short" }),
};

/** The day as a small calendar block ("SAT / 17 / OCT"), tinted with the kind's color. Decorative. */
function DateBlock({ date, kind, muted }: { date: DateOnly; kind: CalendarEventItem["kind"]; muted?: boolean }) {
  const d = dateOnlyToDb(date);
  return (
    <span
      aria-hidden
      className={cn(
        "flex w-12 shrink-0 flex-col items-center justify-center rounded-lg py-1.5 leading-none",
        muted ? "bg-ink-100 text-ink-600" : CALENDAR_KIND_STYLES[kind].block,
      )}
    >
      <span className="text-[11px] font-semibold uppercase tracking-wide">{blockFormat.weekday.format(d)}</span>
      <span className="font-display text-xl font-semibold tabular-nums">{d.getUTCDate()}</span>
      <span className="text-[11px] font-semibold uppercase tracking-wide">{blockFormat.month.format(d)}</span>
    </span>
  );
}

/** One event as a row that links to its page: day block, title, when, where, kind, and a countdown. */
export function EventRow({ event, today, id }: { event: CalendarEventItem; today: DateOnly; id?: string }) {
  const countdown = eventCountdown(event, today);
  return (
    <li id={id} className="scroll-mt-24">
      <Link
        href={`/calendar/${event.id}`}
        className="flex min-h-16 gap-3 rounded-xl border border-ink-200 bg-white p-3 shadow-sm transition-colors hover:border-brand-300 hover:bg-brand-50/40"
      >
        <DateBlock date={event.startsOn} kind={event.kind} muted={countdown.past} />
        <span className="min-w-0 flex-1 space-y-1">
          <span className="block font-semibold text-ink-900 wrap-anywhere">{event.title}</span>
          <span className="block text-sm text-ink-700">
            <WhenText text={formatEventWhen(event, today)} />
          </span>
          {event.location && (
            <span className="flex items-start gap-1 text-sm text-ink-500">
              <MapPin className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              <span className="sr-only">Where: </span>
              <span className="min-w-0 truncate">{event.location}</span>
            </span>
          )}
          <span className="flex flex-wrap items-center gap-1.5 pt-0.5">
            <CalendarKindBadge kind={event.kind} />
            <span
              className={cn(
                "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset",
                countdown.happeningNow || countdown.daysUntil === 0
                  ? "bg-brand-600 text-white ring-brand-600"
                  : countdown.past
                    ? "bg-ink-50 text-ink-600 ring-ink-200"
                    : "bg-white text-ink-700 ring-ink-200",
              )}
            >
              {countdown.label}
            </span>
          </span>
        </span>
      </Link>
    </li>
  );
}

/** Events grouped under month headings ("October 2026"), in the order given. */
export function EventsByMonth({
  events,
  today,
  headingLevel = "h2",
}: {
  events: CalendarEventItem[];
  today: DateOnly;
  headingLevel?: "h2" | "h3";
}) {
  const groups: { month: MonthKey; items: CalendarEventItem[] }[] = [];
  for (const e of events) {
    const month = monthOf(e.startsOn);
    const last = groups.at(-1);
    if (last && last.month === month) last.items.push(e);
    else groups.push({ month, items: [e] });
  }
  const Heading = headingLevel;
  return (
    <div className="space-y-6">
      {groups.map((g) => (
        <section key={g.month} aria-labelledby={`month-${g.month}`} className="space-y-2">
          <Heading id={`month-${g.month}`} className="text-sm font-semibold uppercase tracking-wide text-ink-500">
            {formatMonth(g.month)}
          </Heading>
          <ul className="space-y-2">
            {g.items.map((e) => (
              <EventRow key={e.id} event={e} today={today} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
