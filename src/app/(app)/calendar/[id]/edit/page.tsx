import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CalendarEventForm } from "@/components/calendar/calendar-event-form";
import { BackLink } from "@/components/tasks/back-link";
import { PageHeader } from "@/components/ui/page-header";
import { calendarDateBounds } from "@/lib/calendar";
import { todayInTimezone } from "@/lib/dates";
import { requireActiveUser } from "@/server/auth/session";
import { env } from "@/server/env";
import { getCalendarEvent } from "@/server/queries/calendar";
import { updateCalendarEventAction } from "../../actions";

export const metadata: Metadata = { title: "Edit event" };

/** The earliest / latest of some dates ("YYYY-MM-DD" sorts as text). */
function earliest(...dates: (string | null)[]): string {
  return dates.filter((d): d is string => !!d).sort()[0];
}
function latest(...dates: (string | null)[]): string {
  return dates.filter((d): d is string => !!d).sort().at(-1)!;
}

/** Staff only (everyone else, and unknown events, get a 404). */
export default async function EditCalendarEventPage({ params }: PageProps<"/calendar/[id]/edit">) {
  const actor = await requireActiveUser();
  const { id } = await params;
  const event = await getCalendarEvent(actor, id);
  if (!event || !event.canManage) notFound();

  // The days it has now stay pickable even when they're outside the usual range.
  const bounds = calendarDateBounds(todayInTimezone(env.teamTimezone));
  const back = `/calendar/${event.id}`;
  return (
    <div className="mx-auto w-full max-w-3xl min-w-0">
      <BackLink href={back}>Back to the event</BackLink>
      <PageHeader title="Edit event" description={<span className="wrap-anywhere">{event.title}</span>} />
      <CalendarEventForm
        action={updateCalendarEventAction}
        submitLabel="Save changes"
        cancelHref={back}
        minDate={earliest(bounds.min, event.startsOn, event.endsOn)}
        maxDate={latest(bounds.max, event.startsOn, event.endsOn)}
        initial={{
          id: event.id,
          version: event.version,
          title: event.title,
          kind: event.kind,
          startsOn: event.startsOn,
          endsOn: event.endsOn ?? "",
          startTime: event.startTime ?? "",
          endTime: event.endTime ?? "",
          location: event.location,
          link: event.link,
          notes: event.notes,
        }}
      />
    </div>
  );
}
