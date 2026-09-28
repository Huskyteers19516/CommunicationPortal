import { Trash2 } from "lucide-react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/tasks/action-form";
import { BackLink } from "@/components/tasks/back-link";
import { PageHeader } from "@/components/ui/page-header";
import { MeetingUpdateForm } from "@/components/updates/meeting-update-form";
import { SUBTEAM_LABELS, SUBTEAMS } from "@/lib/constants";
import { formatDateOnly, todayInTimezone } from "@/lib/dates";
import { meetingDateBounds, meetingUpdateFocusHref } from "@/lib/meeting-updates";
import { requireActiveUser } from "@/server/auth/session";
import { env } from "@/server/env";
import { meetingUpdateSubteams } from "@/server/permissions";
import { getMeetingUpdate } from "@/server/queries/meeting-updates";
import { deleteMeetingUpdateAction, updateMeetingUpdateAction } from "../../actions";

export const metadata: Metadata = { title: "Edit update" };

/** Whoever wrote it, that subteam's leader, and all-scope staff. Everyone else gets a 404. */
export default async function EditMeetingUpdatePage({ params }: PageProps<"/updates/[id]/edit">) {
  const actor = await requireActiveUser();
  const { id } = await params;
  const update = await getMeetingUpdate(actor, id);
  if (!update || !update.canEdit) notFound();

  const today = todayInTimezone(env.teamTimezone);
  const bounds = meetingDateBounds(today);
  // It can stay on its subteam (even if the person no longer writes for it) or move to one they write for.
  const writable = meetingUpdateSubteams(actor);
  const subteams = SUBTEAMS.filter((s) => s === update.subteam || writable.includes(s));
  const author = update.mine ? "your" : `${update.author?.name ?? "a former member"}'s`;
  const day = formatDateOnly(update.meetingDate, today);
  // Back and Cancel return to this update on the feed (its page, scrolled to it).
  const backHref = meetingUpdateFocusHref(update.id);

  return (
    <>
      <BackLink href={backHref}>Meeting updates</BackLink>
      <PageHeader
        title="Edit update"
        description={
          <span className="wrap-anywhere">
            {update.mine ? "Your" : `${update.author?.name ?? "A former member"}'s`} {SUBTEAM_LABELS[update.subteam]} update for {day}
          </span>
        }
        actions={
          <ActionForm
            action={deleteMeetingUpdateAction}
            fields={{ updateId: update.id, back: "" }}
            variant="secondary"
            confirm={`Remove ${author} ${SUBTEAM_LABELS[update.subteam]} update from ${day}? This can't be undone.`}
            pendingText="Removing…"
            aria-label={`Remove this ${SUBTEAM_LABELS[update.subteam]} update`}
          >
            <Trash2 className="size-4 text-red-600" aria-hidden />
            Remove
          </ActionForm>
        }
      />
      <div className="max-w-3xl">
        <MeetingUpdateForm
          action={updateMeetingUpdateAction}
          subteams={subteams}
          submitLabel="Save changes"
          cancelHref={backHref}
          // An edit may keep a date older than a year; the field still lets it stay.
          minDate={update.meetingDate < bounds.min ? update.meetingDate : bounds.min}
          maxDate={update.meetingDate > bounds.max ? update.meetingDate : bounds.max}
          initial={{
            id: update.id,
            version: update.version,
            meetingDate: update.meetingDate,
            subteam: update.subteam,
            body: update.body,
            nextSteps: update.nextSteps,
            blockers: update.blockers,
          }}
        />
      </div>
    </>
  );
}
