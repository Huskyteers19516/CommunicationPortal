"use client";

import { ArrowRight, Download, LoaderCircle, RotateCcw, Trash2 } from "lucide-react";
import { type FormEvent, useRef } from "react";
import type { MeetingRecapCreateState } from "@/app/(app)/meetings/actions";
import { useFocusFirstError } from "@/components/auth/use-focus-first-error";
import { cn } from "@/lib/cn";
import type { DateOnly } from "@/lib/dates";
import { formatFileSize } from "@/lib/files";
import { meetingAudioExtension, type MeetingAudioType, type MeetingCategoryOption } from "@/lib/meeting-recaps";
import { recapFileBase } from "@/lib/meeting-recorder/export";
import { uploadFailedHint, uploadProgressText } from "@/lib/meeting-recorder/recorder-ui";
import { formatClock } from "@/lib/meeting-recorder/transcript-format";
import { Alert } from "../../ui/alert";
import { Button } from "../../ui/button";
import { Card, CardBody, CardHeader } from "../../ui/card";
import { CheckboxField } from "../../ui/field";
import { FormMessage } from "../../ui/form-message";
import { MeetingAudioPlayer } from "../meeting-audio-player";
import { MeetingRecapFields, type MeetingRecapFieldValues } from "../meeting-recap-fields";
import { saveFile } from "../save-file";
import type { UploadProgress } from "./engine/upload";
import { DownloadBar } from "./recorder-setup";

/** The fields that show their own error. */
const FIELDS = ["title", "meetingDate", "categoryIds", "keyPoints", "transcript"] as const;

/**
 * Where saving is. Once saved, `textKept`: an earlier try of this save had made the recap, which kept its own text (it
 * was edited since, or it's another admin's save) — the form's changes weren't added (said here, and on the recap's
 * page: `?saved=first`).
 */
export type SaveState =
  | { stage: "idle" }
  /** createMeetingRecapAction is running. */
  | { stage: "saving" }
  /** It said no (a field, the rate limit, offline): fix and save again. */
  | { stage: "refused"; state: MeetingRecapCreateState }
  /** Saved; the recording's parts are going up. */
  | { stage: "uploading"; recapId: string; progress: UploadProgress | null; textKept?: boolean }
  /** Saved, but the upload stopped (`message` says why). This browser's copy can finish it (if it could keep one). */
  | { stage: "upload-failed"; recapId: string; message: string; progress: UploadProgress | null; textKept?: boolean }
  /**
   * Saved without the recording (storage full, or its 3 days ran out before the upload could finish): why. `kept`:
   * this browser still keeps its copy (discard it from the recorder's start screen); otherwise it's only in this tab.
   */
  | { stage: "audio-refused"; recapId: string; message: string; kept?: boolean; textKept?: boolean }
  /** Saved and uploaded: opening the recap. */
  | { stage: "done"; recapId: string; textKept?: boolean };

/** The recording under review. */
export interface ReviewAudio {
  blob: Blob | null;
  /** The kind it's kept as, or null when it can't be kept (`note` says why). */
  audioType: MeetingAudioType | null;
  note: string | null;
  durationMs: number;
}

/**
 * The recorder's review step: the recording to listen back to (and "Keep the recording for 3 days"), the recap's fields
 * (MeetingRecapFields: title, date, categories, key points, transcript), and **Save recap** → the recap is saved,
 * then its recording uploaded with progress; or **Discard**. Controlled: the recorder holds the fields and does the
 * saving (`onSave` gets the form's FormData).
 */
export function ReviewPanel({
  values,
  onChange,
  keepAudio,
  onKeepAudioChange,
  audio,
  keepUntil,
  note,
  categories,
  today,
  save,
  onSave,
  uploadKept,
  onRetryUpload,
  onOpenRecap,
  onDiscard,
}: {
  values: MeetingRecapFieldValues;
  onChange: (patch: Partial<MeetingRecapFieldValues>) => void;
  keepAudio: boolean;
  onKeepAudioChange: (keep: boolean) => void;
  audio: ReviewAudio;
  /** "Fri, Oct 10, 3:40 PM": until when everyone could listen, if saved now. */
  keepUntil: string;
  /** Something about the transcript ("No speech was found…"). */
  note: string | null;
  categories: MeetingCategoryOption[];
  today: DateOnly;
  save: SaveState;
  onSave: (formData: FormData) => void;
  /** This browser kept the copy that finishes the upload (false: memory only — it's lost when the tab closes). */
  uploadKept: boolean;
  onRetryUpload: () => void;
  /** Open the saved recap (after an upload that stopped, or a recording that wasn't kept). */
  onOpenRecap: () => void;
  onDiscard: () => void;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const refused = save.stage === "refused" ? save.state : null;
  const errors = refused && !refused.ok ? (refused.fieldErrors ?? {}) : {};
  const fieldMessages = FIELDS.map((k) => errors[k]).filter(Boolean);
  const showMessage = !!refused && !refused.ok && !!refused.message && !fieldMessages.includes(refused.message);
  const saved = save.stage === "uploading" || save.stage === "upload-failed" || save.stage === "audio-refused" || save.stage === "done";
  const busy = save.stage === "saving" || save.stage === "uploading" || save.stage === "done";
  // Said while the person is still here (the recap's page says it once it opens).
  const textKept = (save.stage === "uploading" || save.stage === "upload-failed" || save.stage === "audio-refused") && !!save.textKept;
  const canKeep = !!audio.blob && !!audio.audioType;

  useFocusFirstError(refused, formRef);

  const downloadAudio = () =>
    audio.blob &&
    saveFile(audio.blob, `${recapFileBase(values.title, values.meetingDate)}.${meetingAudioExtension(audio.audioType ?? "audio/webm")}`);

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy || saved) return;
    onSave(new FormData(e.currentTarget));
  }

  return (
    <form ref={formRef} onSubmit={submit} className="space-y-5" noValidate>
      <Card>
        <CardHeader
          title="Recording"
          description={[
            audio.durationMs >= 1000 ? formatClock(audio.durationMs) : null,
            audio.blob ? formatFileSize(audio.blob.size) : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        />
        <CardBody className="space-y-4">
          {audio.blob ? (
            <MeetingAudioPlayer source={{ blob: audio.blob }} downloadName={recapFileBase(values.title, values.meetingDate)} />
          ) : (
            <p className="text-sm text-ink-500">
              The audio isn&apos;t on this computer anymore (copies here are deleted after 3 days). The text can still be saved.
            </p>
          )}
          {audio.blob && (
            <CheckboxField
              checked={canKeep && keepAudio}
              disabled={!canKeep || saved || busy}
              onChange={(e) => onKeepAudioChange(e.currentTarget.checked)}
              label="Keep the recording for 3 days"
              description={canKeep ? `Everyone can listen until ${keepUntil}. Then it's deleted automatically.` : audio.note}
            />
          )}
        </CardBody>
      </Card>

      {note && <Alert tone="info">{note}</Alert>}

      <Card>
        <CardBody>
          <MeetingRecapFields
            values={values}
            onChange={onChange}
            categories={categories}
            today={today}
            errors={errors}
            idPrefix="review"
            disabled={busy || saved}
          />
        </CardBody>
      </Card>

      {!values.keyPoints.trim() && !saved && (
        <Alert tone="warning">
          There are no key points yet. Add the meeting&apos;s decisions and to-dos, one per line — they&apos;re what most people will read.
        </Alert>
      )}

      {showMessage && <FormMessage state={refused} />}

      {/* Saving and uploading, then what happened. */}
      <div role="status" className="space-y-3 empty:hidden">
        {textKept && (
          <Alert tone="warning" title="This recap had already been saved by an earlier try." role={null}>
            Your later changes weren&apos;t added. They&apos;re still in the form above — open the recap and use Edit to add them.
          </Alert>
        )}
        {save.stage === "saving" && <ProgressLine text="Saving the recap…" />}
        {(save.stage === "uploading" || save.stage === "done") && (
          <div className="space-y-2">
            <ProgressLine
              text={
                save.stage === "done"
                  ? "Saved. Opening the recap…"
                  : save.progress
                    ? uploadProgressText(save.progress)
                    : "Recap saved. Uploading the recording…"
              }
            />
            {save.stage === "uploading" && save.progress && (
              <DownloadBar
                pct={save.progress.bytesTotal ? (save.progress.bytesDone / save.progress.bytesTotal) * 100 : 0}
                label="Uploading the recording"
              />
            )}
            {save.stage === "uploading" && <p className="text-xs text-ink-500">Keep this tab open until the upload finishes.</p>}
          </div>
        )}
        {save.stage === "upload-failed" && (
          <Alert tone="warning" title="The recap is saved, but its recording didn't finish uploading." role={null}>
            <p>{save.message}</p>
            <p className="mt-1">{uploadFailedHint(uploadKept)}</p>
          </Alert>
        )}
        {save.stage === "audio-refused" && (
          <Alert tone="warning" title="Recap saved, without the recording." role={null}>
            <p>{save.message}</p>
            <p className="mt-1">
              {save.kept
                ? "The copy on this computer stays until you discard it from Record a meeting. Download it if you want to keep one."
                : "Download the recording now if you want to keep a copy — it isn't kept on this computer after you leave."}
            </p>
          </Alert>
        )}
      </div>

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
        {!saved ? (
          <>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => {
                if (window.confirm("Discard this recording? It's deleted from this computer, and nothing is saved. This can't be undone."))
                  onDiscard();
              }}
            >
              <Trash2 className="size-4 text-red-600" aria-hidden />
              Discard
            </Button>
            <Button
              type="submit"
              size="lg"
              aria-disabled={busy || undefined}
              aria-busy={busy}
              className={cn(busy && "cursor-wait opacity-60")}
            >
              {busy && <LoaderCircle className="size-5 animate-spin" aria-hidden />}
              {busy ? "Saving…" : "Save recap"}
            </Button>
          </>
        ) : save.stage === "upload-failed" ? (
          <>
            {!uploadKept && audio.blob && (
              <Button variant="secondary" onClick={downloadAudio}>
                <Download className="size-4" aria-hidden />
                Download the recording
              </Button>
            )}
            <Button
              variant="secondary"
              onClick={() => {
                // Leaving loses a recording this browser couldn't keep (the guard doesn't see this button's navigation).
                if (uploadKept || window.confirm("Open the recap without the recording? This browser can't keep it, so its upload can't be finished later."))
                  onOpenRecap();
              }}
            >
              Open the recap without the recording
            </Button>
            <Button onClick={onRetryUpload}>
              <RotateCcw className="size-4" aria-hidden />
              Try the upload again
            </Button>
          </>
        ) : save.stage === "audio-refused" ? (
          <>
            {audio.blob && (
              <Button variant="secondary" onClick={downloadAudio}>
                <Download className="size-4" aria-hidden />
                Download the recording
              </Button>
            )}
            <Button onClick={onOpenRecap}>
              Open the recap
              <ArrowRight className="size-4" aria-hidden />
            </Button>
          </>
        ) : null}
      </div>
    </form>
  );
}

function ProgressLine({ text }: { text: string }) {
  return (
    <p className="flex items-center gap-2.5 text-sm font-medium text-ink-800">
      <LoaderCircle className="size-4 shrink-0 animate-spin text-brand-600" aria-hidden />
      {text}
    </p>
  );
}
