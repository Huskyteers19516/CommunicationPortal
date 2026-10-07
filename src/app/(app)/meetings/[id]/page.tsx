import { AudioLines, CalendarDays, Clock, Pencil, Trash2 } from "lucide-react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";
import { UserAvatar } from "@/components/app/user-avatar";
import { DeleteRecordingButton, RecordingNotices } from "@/components/meetings/delete-recording";
import { MeetingKeyPoints } from "@/components/meetings/key-points-view";
import { MeetingAudioPlayer } from "@/components/meetings/meeting-audio-player";
import { MeetingPlaybackProvider } from "@/components/meetings/playback";
import { MeetingRecapExports } from "@/components/meetings/recap-exports";
import { RecorderLink } from "@/components/meetings/recorder-link";
import { MeetingTranscript } from "@/components/meetings/transcript-view";
import { FocusAlert } from "@/components/sponsors/focus-alert";
import { ActionForm } from "@/components/tasks/action-form";
import { BackLink } from "@/components/tasks/back-link";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { describeRole } from "@/lib/constants";
import { formatDateOnly, formatDateTime, timeAgo, todayInTimezone } from "@/lib/dates";
import { meetingAudioUntilLabel, meetingRecapOrigin } from "@/lib/meeting-recap-view";
import { formatMeetingDuration, meetingRecapHref } from "@/lib/meeting-recaps";
import { recapFileBase } from "@/lib/meeting-recorder/export";
import { parseKeyPointLines, parseTranscriptLines } from "@/lib/meeting-recorder/transcript-format";
import { requireActiveUser } from "@/server/auth/session";
import { env } from "@/server/env";
import { scheduleMeetingAudioPurge } from "@/server/meetings/purge";
import { getMeetingRecap, type MeetingRecapDetail, type MeetingRecapPerson } from "@/server/queries/meeting-recaps";
import { deleteMeetingRecapAction } from "../actions";

/** Request time, read outside of render so the recording's state and "2 h ago" line up with the data. */
function requestTime(): Date {
  return new Date();
}

// Shared by generateMetadata and the page so the recap loads once per request.
const loadRecap = cache(async (id: string) => {
  const actor = await requireActiveUser();
  return getMeetingRecap(actor, id, requestTime());
});

export async function generateMetadata({ params }: PageProps<"/meetings/[id]">): Promise<Metadata> {
  const { id } = await params;
  const recap = await loadRecap(id);
  return { title: recap?.title ?? "Meeting recap" };
}

function first(v: string | string[] | undefined) {
  return Array.isArray(v) ? v[0] : v;
}

/**
 * What `?saved=` says: a new recap (from the write-up or the recorder), one an earlier try had saved and that kept
 * its text (`first`: createMeetingRecap's `textKept`), saved changes, or nothing to save.
 */
const SAVED_MESSAGES: Record<string, { tone: "success" | "warning"; text: string }> = {
  new: { tone: "success", text: "Recap saved. Everyone on the team can read it now." },
  first: {
    tone: "warning",
    text: "This recap had already been saved by an earlier try. Your later changes weren't added — use Edit to add them.",
  },
  "1": { tone: "success", text: "Changes saved." },
  "0": { tone: "success", text: "Nothing changed, so there was nothing to save." },
};

/** "Build Leader", "Mentor", "Software member" — or "Owner" for an owner whose position is just member. */
function position(person: MeetingRecapPerson): string {
  if (person.isAdmin && person.role === "MEMBER") return "Owner";
  return describeRole(person.role, person.subteam);
}

/** The recording, as it is now: a player while it's kept, its upload's progress, or that it's gone. Nothing when there never was one. */
function RecordingSection({ recap, timeZone }: { recap: MeetingRecapDetail; timeZone: string }) {
  const audio = recap.audio;
  if (audio.state === "none") return null;

  if (audio.state === "deleted") {
    return (
      <p className="flex items-start gap-2.5 rounded-xl border border-dashed border-ink-200 bg-white/60 px-4 py-3 text-sm text-ink-500">
        <AudioLines className="mt-0.5 size-4 shrink-0" aria-hidden />
        {audio.early
          ? `The recording was deleted on ${formatDateTime(new Date(audio.at), timeZone)}. The transcript and key points stay.`
          : "The recording was deleted after 3 days. The transcript and key points stay."}
      </p>
    );
  }

  // Says how it went above the card (RecordingNotices, on the page), since the card changes once it's deleted.
  const deleteRecording = recap.canManage && (
    <DeleteRecordingButton
      recapId={recap.id}
      confirm={
        audio.state === "ready"
          ? "Delete the recording now? Nobody can listen to it after this. The transcript and key points stay. This can't be undone."
          : "Delete the unfinished recording? The transcript and key points stay. This can't be undone."
      }
    >
      <Trash2 className="size-4 text-red-600" aria-hidden />
      {audio.state === "ready" ? "Delete recording now" : "Delete recording"}
    </DeleteRecordingButton>
  );

  if (audio.state === "uploading") {
    return (
      <Card>
        <CardHeader title="Recording" actions={deleteRecording || undefined} />
        <CardBody className="space-y-1 text-sm text-ink-700">
          <p>
            The recording is still uploading ({audio.received} of {audio.total} {audio.total === 1 ? "part" : "parts"}). It can be played
            once every part is in.
          </p>
          {recap.canManage && (
            <p className="text-ink-500">
              Open{" "}
              <RecorderLink className="font-medium text-brand-700 underline underline-offset-2 hover:text-brand-800">
                Record a meeting
              </RecorderLink>{" "}
              on the computer that recorded it to finish.
            </p>
          )}
        </CardBody>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader
        title="Recording"
        description={`Deleted automatically on ${meetingAudioUntilLabel(audio.expiresAt, timeZone, "long")}.`}
        actions={deleteRecording || undefined}
      />
      <CardBody>
        <MeetingAudioPlayer
          source={{ partIds: audio.partIds, audioType: audio.audioType, audioBytes: audio.audioBytes }}
          downloadName={recap.canManage ? recapFileBase(recap.title, recap.meetingDate) : undefined}
        />
      </CardBody>
    </Card>
  );
}

/**
 * One meeting recap, for everyone: what it was (categories, title, day, length, who saved it), its recording while
 * it's kept (3 days), the key points (their times show that moment in the transcript, and play it once the recording
 * is loaded), the transcript, and exports. People with admin access also edit and delete it, and delete the recording.
 */
export default async function MeetingRecapPage({ params, searchParams }: PageProps<"/meetings/[id]">) {
  const { id } = await params;
  const sp = await searchParams;
  const recap = await loadRecap(id);
  if (!recap) notFound();
  scheduleMeetingAudioPurge();
  const timeZone = env.teamTimezone;
  const now = requestTime();
  const today = todayInTimezone(timeZone, now);
  const saved = SAVED_MESSAGES[first(sp.saved) ?? ""] ?? null;
  const createdAt = new Date(recap.createdAt);
  const authorName = recap.createdBy?.name ?? "a former member";
  const linkedTranscript = parseTranscriptLines(recap.transcript).some((l) => l.atMs !== null);
  // What a key point's time does: shows that transcript line, and plays it once the recording is loaded.
  const timedPoints = parseKeyPointLines(recap.keyPoints).some((p) => p.atMs !== null);
  const keyPointsHint = !timedPoints
    ? undefined
    : recap.audio.state === "ready"
      ? "Tap a time to jump to that moment (it plays once the recording is loaded)."
      : linkedTranscript
        ? "Tap a time to see that moment in the transcript."
        : undefined;
  const quoted = `“${recap.title}”`;

  return (
    <div className="mx-auto w-full min-w-0 max-w-3xl">
      <BackLink href="/meetings">Meeting recaps</BackLink>

      {/* Takes focus: after saving, the page would otherwise open where the form was scrolled to. */}
      {saved && (
        <div className="mb-4">
          <FocusAlert tone={saved.tone}>{saved.text}</FocusAlert>
        </div>
      )}

      <header className="mb-4 min-w-0">
        {recap.categories.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {recap.categories.map((c) => (
              <Badge key={c.id} tone="brand" className="max-w-full">
                <span className="truncate">{c.name}</span>
              </Badge>
            ))}
          </div>
        )}
        <h1 className="text-xl font-semibold text-ink-900 wrap-anywhere sm:text-2xl">{recap.title}</h1>
        <p className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-ink-600">
          <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
            <CalendarDays className="size-4 text-ink-400" aria-hidden />
            <time dateTime={recap.meetingDate}>{formatDateOnly(recap.meetingDate, today)}</time>
          </span>
          {recap.durationSec !== null && (
            <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
              <Clock className="size-4 text-ink-400" aria-hidden />
              {formatMeetingDuration(recap.durationSec)}
            </span>
          )}
        </p>
        <div className="mt-3 flex min-w-0 items-center gap-3">
          <UserAvatar userId={recap.createdBy?.id} name={recap.createdBy?.name ?? "?"} />
          <div className="min-w-0 leading-tight">
            <p className="text-sm font-medium text-ink-900 wrap-anywhere">
              {meetingRecapOrigin(recap)} by {authorName}
            </p>
            <p className="mt-0.5 text-xs text-ink-500">
              {recap.createdBy && <span className="wrap-anywhere">{position(recap.createdBy)} · </span>}
              <time className="whitespace-nowrap" dateTime={recap.createdAt} title={formatDateTime(createdAt, timeZone)}>
                saved {timeAgo(createdAt, now, timeZone)}
              </time>
              {recap.editedAt && (
                <span
                  className="whitespace-nowrap"
                  title={`Edited ${formatDateTime(new Date(recap.editedAt), timeZone)}${recap.editedBy ? ` by ${recap.editedBy.name}` : ""}`}
                >
                  {" "}
                  · edited
                </span>
              )}
            </p>
          </div>
        </div>
      </header>

      <div className="mb-6 space-y-3">
        {recap.canManage && (
          <div className="flex flex-wrap items-start gap-2">
            <ButtonLink href={`${meetingRecapHref(recap.id)}/edit`} variant="secondary" aria-label="Edit this recap">
              <Pencil className="size-4" aria-hidden />
              Edit
            </ButtonLink>
            <ActionForm
              action={deleteMeetingRecapAction}
              fields={{ recapId: recap.id, version: recap.version }}
              variant="ghost"
              confirm={`Delete ${quoted}? Its key points and transcript${recap.audio.state === "ready" || recap.audio.state === "uploading" ? " and its recording" : ""} go for everyone. This can't be undone.`}
              pendingText="Deleting…"
              aria-label="Delete this recap"
            >
              <Trash2 className="size-4" aria-hidden />
              Delete
            </ActionForm>
          </div>
        )}
        <MeetingRecapExports
          recap={{
            title: recap.title,
            meetingDate: recap.meetingDate,
            categories: recap.categories.map((c) => c.name),
            durationSec: recap.durationSec,
            keyPoints: recap.keyPoints,
            transcript: recap.transcript,
            recordedBy: recap.createdBy?.name ?? null,
          }}
        />
      </div>

      {/* The recording, key points, and transcript share where playback is. */}
      <MeetingPlaybackProvider>
        <div className="space-y-4">
          {/* "Delete recording now" says how it went here, and focus goes to that message. */}
          <RecordingNotices>
            <RecordingSection recap={recap} timeZone={timeZone} />
          </RecordingNotices>

          <Card>
            <CardHeader title="Key points" description={keyPointsHint} />
            <CardBody>
              <MeetingKeyPoints keyPoints={recap.keyPoints} linkedTranscript={linkedTranscript} />
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title="Transcript"
              description={
                recap.audio.state === "ready" && linkedTranscript
                  ? "Once the recording is loaded, tap a line to play from there."
                  : undefined
              }
            />
            <CardBody>
              <MeetingTranscript transcript={recap.transcript} />
            </CardBody>
          </Card>
        </div>
      </MeetingPlaybackProvider>
    </div>
  );
}
