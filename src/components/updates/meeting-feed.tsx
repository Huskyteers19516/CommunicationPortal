import { PenLine, Pencil, Trash2, TriangleAlert } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { deleteMeetingUpdateAction } from "@/app/(app)/updates/actions";
import { SubteamBadge } from "@/components/app/badges";
import { describeRole } from "@/components/app/user-chip";
import { ActionForm } from "@/components/tasks/action-form";
import { Alert } from "@/components/ui/alert";
import { Avatar } from "@/components/ui/avatar";
import { ButtonLink } from "@/components/ui/button";
import { RichText } from "@/components/ui/rich-text";
import type { Subteam } from "@/generated/prisma/enums";
import { cn } from "@/lib/cn";
import { SUBTEAM_LABELS, SUBTEAMS } from "@/lib/constants";
import { type DateOnly, daysBetween, formatDateOnly, formatDateTime, timeAgo, todayInTimezone } from "@/lib/dates";
import { meetingDateProblem, meetingUpdateAnchor, newMeetingUpdateHref, subteamList } from "@/lib/meeting-updates";
import type { MeetingDay, MeetingUpdateItem } from "@/server/queries/meeting-updates";

/** A colored top edge per subteam, matching the subteam badges. */
const SUBTEAM_ACCENT: Record<Subteam, string> = {
  SOFTWARE: "border-t-sky-400",
  BUILD: "border-t-amber-400",
  BUSINESS: "border-t-violet-400",
};

export interface FeedContext {
  today: DateOnly;
  /** Request time and team timezone (relative labels line up with the rest of the page). */
  now: Date;
  timeZone: string;
  /** Subteams the viewer can write for ("Write one" links). */
  writable: Subteam[];
  /** The query string of the feed as shown (kept after removing an update). */
  back: string;
  /** The update the feed opened at (just posted or saved, or `?focus=`), and what to say about it (if anything). */
  highlight: { id: string; message: string | null } | null;
}

/** "Today" / "Yesterday" / "3 days ago" for the last week, else nothing (the date says it). */
function relativeDay(date: DateOnly, today: DateOnly): string | null {
  const ago = daysBetween(date, today);
  if (ago === 0) return "Today";
  if (ago === 1) return "Yesterday";
  if (ago > 1 && ago < 7) return `${ago} days ago`;
  return null;
}

/** "3:05 PM" when it was written on the meeting day, else "Oct 7, 9:00 AM". */
function writtenAt(item: MeetingUpdateItem, timeZone: string): string {
  if (todayInTimezone(timeZone, item.createdAt) === item.meetingDate) {
    return new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(item.createdAt);
  }
  return formatDateTime(item.createdAt, timeZone);
}

function authorName(item: MeetingUpdateItem): string {
  return item.author?.name ?? "a former member";
}

/** The "Write one" link's classes (a 40 px tap target that lines up with the text beside it). */
const writeLinkClasses =
  "-ml-2 inline-flex h-10 items-center gap-1.5 rounded-lg px-2 font-medium text-brand-700 transition-colors hover:bg-brand-50 hover:text-brand-800";

/** Whether the viewer can write `subteam`'s update for `date` (their subteam, and a date a new update may use). */
function canWriteFor(ctx: FeedContext, date: DateOnly, subteam: Subteam): boolean {
  return ctx.writable.includes(subteam) && meetingDateProblem(date, ctx.today) === null;
}

/**
 * One meeting day: its date, then each subteam's updates — three columns side by side when the feed is wide
 * enough (a container query, so it also counts the sidebar), stacked below that. Stacked, the subteams nobody
 * wrote for share one short "No … update yet" line instead of a card each. `filtered`: only the subteams with
 * updates are shown (a subteam or "Mine" filter), without "No update yet" placeholders.
 */
export function MeetingDaySection({ day, ctx, filtered }: { day: MeetingDay; ctx: FeedContext; filtered: boolean }) {
  const headingId = `day-${day.date}`;
  const relative = relativeDay(day.date, ctx.today);
  const subteams = filtered ? SUBTEAMS.filter((s) => day.bySubteam[s].length > 0) : SUBTEAMS;
  const empty = filtered ? [] : SUBTEAMS.filter((s) => day.bySubteam[s].length === 0);
  return (
    <section aria-labelledby={headingId} className="@container scroll-mt-24 space-y-3">
      <h2 id={headingId} className="flex flex-wrap items-baseline gap-x-2 text-lg font-semibold text-ink-900">
        <span>{formatDateOnly(day.date, ctx.today)}</span>
        {/* The space keeps the heading's name "Sun, Sep 27 Today" (flex ignores it in the layout). */}
        {relative && " "}
        {relative && <span className="text-sm font-medium text-brand-700">{relative}</span>}
      </h2>
      <div className={cn("grid gap-3", filtered ? "max-w-3xl" : "@4xl:grid-cols-3")}>
        {subteams.map((subteam) => (
          <SubteamColumn key={subteam} date={day.date} subteam={subteam} updates={day.bySubteam[subteam]} ctx={ctx} />
        ))}
        {empty.length > 0 && <NoUpdateYet date={day.date} subteams={empty} ctx={ctx} />}
      </div>
    </section>
  );
}

/** Stacked layout only: the subteams with no update that day, in one line (with "Write one" for the viewer's). */
function NoUpdateYet({ date, subteams, ctx }: { date: DateOnly; subteams: Subteam[]; ctx: FeedContext }) {
  const writable = subteams.filter((s) => canWriteFor(ctx, date, s));
  const day = formatDateOnly(date, ctx.today);
  return (
    <div className="flex flex-wrap items-center gap-x-4 rounded-xl border border-dashed border-ink-200 px-4 py-1 text-sm text-ink-500 @4xl:hidden">
      <p className="py-2">No {subteamList(subteams, "or")} update yet</p>
      {writable.length > 0 && (
        <div className="flex flex-wrap gap-x-3">
          {writable.map((subteam) => (
            <Link key={subteam} href={newMeetingUpdateHref(date, subteam)} className={writeLinkClasses}>
              <PenLine className="size-4" aria-hidden />
              {writable.length === 1 ? "Write one" : `Write for ${SUBTEAM_LABELS[subteam]}`}
              <span className="sr-only">{writable.length === 1 ? ` for ${SUBTEAM_LABELS[subteam]} on ${day}` : ` on ${day}`}</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

function SubteamColumn({
  date,
  subteam,
  updates,
  ctx,
}: {
  date: DateOnly;
  subteam: Subteam;
  updates: MeetingUpdateItem[];
  ctx: FeedContext;
}) {
  const headingId = `day-${date}-${subteam.toLowerCase()}`;
  const canWrite = canWriteFor(ctx, date, subteam);
  return (
    <div
      role="group"
      aria-labelledby={headingId}
      className={cn(
        "min-w-0 scroll-mt-24 flex-col rounded-xl border border-t-4 border-ink-200 bg-white shadow-sm",
        // An empty subteam gets a card only side by side; stacked, NoUpdateYet says it in one line.
        updates.length > 0 ? "flex" : "hidden @4xl:flex",
        SUBTEAM_ACCENT[subteam],
      )}
    >
      <div className="flex items-center justify-between gap-2 border-b border-ink-100 px-4 py-2.5">
        <h3 id={headingId} className="text-sm">
          <SubteamBadge subteam={subteam} />
        </h3>
        {updates.length > 1 && <span className="text-xs text-ink-500">{updates.length} updates</span>}
      </div>
      {updates.length > 0 ? (
        <div className="divide-y divide-ink-100">
          {updates.map((item) => (
            <MeetingUpdateArticle key={item.id} item={item} ctx={ctx} />
          ))}
        </div>
      ) : (
        <div className="flex flex-1 flex-col items-start gap-1 px-4 py-3 text-sm text-ink-500">
          <p>No update yet</p>
          {canWrite && (
            <Link href={newMeetingUpdateHref(date, subteam)} className={writeLinkClasses}>
              <PenLine className="size-4" aria-hidden />
              Write one
              <span className="sr-only">
                {" "}
                for {SUBTEAM_LABELS[subteam]} on {formatDateOnly(date, ctx.today)}
              </span>
            </Link>
          )}
        </div>
      )}
    </div>
  );
}

function Part({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <h4 className="text-xs font-semibold uppercase tracking-wide text-ink-500">{title}</h4>
      <div className="mt-1">{children}</div>
    </div>
  );
}

/** One update: who wrote it (and who last edited it), what they did, what's next, and any problems. */
export function MeetingUpdateArticle({ item, ctx }: { item: MeetingUpdateItem; ctx: FeedContext }) {
  const name = authorName(item);
  const label = `${SUBTEAM_LABELS[item.subteam]} update by ${name}`;
  const highlighted = ctx.highlight?.id === item.id;
  const message = highlighted ? ctx.highlight?.message : null;
  const anchor = meetingUpdateAnchor(item.id);
  const dayLabel = formatDateOnly(item.meetingDate, ctx.today);
  const editedBy = item.lastEditedBy && item.lastEditedBy.id === item.author?.id ? null : (item.lastEditedBy?.name ?? "a former member");
  return (
    <article
      id={anchor}
      aria-label={label}
      // Focus lands here after saving: the message (already on the page, so not announced as it appears) is
      // read with the update's name.
      aria-describedby={message ? `${anchor}-message` : undefined}
      tabIndex={highlighted ? -1 : undefined}
      className={cn(
        "min-w-0 scroll-mt-24 space-y-3 p-4 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500/40",
        highlighted && "bg-brand-50/40",
      )}
    >
      {message && (
        <div id={`${anchor}-message`}>
          <Alert tone="success" className="py-2">
            {message}
          </Alert>
        </div>
      )}

      <div className="flex items-start gap-2.5">
        <Avatar name={name} size="sm" />
        <div className="min-w-0 leading-snug">
          <p className="text-sm text-ink-700 wrap-anywhere">
            Written by <span className="font-semibold text-ink-900">{name}</span>
            {item.mine && " (you)"} · <time dateTime={item.createdAt.toISOString()}>{writtenAt(item, ctx.timeZone)}</time>
          </p>
          {item.author && <p className="text-xs text-ink-500">{describeRole(item.author.role, item.author.subteam)}</p>}
          {item.lastEditedAt && (
            <p className="text-xs text-ink-500 wrap-anywhere">
              {/* "Edited" alone when the author changed their own update. */}
              {editedBy ? `Edited by ${editedBy}` : "Edited"} ·{" "}
              <time dateTime={item.lastEditedAt.toISOString()}>{timeAgo(item.lastEditedAt, ctx.now, ctx.timeZone)}</time>
            </p>
          )}
        </div>
      </div>

      <Part title="What we did">
        <RichText text={item.body} className="text-sm text-ink-800" />
      </Part>
      {item.nextSteps && (
        <Part title="Next time">
          <RichText text={item.nextSteps} className="text-sm text-ink-800" />
        </Part>
      )}
      {item.blockers && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5">
          <h4 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-amber-900">
            <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
            Problems or help needed
          </h4>
          <RichText text={item.blockers} className="mt-1 text-sm text-amber-950" />
        </div>
      )}

      {item.canEdit && (
        <div className="flex flex-wrap items-start gap-2">
          <ButtonLink href={`/updates/${encodeURIComponent(item.id)}/edit`} variant="secondary" aria-label={`Edit ${label}`}>
            <Pencil className="size-4" aria-hidden />
            Edit
          </ButtonLink>
          <ActionForm
            action={deleteMeetingUpdateAction}
            fields={{ updateId: item.id, back: ctx.back }}
            variant="secondary"
            confirm={`Remove ${item.mine ? "your" : `${name}'s`} ${SUBTEAM_LABELS[item.subteam]} update from ${dayLabel}? This can't be undone.`}
            pendingText="Removing…"
            aria-label={`Remove ${label}`}
          >
            <Trash2 className="size-4 text-red-600" aria-hidden />
            Remove
          </ActionForm>
        </div>
      )}
    </article>
  );
}
