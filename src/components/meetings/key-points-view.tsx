"use client";

import { useMemo } from "react";
import { splitKeyPointLabel } from "@/lib/meeting-recap-view";
import { formatClock, parseKeyPointLines } from "@/lib/meeting-recorder/transcript-format";
import { useMeetingPlayback } from "./playback";

/**
 * A recap's key points, one per line; the recorder's labels ("Decision:", "To do (Alice, by Friday):") in bold. A point
 * with a time ("[12:30] …") gets a time chip: it shows that moment in the transcript (`linkedTranscript`: the
 * transcript has times) and, once the recording is loaded (MeetingPlaybackProvider), plays from it. Without either
 * the time is plain text.
 */
export function MeetingKeyPoints({ keyPoints, linkedTranscript = false }: { keyPoints: string; linkedTranscript?: boolean }) {
  const points = useMemo(() => parseKeyPointLines(keyPoints), [keyPoints]);
  const { loaded, playFrom, showMoment } = useMeetingPlayback();
  const clickable = loaded || linkedTranscript;

  if (points.length === 0) return <p className="text-sm text-ink-500">No key points yet.</p>;

  return (
    <ul className="space-y-2.5">
      {points.map((point, i) => {
        const { label, text } = splitKeyPointLabel(point.text);
        const time = point.atMs !== null ? formatClock(point.atMs) : null;
        return (
          <li key={i} className="flex min-w-0 gap-2.5">
            {time === null ? (
              <span className="mt-2 size-1.5 shrink-0 rounded-full bg-brand-500" aria-hidden />
            ) : clickable ? (
              <button
                type="button"
                onClick={() => {
                  showMoment(point.atMs!);
                  if (loaded) playFrom(point.atMs!);
                }}
                aria-label={loaded ? `Play from ${time}` : `Show ${time} in the transcript`}
                // A 40 px target around a small chip; the negative margins keep it on the line.
                className="group -my-2.5 -ml-1 inline-flex h-10 shrink-0 items-center rounded-lg px-1"
              >
                <span className="rounded-md bg-brand-50 px-1.5 py-0.5 font-mono text-xs font-medium tabular-nums text-brand-800 ring-1 ring-inset ring-brand-200 transition-colors group-hover:bg-brand-100">
                  {time}
                </span>
              </button>
            ) : (
              <span className="shrink-0 pt-0.5 font-mono text-xs tabular-nums text-ink-500">{time}</span>
            )}
            <p className="min-w-0 text-sm leading-relaxed text-ink-800 wrap-anywhere sm:text-base">
              {label && <strong className="font-semibold text-ink-900">{label}: </strong>}
              {text}
            </p>
          </li>
        );
      })}
    </ul>
  );
}
