import { Plus } from "lucide-react";
import Link from "next/link";
import type { CSSProperties } from "react";
import { longDate } from "@/components/checklist/format";
import { Card } from "@/components/ui/card";
import {
  compareEvents,
  eventLastDay,
  formatEventWhen,
  formatMonth,
  formatMonthName,
  formatTimeShort,
  type MonthGrid,
  type MonthGridDay,
  monthFirstDay,
  monthLastDay,
  type PlacedEvent,
  placeEventsOnGrid,
} from "@/lib/calendar";
import { cn } from "@/lib/cn";
import { CALENDAR_EVENT_KIND_LABELS } from "@/lib/constants";
import { type DateOnly, formatDateOnly } from "@/lib/dates";
import type { CalendarEventItem } from "@/server/queries/calendar";
import { EventRow } from "./event-list";
import { CALENDAR_KIND_STYLES } from "./kind-styles";

const WEEKDAYS = [
  ["Sun", "S", "Sunday"],
  ["Mon", "M", "Monday"],
  ["Tue", "T", "Tuesday"],
  ["Wed", "W", "Wednesday"],
  ["Thu", "T", "Thursday"],
  ["Fri", "F", "Friday"],
  ["Sat", "S", "Saturday"],
] as const;

type Placed = PlacedEvent<CalendarEventItem>;

/** The list item a phone's day links to. */
const listItemId = (eventId: string) => `cal-event-${eventId}`;

/**
 * One month. From `lg` up: a grid with each event as a colored bar in its day cells (multi-day events span
 * them), linking to the event. On phones and tablets: a compact grid (day numbers with colored dots, days with
 * events link to them in the list) followed by the month's events as a list, so nothing scrolls sideways and
 * every tap target is big enough.
 */
export function MonthGridView({
  grid,
  events,
  today,
  canManage,
  emptyText = "Nothing on the calendar this month.",
}: {
  grid: MonthGrid;
  /** Every event overlapping the grid (leading and trailing days included). */
  events: CalendarEventItem[];
  today: DateOnly;
  /** Shows a "+" in each day to add an event that day. */
  canManage: boolean;
  /** What the list under the phone grid says when the month has no events; null when the page already says it. */
  emptyText?: string | null;
}) {
  const placed = placeEventsOnGrid(grid, events);
  const start = monthFirstDay(grid.month);
  const end = monthLastDay(grid.month);
  const monthEvents = events.filter((e) => e.startsOn <= end && eventLastDay(e) >= start).sort(compareEvents);
  const listed = new Set(monthEvents.map((e) => e.id));

  return (
    <>
      <Card className="overflow-hidden">
        <table className="hidden w-full table-fixed border-collapse lg:table">
          <caption className="sr-only">{formatMonth(grid.month)}</caption>
          <thead>
            <tr>
              {WEEKDAYS.map(([short, , long]) => (
                <th key={long} scope="col" className="py-2 text-center text-xs font-semibold uppercase tracking-wide text-ink-500">
                  <span aria-hidden>{short}</span>
                  <span className="sr-only">{long}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {grid.weeks.map((week) => (
              <tr key={week[0].date}>
                {week.map((day) => (
                  <DesktopDay key={day.date} day={day} lanes={placed.get(day.date) ?? []} today={today} canManage={canManage} />
                ))}
              </tr>
            ))}
          </tbody>
        </table>

        <table className="w-full table-fixed border-collapse lg:hidden">
          <caption className="sr-only">{formatMonth(grid.month)}</caption>
          <thead>
            <tr>
              {WEEKDAYS.map(([, letter, long]) => (
                <th key={long} scope="col" className="pt-2 pb-1 text-center text-xs font-semibold text-ink-500">
                  <span aria-hidden>{letter}</span>
                  <span className="sr-only">{long}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {grid.weeks.map((week) => (
              <tr key={week[0].date}>
                {week.map((day) => (
                  <PhoneDay key={day.date} day={day} lanes={placed.get(day.date) ?? []} today={today} listed={listed} />
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      {(monthEvents.length > 0 || emptyText) && (
        <section aria-labelledby="month-events-heading" className="space-y-2 lg:hidden">
          <h3 id="month-events-heading" className="text-sm font-semibold uppercase tracking-wide text-ink-500">
            Events in {formatMonthName(grid.month)}
          </h3>
          {monthEvents.length > 0 ? (
            <ul className="space-y-2">
              {monthEvents.map((e) => (
                <EventRow key={e.id} id={listItemId(e.id)} event={e} today={today} />
              ))}
            </ul>
          ) : (
            <p className="text-sm text-ink-500">{emptyText}</p>
          )}
        </section>
      )}
    </>
  );
}

function DayNumber({ day, isToday, className }: { day: MonthGridDay; isToday: boolean; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold tabular-nums",
        isToday ? "bg-brand-600 text-white" : day.inMonth ? "text-ink-900" : "text-ink-500",
        className,
      )}
    >
      <span aria-hidden>{day.day}</span>
      <span className="sr-only">{`${isToday ? "Today, " : ""}${longDate(day.date)}`}</span>
    </span>
  );
}

function DesktopDay({
  day,
  lanes,
  today,
  canManage,
}: {
  day: MonthGridDay;
  lanes: (Placed | null)[];
  today: DateOnly;
  canManage: boolean;
}) {
  const isToday = day.date === today;
  return (
    <td
      aria-current={isToday ? "date" : undefined}
      className={cn(
        "h-28 border-t border-l border-ink-100 p-1 align-top first:border-l-0",
        isToday ? "bg-brand-50/60" : day.inMonth ? "bg-white" : "bg-ink-50",
      )}
    >
      <div className="flex items-start justify-between gap-1">
        <DayNumber day={day} isToday={isToday} className="mt-0.5" />
        {canManage && (
          // A mouse shortcut: keyboard and screen reader users have the page's "Add an event" (one stop, not 35).
          <Link
            href={`/calendar/new?date=${day.date}`}
            tabIndex={-1}
            aria-hidden
            title={`Add an event on ${formatDateOnly(day.date, today)}`}
            className="-mt-1 -mr-1 inline-flex size-10 items-center justify-center rounded-md text-ink-400 transition-colors hover:bg-brand-50 hover:text-brand-700"
          >
            <Plus className="size-4" aria-hidden />
          </Link>
        )}
      </div>
      {lanes.length > 0 && (
        <div className="mt-1 space-y-1">
          {lanes.map((p, i) =>
            p && p.segmentStart ? <EventBar key={p.event.id} placed={p} today={today} /> : <div key={`free-${i}`} className="h-10" aria-hidden />,
          )}
        </div>
      )}
    </td>
  );
}

/**
 * An event's bar for this week: drawn from its first day in the week across the days it covers (the cells after
 * it keep that lane free), squared off where it continues from or into another week. Two lines tall (a 40px tap
 * target), so "League Scrimmage 1" keeps its number in a narrow cell. The link's name is the title, then the
 * kind and when.
 */
function EventBar({ placed, today }: { placed: Placed; today: DateOnly }) {
  const { event, segmentDays, startsHere, endsHere } = placed;
  // Each extra cell adds its width plus its padding (2 × 4px) and border (1px); a continuing end reaches the cell's edge.
  const extra = (segmentDays - 1) * 9 + (startsHere ? 0 : 4) + (endsHere ? 0 : 4);
  const style: CSSProperties = { width: `calc(${segmentDays * 100}% + ${extra}px)` };
  return (
    <Link
      href={`/calendar/${event.id}`}
      title={`${event.title} · ${formatEventWhen(event, today)}`}
      style={style}
      className={cn(
        "relative z-10 flex h-10 items-center overflow-hidden px-1.5 py-1 text-xs leading-4 font-medium transition-colors",
        CALENDAR_KIND_STYLES[event.kind].chip,
        startsHere ? "rounded-l-md" : "-ml-1 rounded-l-none",
        endsHere ? "rounded-r-md" : "rounded-r-none",
      )}
    >
      <span className="line-clamp-2 min-w-0 break-words">
        {startsHere && event.startTime && (
          <span aria-hidden className="font-normal opacity-80">
            {formatTimeShort(event.startTime)}{" "}
          </span>
        )}
        {event.title}
      </span>
      <span className="sr-only">{`, ${CALENDAR_EVENT_KIND_LABELS[event.kind]}, ${formatEventWhen(event, today)}`}</span>
    </Link>
  );
}

function PhoneDay({
  day,
  lanes,
  today,
  listed,
}: {
  day: MonthGridDay;
  lanes: (Placed | null)[];
  today: DateOnly;
  /** Events in the list under the grid (a day links to its first one). */
  listed: Set<string>;
}) {
  const isToday = day.date === today;
  const events = lanes.filter((p): p is Placed => p !== null).map((p) => p.event);
  const target = events.find((e) => listed.has(e.id));
  const dots = (
    <span className="flex h-2 items-center justify-center gap-0.5" aria-hidden>
      {events.slice(0, 3).map((e) => (
        <span key={e.id} className={cn("size-1.5 rounded-full", CALENDAR_KIND_STYLES[e.kind].dot)} />
      ))}
      {events.length > 3 && <span className="text-[9px] font-bold leading-none text-ink-500">+</span>}
    </span>
  );
  // Days outside the month are told apart by their gray number (DayNumber); their dots keep full color.
  const cellClass = "flex h-12 flex-col items-center justify-center gap-0.5 rounded-lg";
  return (
    <td aria-current={isToday ? "date" : undefined} className="p-0.5 text-center align-top">
      {target ? (
        <a
          href={`#${listItemId(target.id)}`}
          aria-label={`${isToday ? "Today, " : ""}${longDate(day.date)}: ${events.length === 1 ? "1 event" : `${events.length} events`}`}
          className={cn(cellClass, "transition-colors hover:bg-ink-50 active:bg-ink-100")}
        >
          <DayNumber day={day} isToday={isToday} />
          {dots}
        </a>
      ) : (
        <div className={cellClass}>
          <DayNumber day={day} isToday={isToday} />
          {dots}
        </div>
      )}
    </td>
  );
}
