import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CalendarEventForm } from "@/components/calendar/calendar-event-form";
import { BackLink } from "@/components/tasks/back-link";
import { PageHeader } from "@/components/ui/page-header";
import { calendarDateBounds, monthOf, parseDateParam } from "@/lib/calendar";
import { todayInTimezone } from "@/lib/dates";
import { requireActiveUser } from "@/server/auth/session";
import { env } from "@/server/env";
import { canManageCalendar } from "@/server/permissions";
import { createCalendarEventAction } from "../actions";

export const metadata: Metadata = { title: "Add an event" };

function first(v: string | string[] | undefined) {
  return Array.isArray(v) ? v[0] : v;
}

/** Staff only (everyone else gets a 404). `?date=YYYY-MM-DD` fills in the date (the month grid's "+"). */
export default async function NewCalendarEventPage({ searchParams }: PageProps<"/calendar/new">) {
  const actor = await requireActiveUser();
  if (!canManageCalendar(actor)) notFound();
  const sp = await searchParams;
  const bounds = calendarDateBounds(todayInTimezone(env.teamTimezone));
  const picked = parseDateParam(first(sp.date));
  const date = picked && picked >= bounds.min && picked <= bounds.max ? picked : "";
  const back = date ? `/calendar?month=${monthOf(date)}` : "/calendar";

  return (
    <div className="mx-auto w-full max-w-3xl min-w-0">
      <BackLink href={back}>Team calendar</BackLink>
      <PageHeader title="Add an event" description="Everyone on the team sees it on the calendar." />
      <CalendarEventForm
        action={createCalendarEventAction}
        submitLabel="Add event"
        cancelHref={back}
        minDate={bounds.min}
        maxDate={bounds.max}
        initial={{
          title: "",
          kind: "MEET",
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
