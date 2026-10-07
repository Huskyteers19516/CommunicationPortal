"use client";

import { AudioLines, LoaderCircle, NotebookPen, Sparkles } from "lucide-react";
import { useEffect, useRef } from "react";
import { downloadProgressText, transcribePhaseText } from "@/lib/meeting-recorder/recorder-ui";
import { Alert } from "../../ui/alert";
import { Button } from "../../ui/button";
import { Card, CardBody } from "../../ui/card";
import type { TranscribeProgress } from "./engine/live-session";
import { DownloadBar } from "./recorder-setup";

/** Where the recorder is between Stop (or a picked file) and the review step. */
export type ProcessingStep =
  /** Stop: the last of the live transcript is being written. */
  | { step: "finishing" }
  /**
   * No transcript (`none`: the live transcript was off or caught nothing) or only part of one (`partial`: it fell
   * behind or stopped): transcribe the whole recording now, or go on without. `error`: the last try failed.
   */
  | { step: "choose"; reason: "none" | "partial"; error?: string }
  /** The whole recording, on this computer. */
  | { step: "transcribing"; progress: TranscribeProgress | null }
  /** Drafting the key points (`summary`: Chrome's on-device summary is working, `done` of `total` pieces). */
  | { step: "keypoints"; summary: { done: number; total: number } | null; usingSummary: boolean };

/**
 * The recorder after Stop: "Finishing the transcript…", the choice to transcribe the recording when there's no (whole)
 * transcript, the transcription's progress (Cancel), and "Writing key points…" (Skip the on-device summary).
 *
 * The first line is one status line through every step, so a screen reader hears each new step and the choice when it
 * comes up — never every percent (those are shown beside the progress bar). When a step's button takes itself away
 * (Transcribe, Cancel, Skip), focus goes to that line instead of being lost.
 */
export function ProcessingPanel({
  step,
  canTranscribe,
  onTranscribe,
  onSkip,
  onCancel,
  onSkipSummary,
}: {
  step: ProcessingStep;
  /** The audio is here to transcribe. */
  canTranscribe: boolean;
  onTranscribe: () => void;
  /** Go on without (the live transcript as it is, or none). */
  onSkip: () => void;
  onCancel: () => void;
  onSkipSummary: () => void;
}) {
  const lineRef = useRef<HTMLParagraphElement>(null);
  const shownStep = useRef(step.step);

  // A new step (not the first: the page's heading has focus then). Focus moves only when it was lost — the clicked
  // button is gone — so it never jumps away from where the person is.
  useEffect(() => {
    if (shownStep.current === step.step) return;
    shownStep.current = step.step;
    const active = document.activeElement;
    if (!active || active === document.body) lineRef.current?.focus();
  }, [step.step]);

  let line: string;
  let progress: { pct: number; label: string; text: string } | null = null;
  let action: { label: string; onClick: () => void } | null = null;
  if (step.step === "choose") {
    line = step.reason === "none" ? "There's no transcript yet." : "The live transcript missed part of the meeting.";
  } else if (step.step === "finishing") {
    line = "Finishing the transcript…";
  } else if (step.step === "transcribing") {
    const p = step.progress;
    line = p ? transcribePhaseText(p) : "Getting ready to transcribe…";
    if (p?.phase === "transcribing") {
      const pct = Math.max(0, Math.min(100, Math.round(p.pct)));
      progress = { pct, label: "Transcription progress", text: `${pct}%` };
    } else if (p?.phase === "model" && p.status === "downloading") {
      progress = { pct: p.detail.pct ?? 0, label: "Downloading the speech model", text: downloadProgressText(p.detail) };
    }
    action = { label: "Cancel", onClick: onCancel };
  } else {
    // A part at a time (each takes a while): fine to announce.
    line = step.summary
      ? `Writing key points… (Chrome's on-device summary, part ${Math.min(step.summary.done + 1, step.summary.total)} of ${step.summary.total})`
      : "Writing key points…";
    if (step.usingSummary) action = { label: "Skip the on-device summary", onClick: onSkipSummary };
  }
  const choosing = step.step === "choose";

  return (
    <div className="space-y-4">
      {choosing && step.error && <Alert tone="error">{step.error}</Alert>}
      <Card>
        <CardBody className={choosing ? "space-y-4" : "space-y-3"}>
          <div className={choosing ? "flex items-start gap-3" : undefined}>
            {choosing && <AudioLines className="mt-0.5 size-5 shrink-0 text-brand-600" aria-hidden />}
            <div className={choosing ? "min-w-0 space-y-1 text-sm text-ink-700" : undefined}>
              <p
                ref={lineRef}
                role="status"
                tabIndex={-1}
                className={
                  choosing
                    ? "font-medium text-ink-900 focus:outline-none"
                    : "flex items-center gap-2.5 text-sm font-medium text-ink-800 focus:outline-none"
                }
              >
                {step.step === "keypoints" && <Sparkles className="size-4 shrink-0 text-brand-600" aria-hidden />}
                {!choosing && <LoaderCircle className="size-4 shrink-0 animate-spin text-brand-600" aria-hidden />}
                {line}
              </p>
              {choosing && (
                <p>
                  {canTranscribe
                    ? "This computer can transcribe the whole recording now (it takes a few minutes for an hour). The key points are drafted from the transcript."
                    : "The audio isn't on this computer anymore, so it can't be transcribed."}
                </p>
              )}
            </div>
          </div>
          {progress && (
            <div className="space-y-1.5">
              <DownloadBar pct={progress.pct} label={progress.label} />
              <p className="text-xs text-ink-500 tabular-nums" aria-hidden>
                {progress.text}
              </p>
            </div>
          )}
          {step.step === "transcribing" && (
            <p className="text-xs text-ink-500">Keep this tab open. The recording is safe on this computer meanwhile.</p>
          )}
          {choosing ? (
            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
              {canTranscribe && (
                <Button onClick={onTranscribe}>
                  <AudioLines className="size-4" aria-hidden />
                  {step.reason === "none" ? "Transcribe the recording now" : "Transcribe the whole recording now"}
                </Button>
              )}
              <Button variant="secondary" onClick={onSkip}>
                <NotebookPen className="size-4" aria-hidden />
                {step.reason === "none" ? "Skip — I'll write the key points myself" : "Keep the live transcript"}
              </Button>
            </div>
          ) : (
            action && (
              <Button variant="secondary" onClick={action.onClick}>
                {action.label}
              </Button>
            )
          )}
        </CardBody>
      </Card>
    </div>
  );
}
