import { CalendarDays, CalendarPlus, ChevronLeft, ChevronRight, History, Plus, SearchX } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { EventsByMonth } from "@/components/calendar/event-list";
import { KindChips } from "@/components/calendar/kind-chips";
import { CalendarLegend } from "@/components/calendar/kind-styles";
import { MonthGridView } from "@/components/calendar/month-grid";
import { NextMeetHero } from "@/components/calendar/next-meet-hero";
import { FocusAlert } from "@/components/sponsors/focus-alert";
import { Alert } from "@/components/ui/alert";
import { ButtonLink, buttonClasses } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { LinkTabs } from "@/components/ui/link-tabs";
import { PageHeader } from "@/components/ui/page-header";
import type { CalendarEventKind } from "@/generated/prisma/enums";
import {
  addMonths,
  buildMonthGrid,
  eventLastDay,
  formatMonth,
  type MonthKey,
  monthFirstDay,
  monthLastDay,
  monthOf,
  parseMonthKey,
  timeInTimezone,
} from "@/lib/calendar";
import { cn } from "@/lib/cn";
import { CALENDAR_EVENT_KINDS, LIMITS } from "@/lib/constants";
import { type DateOnly, todayInTimezone } from "@/lib/dates";
import { requireActiveUser } from "@/server/auth/session";
import { env } from "@/server/env";
import { canManageCalendar } from "@/server/permissions";
import {
  CALENDAR_PAST_LIMIT,
  countCalendarEvents,
  getCalendarEventsBetween,
  getNextMeet,
  getPastCalendarEvents,
  getUpcomingCalendarEvents,
  isIltOnCalendar,
} from "@/server/queries/calendar";

export const metadata: Metadata = { title: "Team calendar" };

type CalendarView = "month" | "list" | "past";

interface Filters {
  view: CalendarView;
  /** Only used by the month view (the others ignore it). */
  month: MonthKey;
  kind?: CalendarEventKind;
}

function first(v: string | string[] | undefined) {
  return Array.isArray(v) ? v[0] : v;
}

/** The URL for these filters. The month is left out when it's this month (the default). */
function hrefFor(f: Filters, thisMonth: MonthKey): string {
  const sp = new URLSearchParams();
  if (f.view !== "month") sp.set("view", f.view);
  if (f.view === "month" && f.month !== thisMonth) sp.set("month", f.month);
  if (f.kind) sp.set("kind", f.kind);
  const qs = sp.toString();
  return qs ? `/calendar?${qs}` : "/calendar";
}

const KIND_NOUNS: Record<CalendarEventKind, string> = {
  MEET: "league meets",
  ILT: "league tournaments",
  SCRIMMAGE: "league scrimmages",
  COMPETITION: "competitions",
  MEETING: "extra meetings",
  OUTREACH: "outreach events",
  TEAM: "team events",
  DEADLINE: "deadlines",
  OTHER: "“Other” events",
};

/** "league meets", "scrimmages"… for the empty states. */
function kindNoun(kind: CalendarEventKind | undefined): string {
  return kind ? KIND_NOUNS[kind] : "events";
}

/** Request time, read outside of render so relative labels line up between server and browser. */
function requestTime(): Date {
  return new Date();
}

/** The ILT filter's empty state while this season's ILT isn't on the calendar yet. */
const ILT_TBD = "The ILT date isn't on the calendar yet. Leaders add it as soon as it's announced.";

/** Every ACTIVE person sees the team's schedule; staff add, edit, and remove events. */
export default async function CalendarPage({ searchParams }: PageProps<"/calendar">) {
  const actor = await requireActiveUser();
  const sp = await searchParams;
  const now = requestTime();
  const today = todayInTimezone(env.teamTimezone, now);
  const thisMonth = monthOf(today);
  const rawView = first(sp.view);
  const filters: Filters = {
    view: rawView === "list" || rawView === "past" ? rawView : "month",
    month: parseMonthKey(first(sp.month)) ?? thisMonth,
    kind: CALENDAR_EVENT_KINDS.find((k) => k === first(sp.kind)),
  };
  const canManage = canManageCalendar(actor);
  const removed = first(sp.removed)?.slice(0, LIMITS.calendarTitleMax);
  const [nextMeet, total, iltOnCalendar] = await Promise.all([
    getNextMeet(today, timeInTimezone(env.teamTimezone, now)),
    countCalendarEvents(),
    isIltOnCalendar(today),
  ]);
  const iltTbd = !iltOnCalendar;
  const href = (f: Partial<Filters>) => hrefFor({ ...filters, ...f }, thisMonth);

  const addButton = (
    <ButtonLink href="/calendar/new">
      <Plus className="size-4" aria-hidden />
      Add an event
    </ButtonLink>
  );

  return (
    <>
      <PageHeader
        title="Team calendar"
        description="League scrimmages and meets, the ILT, and everything else on the team's schedule."
        actions={
          <>
            {canManage && addButton}
            {total > 0 && (
              <a
                href="/calendar/export.ics"
                download="huskyteers-calendar.ics"
                aria-describedby="ics-hint"
                className={buttonClasses("secondary")}
              >
                <CalendarPlus className="size-4" aria-hidden />
                Add to my calendar
              </a>
            )}
          </>
        }
      />

      <div className="max-w-5xl min-w-0 space-y-6">
        {removed && (
          <FocusAlert tone="success">
            Removed <span className="wrap-anywhere">{removed}</span> from the calendar.
          </FocusAlert>
        )}

        {total === 0 ? (
          <Card>
            <EmptyState
              icon={CalendarDays}
              title="No events yet"
              description={
                canManage
                  ? "Add the league meets, the ILT, scrimmages, and team events. Everyone on the team sees them here, with a countdown to the next meet."
                  : "When leaders add league meets, the ILT, and other team events, they show up here with a countdown to the next meet."
              }
              action={canManage ? addButton : undefined}
            />
          </Card>
        ) : (
          <>
            <NextMeetHero nextMeet={nextMeet} today={today} iltTbd={iltTbd} />

            <div className="space-y-3">
              <LinkTabs
                tabs={[
                  { href: href({ view: "month" }), label: "Month", active: filters.view === "month" },
                  { href: href({ view: "list" }), label: "List", active: filters.view === "list" },
                  { href: href({ view: "past" }), label: "Past", active: filters.view === "past" },
                ]}
              />
              <KindChips active={filters.kind} hrefFor={(kind) => href({ kind })} />
            </div>

            {filters.view === "month" && (
              <MonthView filters={filters} thisMonth={thisMonth} today={today} canManage={canManage} iltTbd={iltTbd} href={href} />
            )}
            {filters.view === "list" && <UpcomingView filters={filters} today={today} canManage={canManage} iltTbd={iltTbd} href={href} />}
            {filters.view === "past" && <PastView filters={filters} today={today} href={href} />}

            <p id="ics-hint" className="text-xs text-ink-500">
              &ldquo;Add to my calendar&rdquo; adds a copy of every event to your phone&apos;s calendar. Download it again after
              changes.
            </p>
          </>
        )}
      </div>
    </>
  );
}

type HrefFn = (f: Partial<Filters>) => string;

function ClearKind({ href }: { href: HrefFn }) {
  return (
    <ButtonLink href={href({ kind: undefined })} variant="secondary">
      Show all kinds
    </ButtonLink>
  );
}

async function MonthView({
  filters,
  thisMonth,
  today,
  canManage,
  iltTbd,
  href,
}: {
  filters: Filters;
  thisMonth: MonthKey;
  today: DateOnly;
  canManage: boolean;
  iltTbd: boolean;
  href: HrefFn;
}) {
  const grid = buildMonthGrid(filters.month);
  const events = await getCalendarEventsBetween({ from: grid.first, to: grid.last, kind: filters.kind });
  const prev = addMonths(filters.month, -1);
  const next = addMonths(filters.month, 1);
  const isThisMonth = filters.month === thisMonth;
  const navButton = "inline-flex size-10 items-center justify-center rounded-lg border border-ink-200 bg-white text-ink-700 shadow-sm transition-colors hover:bg-ink-50";
  const monthStart = monthFirstDay(filters.month);
  const monthEnd = monthLastDay(filters.month);
  const inMonth = events.some((e) => e.startsOn <= monthEnd && eventLastDay(e) >= monthStart);

  return (
    <section aria-labelledby="month-heading" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="month-heading" className="text-lg font-semibold text-ink-900">
          {formatMonth(filters.month)}
        </h2>
        <nav aria-label="Months" className="flex items-center gap-2">
          <Link href={href({ month: prev })} className={navButton} aria-label={`Previous month, ${formatMonth(prev)}`}>
            <ChevronLeft className="size-5" aria-hidden />
          </Link>
          <Link
            href={href({ month: thisMonth })}
            aria-current={isThisMonth ? "true" : undefined}
            className={cn(
              "inline-flex h-10 items-center rounded-lg border px-3 text-sm font-medium shadow-sm transition-colors",
              isThisMonth ? "border-brand-500 bg-brand-50 text-brand-800" : "border-ink-200 bg-white text-ink-700 hover:bg-ink-50",
            )}
          >
            This month
          </Link>
          <Link href={href({ month: next })} className={navButton} aria-label={`Next month, ${formatMonth(next)}`}>
            <ChevronRight className="size-5" aria-hidden />
          </Link>
        </nav>
      </div>

      {/* Above the grid, at every width, so an empty (filtered) month says why right away. */}
      {!inMonth && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-dashed border-ink-200 bg-white px-4 py-3">
          <p className="min-w-0 flex-1 basis-56 text-sm text-ink-600">
            No {kindNoun(filters.kind)} in {formatMonth(filters.month)}.
            {filters.kind === "ILT" && iltTbd && <> {ILT_TBD}</>}
          </p>
          {filters.kind && <ClearKind href={href} />}
        </div>
      )}

      {/* The list under the phone grid stays out when the month is empty: the line above says so. */}
      <MonthGridView grid={grid} events={events} today={today} canManage={canManage} emptyText={null} />
      <CalendarLegend className="pt-1" />
    </section>
  );
}

async function UpcomingView({
  filters,
  today,
  canManage,
  iltTbd,
  href,
}: {
  filters: Filters;
  today: DateOnly;
  canManage: boolean;
  iltTbd: boolean;
  href: HrefFn;
}) {
  const { items, truncated } = await getUpcomingCalendarEvents({ today, kind: filters.kind });
  return (
    <section aria-label="Coming up" className="max-w-3xl space-y-4">
      {items.length === 0 ? (
        <Card>
          <EmptyState
            icon={filters.kind ? SearchX : CalendarDays}
            title={filters.kind ? `No ${kindNoun(filters.kind)} coming up` : "Nothing coming up"}
            description={
              filters.kind === "ILT" && iltTbd
                ? ILT_TBD
                : canManage
                  ? "Add the next meet or team event and everyone will see it here."
                  : "New events show up here as soon as a leader adds them."
            }
            action={filters.kind ? <ClearKind href={href} /> : canManage ? <ButtonLink href="/calendar/new">Add an event</ButtonLink> : undefined}
          />
        </Card>
      ) : (
        <>
          <EventsByMonth events={items} today={today} />
          {truncated && <Alert>Showing the next {items.length} events.</Alert>}
        </>
      )}
    </section>
  );
}

async function PastView({ filters, today, href }: { filters: Filters; today: DateOnly; href: HrefFn }) {
  const { items, total } = await getPastCalendarEvents({ today, kind: filters.kind });
  return (
    <section aria-label="Past events" className="max-w-3xl space-y-4">
      {items.length === 0 ? (
        <Card>
          <EmptyState
            icon={filters.kind ? SearchX : History}
            title={filters.kind ? `No past ${kindNoun(filters.kind)}` : "Nothing in the past yet"}
            description="Events move here after their last day."
            action={filters.kind ? <ClearKind href={href} /> : undefined}
          />
        </Card>
      ) : (
        <>
          {total > items.length && <Alert>Showing the {CALENDAR_PAST_LIMIT} most recent events.</Alert>}
          <EventsByMonth events={items} today={today} />
        </>
      )}
    </section>
  );
}
