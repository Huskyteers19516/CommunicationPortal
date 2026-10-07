"use client";

import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { playingTranscriptLine, transcriptLineAt } from "@/lib/meeting-recap-view";
import { formatClock, parseTranscriptLines, type TimedLine } from "@/lib/meeting-recorder/transcript-format";
import { useMeetingPlayback, useMeetingPlaybackPosition } from "./playback";

/** Lines shown before "Show the whole transcript". */
const FOLD_LINES = 12;

/** Scrolls smoothly unless the person asked for less motion. */
function scrollBehavior(): ScrollBehavior {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
}

/** On screen, keeping clear of the sticky header (top) and the phone's tab bar (bottom). */
function onScreen(el: Element, top = 0, bottom = 0): boolean {
  const box = el.getBoundingClientRect();
  return box.bottom > top && box.top < window.innerHeight - bottom;
}

/**
 * A recap's transcript, one line per moment ("[12:30] …" shows as a time chip). Long ones are folded to their first
 * lines with "Show the whole transcript". Inside a MeetingPlaybackProvider: once the recording is loaded, every timed
 * line is a button that plays from there, and the line being played is highlighted (`aria-current="time"`); the page
 * follows along while the person does (the line before was on screen). Key points' times land here (showMoment): the
 * transcript unfolds when needed, and that line is scrolled to and focused.
 */
export function MeetingTranscript({ transcript, className }: { transcript: string; className?: string }) {
  const lines = useMemo(() => parseTranscriptLines(transcript), [transcript]);
  const { loaded, durationMs, playFrom, setMomentHandler } = useMeetingPlayback();
  const { positionMs, playing } = useMeetingPlaybackPosition();
  const [expanded, setExpanded] = useState(false);
  const base = useId();
  const listId = `${base}-lines`;
  const lineId = useCallback((i: number) => `${base}-line-${i}`, [base]);
  const pendingFocus = useRef<number | null>(null);
  const followed = useRef(-1);

  const folds = lines.length > FOLD_LINES + 2;
  const shown = folds && !expanded ? lines.slice(0, FOLD_LINES) : lines;
  const active = loaded ? playingTranscriptLine(lines, positionMs, durationMs) : -1;
  const hasTimes = useMemo(() => lines.some((l) => l.atMs !== null), [lines]);

  const focusLine = useCallback(
    (i: number) => {
      const el = document.getElementById(lineId(i));
      if (!el) return;
      (el.querySelector("button") ?? el).focus({ preventScroll: true });
      el.scrollIntoView({ block: "center", behavior: scrollBehavior() });
    },
    [lineId],
  );

  // Key points' times: show that line (unfolding first when it's folded away).
  useEffect(() => {
    if (!hasTimes) return;
    setMomentHandler((ms) => {
      const i = transcriptLineAt(lines, ms);
      if (i < 0) return false;
      if (folds && !expanded && i >= FOLD_LINES) {
        pendingFocus.current = i;
        setExpanded(true);
      } else {
        focusLine(i);
      }
      return true;
    });
    return () => setMomentHandler(null);
  }, [hasTimes, lines, folds, expanded, focusLine, setMomentHandler]);

  useEffect(() => {
    if (!expanded || pendingFocus.current === null) return;
    const i = pendingFocus.current;
    pendingFocus.current = null;
    focusLine(i);
  }, [expanded, focusLine]);

  // Follow along: when the playing line moves on and the one before was on screen, keep the new one in view.
  useEffect(() => {
    const before = followed.current;
    followed.current = active;
    if (!playing || active < 0 || active === before || before < 0) return;
    const el = document.getElementById(lineId(active));
    const previous = document.getElementById(lineId(before));
    if (!el || !previous || !onScreen(previous)) return;
    if (!onScreen(el, 120, 80)) el.scrollIntoView({ block: "center", behavior: scrollBehavior() });
  }, [active, playing, lineId]);

  if (lines.length === 0) return <p className={cn("text-sm text-ink-500", className)}>No transcript.</p>;

  return (
    <div className={className}>
      <ol id={listId} className="-mx-2 space-y-0.5">
        {shown.map((line, i) => (
          <TranscriptLine key={i} id={lineId(i)} line={line} active={i === active} seekable={loaded} onPlay={playFrom} />
        ))}
      </ol>
      {folds && (
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={listId}
          onClick={() => setExpanded((v) => !v)}
          className="-ml-2 mt-2 inline-flex h-10 items-center rounded-lg px-2 text-sm font-medium text-brand-700 transition-colors hover:bg-brand-50 hover:text-brand-800"
        >
          {expanded ? "Show less" : `Show the whole transcript (${lines.length.toLocaleString("en-US")} lines)`}
        </button>
      )}
    </div>
  );
}

/** One line (memoized: while playing, only the lines whose highlight changes draw again). */
const TranscriptLine = memo(function TranscriptLine({
  id,
  line,
  active,
  seekable,
  onPlay,
}: {
  id: string;
  line: TimedLine;
  active: boolean;
  seekable: boolean;
  onPlay: (ms: number) => void;
}) {
  const time = line.atMs !== null ? formatClock(line.atMs) : null;
  const content = (
    <>
      {time ? (
        <span className="w-14 shrink-0 pt-px font-mono text-xs tabular-nums text-ink-500">{time}</span>
      ) : (
        <span className="w-14 shrink-0" aria-hidden />
      )}
      <span className="min-w-0 text-sm leading-relaxed text-ink-800 wrap-anywhere">{line.text}</span>
    </>
  );
  return (
    <li
      id={id}
      tabIndex={-1}
      aria-current={active ? "time" : undefined}
      className={cn("scroll-mt-24 rounded-lg focus:outline-none", active && "bg-brand-50")}
    >
      {seekable && line.atMs !== null ? (
        <button
          type="button"
          onClick={() => onPlay(line.atMs!)}
          // Said in full: the time and the text are separate boxes, which screen readers may run together.
          aria-label={`Play from ${time}: ${line.text}`}
          className="flex min-h-10 w-full gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-ink-50 focus-visible:bg-ink-50"
        >
          {content}
        </button>
      ) : (
        <div className="flex gap-2 px-2 py-1.5">{content}</div>
      )}
    </li>
  );
});
