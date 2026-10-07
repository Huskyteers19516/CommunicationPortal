"use client";

import { LoaderCircle, Pause, Play, Square, Star } from "lucide-react";
import { memo, useEffect, useRef } from "react";
import { cn } from "@/lib/cn";
import { downloadProgressText, liveTranscriptAnnouncement, liveTranscriptHint } from "@/lib/meeting-recorder/recorder-ui";
import { formatClock } from "@/lib/meeting-recorder/transcript-format";
import { Button } from "../../ui/button";
import { Card, CardBody, CardHeader } from "../../ui/card";
import type { AsrStatus, AsrStatusDetail } from "./engine/asr-client";
import type { TimedSegment } from "./engine/live-session";
import { DownloadBar } from "./recorder-setup";

/** Lines the live view keeps on screen (an hour is hundreds; the rest are saved, just not shown). */
const LIVE_KEEP = 120;

export interface LiveTranscriptState {
  /** On for this recording (it may still go off: `offMessage`). */
  on: boolean;
  segments: TimedSegment[];
  partial: string;
  /** Recorded time when the model became ready (null: not yet). */
  readyAtMs: number | null;
  /** What the model is doing while it gets ready (downloading, starting…), or null once it's ready. */
  model: { status: AsrStatus; detail: AsrStatusDetail } | null;
  /** The live transcript stopped or never started, and why (the recording is fine). */
  offMessage: string | null;
  /** Seconds of audio it skipped to keep up. */
  droppedSec: number;
  /** About how many seconds it missed because a piece couldn't be transcribed (RecorderStatus "live-gap"). */
  missedSec: number;
}

/**
 * The recorder while recording: the REC dot and timer, the level meter, Pause / Resume, **Mark key moment**, **Stop and
 * review**, the status line, the reminder to keep the tab open (or that this browser keeps it only in memory), and the
 * live transcript.
 */
export function RecordingPanel({
  state,
  elapsedMs,
  level,
  marks,
  live,
  persistent,
  onPause,
  onResume,
  onMark,
  onStop,
}: {
  state: "starting" | "recording" | "paused" | "stopping";
  elapsedMs: number;
  level: number;
  marks: number[];
  live: LiveTranscriptState;
  /** Crash protection works (null while unknown). */
  persistent: boolean | null;
  onPause: () => void;
  onResume: () => void;
  onMark: () => void;
  onStop: () => void;
}) {
  const recording = state === "recording";
  const paused = state === "paused";
  const lastMark = marks.length ? marks[marks.length - 1] : null;
  const status =
    state === "starting"
      ? "Starting the microphone…"
      : paused
        ? "Paused. Nothing is recorded until you resume."
        : state === "stopping"
          ? "Stopping…"
          : lastMark !== null
            ? `Recording. Marked a key moment at ${formatClock(lastMark)}.`
            : "Recording.";

  return (
    <div className="space-y-5">
      <Card>
        <CardBody className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <span
                aria-hidden
                className={cn("size-3.5 rounded-full", recording ? "animate-pulse bg-red-600" : paused ? "bg-amber-500" : "bg-ink-300")}
              />
              <span className={cn("text-sm font-semibold uppercase tracking-wider", recording ? "text-red-700" : "text-ink-600")}>
                {recording ? "Rec" : paused ? "Paused" : state === "stopping" ? "Stopping" : "Starting"}
              </span>
              <span role="timer" aria-label="Recorded time" className="font-display text-4xl font-semibold tabular-nums text-ink-900">
                {formatClock(elapsedMs)}
              </span>
            </div>
            {marks.length > 0 && (
              <span className="inline-flex items-center gap-1.5 text-sm text-ink-600">
                <Star className="size-4 fill-amber-400 text-amber-500" aria-hidden />
                {marks.length} key {marks.length === 1 ? "moment" : "moments"} marked
              </span>
            )}
          </div>

          {/* The room's loudness (visual only). */}
          <div className="h-2.5 overflow-hidden rounded-full bg-ink-100" aria-hidden>
            <div
              className={cn("h-full rounded-full transition-[width] duration-100", level > 0.85 ? "bg-amber-500" : "bg-brand-500")}
              style={{ width: `${Math.round(Math.min(1, level) * 100)}%` }}
            />
          </div>

          <div className="grid gap-2 sm:grid-cols-3">
            {paused ? (
              <Button variant="secondary" size="lg" onClick={onResume}>
                <Play className="size-5" aria-hidden />
                Resume
              </Button>
            ) : (
              <Button variant="secondary" size="lg" onClick={onPause} disabled={!recording}>
                <Pause className="size-5" aria-hidden />
                Pause
              </Button>
            )}
            <Button variant="secondary" size="lg" onClick={onMark} disabled={!recording && !paused}>
              <Star className="size-5" aria-hidden />
              Mark key moment
            </Button>
            <Button variant="danger" size="lg" onClick={onStop} disabled={!recording && !paused}>
              {state === "stopping" ? (
                <LoaderCircle className="size-5 animate-spin" aria-hidden />
              ) : (
                <Square className="size-5" aria-hidden />
              )}
              Stop and review
            </Button>
          </div>

          <p role="status" className="text-sm font-medium text-ink-700">
            {status}
          </p>
          <p className={cn("text-sm", persistent === false ? "font-medium text-amber-800" : "text-ink-500")}>
            {persistent === false
              ? "This browser can't save the recording as it goes, so keep this tab open until it's saved."
              : "Keep this tab open — the recording is saved on this computer as you go."}
          </p>
        </CardBody>
      </Card>

      <LiveTranscript live={live} elapsedMs={elapsedMs} />
    </div>
  );
}

/**
 * The live transcript card: model status, the first-text countdown, the lines so far, and what's being heard. Its
 * status line announces steps only (the model downloading or starting, "any moment now", falling behind); the
 * countdown's seconds and the download's percent are shown beside it, not announced.
 */
function LiveTranscript({ live, elapsedMs }: { live: LiveTranscriptState; elapsedMs: number }) {
  const waiting = live.on && !live.offMessage;
  const first = { elapsedMs, readyAtMs: live.readyAtMs, lines: live.segments.length };
  const said = waiting ? liveTranscriptAnnouncement({ model: live.model, ...first }) : null;
  const countdown = waiting && !live.model && !said ? liveTranscriptHint(first) : null;
  const downloading = waiting && live.model?.status === "downloading" ? live.model.detail : null;
  const lagging = live.droppedSec >= 1 && !live.offMessage;
  const gaps = live.missedSec >= 1 && !live.offMessage;
  return (
    <Card>
      <CardHeader title="Live transcript" description={live.on ? "Written on this computer. You can fix it before saving." : undefined} />
      <CardBody className="space-y-3">
        <div role="status" className="space-y-2 text-sm empty:hidden">
          {live.offMessage && <p className="text-ink-600">{live.offMessage}</p>}
          {said && <p className="text-ink-500">{said}</p>}
          {lagging && (
            <p className="text-amber-800">
              This computer fell behind, so the live transcript skipped some of the audio. The recording itself is complete — you can
              transcribe all of it after you stop.
            </p>
          )}
          {gaps && (
            <p className="text-amber-800">
              Part of the audio couldn&apos;t be transcribed live. The recording itself is complete — you can transcribe all of it after you
              stop.
            </p>
          )}
        </div>
        {downloading && (
          <div className="space-y-1.5">
            <DownloadBar pct={downloading.pct ?? 0} label="Downloading the speech model" />
            <p className="text-xs text-ink-500" aria-hidden>
              {downloadProgressText(downloading)}
            </p>
          </div>
        )}
        {countdown && <p className="text-sm text-ink-500">{countdown}</p>}
        {lagging && <p className="text-xs text-ink-500">Skipped so far: about {Math.round(live.droppedSec)} s.</p>}
        {gaps && <p className="text-xs text-ink-500">Missed so far: about {Math.round(live.missedSec)} s.</p>}
        {(live.segments.length > 0 || live.partial) && <LiveLines segments={live.segments} partial={live.partial} />}
      </CardBody>
    </Card>
  );
}

/** The lines, newest at the bottom, following along while the reader is at the bottom. Re-renders only when they change. */
const LiveLines = memo(function LiveLines({ segments, partial }: { segments: TimedSegment[]; partial: string }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const shown = segments.length > LIVE_KEEP ? segments.slice(-LIVE_KEEP) : segments;
  const hidden = segments.length - shown.length;

  useEffect(() => {
    const box = boxRef.current;
    if (box && atBottom.current) box.scrollTop = box.scrollHeight;
  }, [segments, partial]);

  return (
    <div
      ref={boxRef}
      onScroll={(e) => {
        const box = e.currentTarget;
        atBottom.current = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
      }}
      className="max-h-96 overflow-y-auto rounded-lg border border-ink-100 bg-ink-50/60 p-3"
    >
      {hidden > 0 && <p className="mb-2 text-xs text-ink-500">{hidden.toLocaleString("en-US")} earlier lines are saved too.</p>}
      <ol className="space-y-1.5 text-sm leading-relaxed text-ink-800">
        {shown.map((seg, i) => (
          <li key={hidden + i} className="flex gap-2">
            <span className="w-12 shrink-0 font-mono text-xs leading-6 text-ink-400 tabular-nums">{formatClock(seg.s)}</span>
            <span className="min-w-0 wrap-anywhere">{seg.text}</span>
          </li>
        ))}
      </ol>
      {partial && <p className="mt-2 text-sm italic text-ink-500 wrap-anywhere">{partial}</p>}
    </div>
  );
});
