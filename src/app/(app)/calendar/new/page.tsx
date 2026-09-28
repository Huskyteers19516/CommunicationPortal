import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CalendarEventForm } from "@/components/calendar/calendar-event-form";
import { BackLink } from "@/components/tasks/back-link";
import { PageHeader } from "@/components/ui/page-header";
import { CALENDAR_RETURNS, calendarDateBounds, monthOf, parseCalendarReturn, parseDateParam } from "@/lib/calendar";
import { CALENDAR_EVENT_KINDS } from "@/lib/constants";
import { todayInTimezone } from "@/lib/dates";
import { requireActiveUser } from "@/server/auth/session";
import { env } from "@/server/env";
import { canManageCalendar } from "@/server/permissions";
import { createCalendarEventAction } from "../actions";

export const metadata: Metadata = { title: "Add an event" };

function first(v: string | string[] | undefined) {
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Staff only (everyone else gets a 404). `?date=YYYY-MM-DD` fills in the date (the month grid's "+"), and `?kind=`
 * picks the kind (Attendance's "Add an extra meeting" opens it with `?kind=MEETING&from=plan|schedule`, and Back /
 * Cancel and the new event lead back there); anything else is ignored. The heading stays "Add an event" whatever
 * kind is picked; the form explains an Extra meeting while it's the one picked.
 */
export default async function NewCalendarEventPage({ searchParams }: PageProps<"/calendar/new">) {
  const actor = await requireActiveUser();
  if (!canManageCalendar(actor)) notFound();
  const sp = await searchParams;
  const bounds = calendarDateBounds(todayInTimezone(env.teamTimezone));
  const picked = parseDateParam(first(sp.date));
  const date = picked && picked >= bounds.min && picked <= bounds.max ? picked : "";
  const kind = CALENDAR_EVENT_KINDS.find((k) => k === first(sp.kind)) ?? "MEET";
  const from = parseCalendarReturn(first(sp.from));
  const back = from ? CALENDAR_RETURNS[from] : { href: date ? `/calendar?month=${monthOf(date)}` : "/calendar", label: "Team calendar" };

  return (
    <div className="mx-auto w-full max-w-3xl min-w-0">
      <BackLink href={back.href}>{back.label}</BackLink>
      <PageHeader title="Add an event" description="Everyone on the team sees it on the calendar." />
      <CalendarEventForm
        action={createCalendarEventAction}
        submitLabel="Add event"
        cancelHref={back.href}
        from={from}
        minDate={bounds.min}
        maxDate={bounds.max}
        initial={{
          title: "",
          kind,
          startsOn: date,
          endsOn: "",
          startTime: "",
          endTime: "",
          location: "",
          link: "",
          notes: "",
        }}
      />
    </div>
  );
}
