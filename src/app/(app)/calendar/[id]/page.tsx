import { CalendarDays, CalendarPlus, Clock, ExternalLink, Map as MapIcon, MapPin, Pencil, Trash2 } from "lucide-react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";
import { CalendarKindBadge } from "@/components/calendar/kind-styles";
import { WhenText } from "@/components/calendar/when-text";
import { FocusAlert } from "@/components/sponsors/focus-alert";
import { ActionForm } from "@/components/tasks/action-form";
import { BackLink } from "@/components/tasks/back-link";
import { ButtonLink, buttonClasses } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { RichText } from "@/components/ui/rich-text";
import { eventCountdown, formatEventDates, formatEventTimes, icsFilename, monthOf, multiDayTimedEnds } from "@/lib/calendar";
import { cn } from "@/lib/cn";
import { timeAgo, todayInTimezone } from "@/lib/dates";
import { requireActiveUser } from "@/server/auth/session";
import { env } from "@/server/env";
import { type CalendarPerson, getCalendarEvent } from "@/server/queries/calendar";
import { deleteCalendarEventAction } from "../actions";

// Shared by generateMetadata and the page so the event loads once per request.
const loadEvent = cache(async (id: string) => {
  const actor = await requireActiveUser();
  return { actor, event: await getCalendarEvent(actor, id) };
});

export async function generateMetadata({ params }: PageProps<"/calendar/[id]">): Promise<Metadata> {
  const { id } = await params;
  const { event } = await loadEvent(id);
  return { title: event?.title ?? "Event" };
}

function first(v: string | string[] | undefined) {
  return Array.isArray(v) ? v[0] : v;
}

/** Request time, read outside of render so relative labels line up between server and browser. */
function requestTime(): Date {
  return new Date();
}

/** Google Maps search for a venue name or address (opens the Maps app on phones). */
function mapsUrl(location: string): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(location)}`;
}

/** Every ACTIVE person sees an event; staff also get Edit and Remove. */
export default async function CalendarEventPage({ params, searchParams }: PageProps<"/calendar/[id]">) {
  const { id } = await params;
  const { actor, event } = await loadEvent(id);
  const sp = await searchParams;
  const now = requestTime();
  const timeZone = env.teamTimezone;
  const today = todayInTimezone(timeZone, now);
  if (!event) notFound();

  const flash = first(sp.added) === "1" ? "Added. The whole team can see it now." : first(sp.saved) === "1" ? "Changes saved." : null;
  const countdown = eventCountdown(event, today);
  const ends = multiDayTimedEnds(event, today);
  const who = (p: CalendarPerson) => (p.id === actor.id ? "you" : p.name);
  const edited = event.updatedBy && event.updatedAt !== event.createdAt;

  return (
    <div className="mx-auto w-full max-w-3xl min-w-0">
      <BackLink href={`/calendar?month=${monthOf(event.startsOn)}`}>Team calendar</BackLink>
      {flash && (
        <div className="mb-4">
          <FocusAlert tone="success">{flash}</FocusAlert>
        </div>
      )}
      <PageHeader
        title={<span className="wrap-anywhere">{event.title}</span>}
        actions={
          event.canManage && (
            <>
              <ButtonLink href={`/calendar/${event.id}/edit`} variant="secondary">
                <Pencil className="size-4" aria-hidden />
                Edit
              </ButtonLink>
              <ActionForm
                action={deleteCalendarEventAction}
                fields={{ eventId: event.id }}
                variant="secondary"
                confirm={`Remove “${event.title}” from the team calendar?`}
                pendingText="Removing…"
                aria-label={`Remove ${event.title}`}
              >
                <Trash2 className="size-4 text-red-600" aria-hidden />
                Remove
              </ActionForm>
            </>
          )
        }
      />

      <div className="-mt-3 mb-6 flex flex-wrap gap-1.5">
        <CalendarKindBadge kind={event.kind} />
        <span
          className={cn(
            "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset",
            countdown.happeningNow || countdown.daysUntil === 0
              ? "bg-brand-600 text-white ring-brand-600"
              : countdown.past
                ? "bg-ink-100 text-ink-700 ring-ink-200"
                : "bg-white text-ink-700 ring-ink-200",
          )}
        >
          {countdown.label}
        </span>
      </div>

      <Card>
        <CardBody className="space-y-5">
          <dl className="space-y-3 text-sm">
            {ends ? (
              // A multi-day event's times are its first day's start and last day's end, not daily hours.
              <>
                <div className="flex items-start gap-2.5">
                  <dt className="shrink-0 text-ink-500">
                    <CalendarDays className="size-5" aria-hidden />
                    <span className="sr-only">Starts</span>
                  </dt>
                  <dd className="min-w-0 pt-px font-medium text-ink-900">
                    <span aria-hidden className="font-normal text-ink-500">Starts </span>
                    <WhenText text={ends.starts} />
                  </dd>
                </div>
                <div className="flex items-start gap-2.5">
                  <dt className="shrink-0 text-ink-500">
                    <Clock className="size-5" aria-hidden />
                    <span className="sr-only">Ends</span>
                  </dt>
                  <dd className="min-w-0 pt-px font-medium text-ink-900">
                    <span aria-hidden className="font-normal text-ink-500">Ends </span>
                    <WhenText text={ends.ends} />
                  </dd>
                </div>
              </>
            ) : (
              <>
                <div className="flex items-start gap-2.5">
                  <dt className="shrink-0 text-ink-500">
                    <CalendarDays className="size-5" aria-hidden />
                    <span className="sr-only">Date</span>
                  </dt>
                  <dd className="min-w-0 pt-px font-medium text-ink-900">{formatEventDates(event, today)}</dd>
                </div>
                <div className="flex items-start gap-2.5">
                  <dt className="shrink-0 text-ink-500">
                    <Clock className="size-5" aria-hidden />
                    <span className="sr-only">Time</span>
                  </dt>
                  <dd className="min-w-0 pt-px text-ink-800">
                    <WhenText text={formatEventTimes(event)} />
                  </dd>
                </div>
              </>
            )}
            <div className="flex items-start gap-2.5">
              <dt className="shrink-0 text-ink-500">
                <MapPin className="size-5" aria-hidden />
                <span className="sr-only">Where</span>
              </dt>
              <dd className="min-w-0 pt-px text-ink-800 wrap-anywhere">{event.location || <span className="text-ink-500">No location yet</span>}</dd>
            </div>
          </dl>

          <div className="space-y-1.5">
            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
              <a
                href={`/calendar/${event.id}/event.ics`}
                download={icsFilename(event.title)}
                aria-describedby="ics-hint"
                className={buttonClasses("primary")}
              >
                <CalendarPlus className="size-4 shrink-0" aria-hidden />
                Add to my calendar
              </a>
              {event.location && (
                <a href={mapsUrl(event.location)} target="_blank" rel="noopener noreferrer" className={buttonClasses("secondary")}>
                  <MapIcon className="size-4 shrink-0" aria-hidden />
                  Open in Maps
                  <span className="sr-only"> (opens in a new tab)</span>
                </a>
              )}
              {event.link && (
                <a href={event.link} target="_blank" rel="noopener noreferrer nofollow" className={buttonClasses("secondary")}>
                  <ExternalLink className="size-4 shrink-0" aria-hidden />
                  Open link
                  <span className="sr-only"> for {event.title} (opens in a new tab)</span>
                </a>
              )}
            </div>
            <p id="ics-hint" className="text-xs text-ink-500">
              Adds a copy to your phone&apos;s calendar. Download it again after changes.
            </p>
          </div>

          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold text-ink-900">Notes</h2>
            {event.notes ? (
              <RichText text={event.notes} className="text-sm text-ink-800 wrap-anywhere" />
            ) : (
              <p className="text-sm text-ink-500">No notes.</p>
            )}
          </div>

          <p className="border-t border-ink-100 pt-3 text-xs text-ink-500 wrap-anywhere">
            Added {timeAgo(new Date(event.createdAt), now, timeZone)}
            {event.createdBy && <> by {who(event.createdBy)}</>}
            {edited && event.updatedBy && (
              <>
                {" · "}edited {timeAgo(new Date(event.updatedAt), now, timeZone)} by {who(event.updatedBy)}
              </>
            )}
          </p>
        </CardBody>
      </Card>
    </div>
  );
}
