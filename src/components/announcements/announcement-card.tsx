import { Pencil, Pin, Trash2 } from "lucide-react";
import { deleteAnnouncementAction } from "@/app/(app)/announcements/actions";
import { SubteamBadge } from "@/components/app/badges";
import { ActionForm } from "@/components/tasks/action-form";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { RichText } from "@/components/ui/rich-text";
import { announcementAnchor } from "@/lib/announcements";
import { cn } from "@/lib/cn";
import { describeRole } from "@/lib/constants";
import { formatDateTime, timeAgo } from "@/lib/dates";
import type { AnnouncementAuthor, AnnouncementItem } from "@/server/queries/announcements";
import { AnnouncementCardNotice } from "./card-notice";
import { ClampedText } from "./clamped-text";
import { AnnouncementPinButton } from "./pin-button";
import { NewMarker } from "./seen";

/** Texts longer than this (or with more lines) are folded to their first lines, with "Show more". */
const FOLD_CHARS = 400;
const FOLD_LINES = 8;

/** "Build Leader", "Mentor", "Software member" — or "Owner" for an owner whose position is just member. */
export function authorPosition(author: AnnouncementAuthor): string {
  if (author.isAdmin && author.role === "MEMBER") return "Owner";
  return describeRole(author.role, author.subteam);
}

export interface AnnouncementCardContext {
  /** Request time and team timezone (relative labels line up with the rest of the page). */
  now: Date;
  timeZone: string;
  /** The list's query string as shown (kept after removing one). */
  back: string;
  /** The announcement the list opened at (just posted or saved, or from Today), and what to say about it. */
  highlight: { id: string; message: string | null } | null;
}

/**
 * One announcement: Pinned / who it's for / New, the title, who posted it (name and position) and when (hover for
 * the exact time), "edited", the text (links work, line breaks kept), and Edit / Pin / Remove for whoever can.
 */
export function AnnouncementCard({ item, ctx }: { item: AnnouncementItem; ctx: AnnouncementCardContext }) {
  const anchor = announcementAnchor(item.id);
  const titleId = `${anchor}-title`;
  const highlighted = ctx.highlight?.id === item.id;
  const message = highlighted ? ctx.highlight?.message : null;
  const name = item.author?.name ?? "A former member";
  const long = item.body.length > FOLD_CHARS || item.body.split("\n").length > FOLD_LINES;
  const quoted = `“${item.title}”`;

  return (
    <article
      id={anchor}
      aria-labelledby={titleId}
      // Focus lands here after saving: the message (already on the page, so not announced as it appears) is read
      // with the announcement's title.
      aria-describedby={message ? `${anchor}-message` : undefined}
      tabIndex={highlighted ? -1 : undefined}
      className={cn(
        "relative min-w-0 scroll-mt-20 rounded-xl border shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40",
        item.pinned || highlighted ? "border-brand-300" : "border-ink-200",
        // The one the list opened at (from Today, or just saved) stands out even without a keyboard focus ring.
        highlighted ? "bg-brand-50" : "bg-white",
      )}
    >
      <div className="space-y-3 px-4 py-4 sm:px-5">
        <AnnouncementCardNotice id={`${anchor}-message`} message={message ?? null}>
          <div className="flex flex-wrap items-center gap-1.5">
            {item.pinned && (
              <Badge tone="brand">
                <Pin className="size-3" aria-hidden />
                Pinned
              </Badge>
            )}
            <span className="sr-only">For </span>
            <SubteamBadge subteam={item.subteam} />
            <NewMarker createdAt={item.createdAt.toISOString()} mine={item.mine} forYou={item.forYou} />
          </div>

          <h2 id={titleId} className="text-lg font-semibold leading-snug text-ink-900 wrap-anywhere">
            {item.title}
          </h2>

          <div className="flex min-w-0 items-center gap-2.5">
            <Avatar name={name} size="sm" />
            <div className="min-w-0 text-sm leading-snug">
              <p className="wrap-anywhere">
                <span className="font-medium text-ink-900">{name}</span>
                {item.mine && <span className="text-ink-500"> (you)</span>}
                {item.author && <span className="text-ink-500"> · {authorPosition(item.author)}</span>}
              </p>
              <p className="text-xs text-ink-500">
                <time
                  dateTime={item.createdAt.toISOString()}
                  title={formatDateTime(item.createdAt, ctx.timeZone)}
                  className="whitespace-nowrap"
                >
                  {timeAgo(item.createdAt, ctx.now, ctx.timeZone)}
                </time>
                {item.editedAt && (
                  <>
                    {" · "}
                    <span title={`Edited ${formatDateTime(item.editedAt, ctx.timeZone)}`}>edited</span>
                  </>
                )}
              </p>
            </div>
          </div>

          {long ? (
            <ClampedText text={item.body} className="text-sm text-ink-800 wrap-anywhere" />
          ) : (
            <RichText text={item.body} className="text-sm text-ink-800 wrap-anywhere" />
          )}

          {item.canEdit && (
            <div className="flex flex-wrap items-start gap-2 pt-1">
              <ButtonLink
                href={`/announcements/${encodeURIComponent(item.id)}/edit`}
                variant="secondary"
                aria-label={`Edit ${quoted}`}
              >
                <Pencil className="size-4" aria-hidden />
                Edit
              </ButtonLink>
              <AnnouncementPinButton announcementId={item.id} title={item.title} pinned={item.pinned} />
              <ActionForm
                action={deleteAnnouncementAction}
                fields={{ announcementId: item.id, version: item.version, back: ctx.back }}
                variant="secondary"
                confirm={`Remove ${quoted}? Nobody will see it anymore. This can't be undone.`}
                pendingText="Removing…"
                aria-label={`Remove ${quoted}`}
              >
                <Trash2 className="size-4 text-red-600" aria-hidden />
                Remove
              </ActionForm>
            </div>
          )}
        </AnnouncementCardNotice>
      </div>
    </article>
  );
}
