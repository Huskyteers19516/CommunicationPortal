// The live transcript's windowing, ported from VoiceCollector's StreamingWhisper (whisper.js) and moved to the
// main thread: the model itself runs in a Web Worker behind the injected `transcribe`. Client-safe, no DOM.
//
// Samples (16 kHz mono) are pushed as the microphone tap produces them, from the moment the recording starts —
// even while the model is still downloading. Every 22 s a 25 s window (3 s overlap with the previous one) goes to
// `transcribe`; the words the overlap recognised twice are cut, loops and repeats are cleaned
// (transcript-text.ts), and the rest is reported with `onFinal({ s, e, text })`. Times are sample counts since
// the start, so they match the recorded file: the tap isn't fed while the recording is paused.
//
// When transcription can't keep up, the window jumps to the newest audio rather than drifting further behind
// (the recording itself is never affected; the whole file can be transcribed again after Stop). A window the model
// fails on is skipped too. Both are counted (droppedSec, failedSec), so at Stop liveTranscriptCoverage() can tell
// whether the live transcript covers the whole recording.

import {
  collapseLoops,
  createRepeatMemory,
  dropRepeats,
  dropSilenceHallucinations,
  overlapJoinLength,
  type TimedSegment,
  type Token,
  tokenize,
} from "./transcript-text";
import { MIN_SPEECH_RATIO, SAMPLE_RATE, speechRatio } from "./vad";

export type WindowerStatus =
  /** Audio was thrown away: the buffer filled up (model not ready yet / far behind) or transcription was too slow. */
  | { type: "lagging"; droppedSec: number; reason: "buffer-full" | "slow-inference" }
  /** A window was mostly silence and wasn't transcribed. */
  | { type: "silence"; startMs: number }
  /**
   * `transcribe` threw; the windower keeps going with the next window. `missedSec`: the audio that is now missing
   * from the transcript (only that window heard it), 0 when nothing was lost.
   */
  | { type: "error"; message: string; missedSec: number };

/** The windower's numbers (seconds), for liveTranscriptCoverage(). */
export type WindowerStats = { ready: boolean; totalSec: number; pendingSec: number; droppedSec: number; failedSec: number };

export type StreamWindowerOptions = {
  /** Runs the model on one window (a fresh copy the callee may transfer). Resolves to the raw recognised text. */
  transcribe: (pcm: Float32Array) => Promise<string>;
  /** Start transcribing right away (default false: call setReady() once the model has loaded). */
  ready?: boolean;
  windowSec?: number;
  overlapSec?: number;
  /** How much audio to keep while waiting for the model or catching up (default 240 s). */
  backlogSec?: number;
  /** Skip windows with too little speech (default true). */
  skipSilence?: boolean;
  onFinal?: (segment: TimedSegment & { e: number }) => void;
  /** The window's raw text, including words repeated from the previous window — for a grey "hearing…" preview. */
  onPartial?: (text: string) => void;
  onStatus?: (status: WindowerStatus) => void;
};

export class StreamWindower {
  private readonly transcribe: (pcm: Float32Array) => Promise<string>;
  private readonly onFinal?: StreamWindowerOptions["onFinal"];
  private readonly onPartial?: (text: string) => void;
  private readonly onStatus?: (status: WindowerStatus) => void;
  private readonly skipSilence: boolean;

  private readonly winSamples: number;
  private readonly stepSamples: number;
  private readonly overlapSamples: number;
  /** How many words the overlap can hold (8 words/s is generous). */
  private readonly maxOverlapTokens: number;
  /** Steady state: further behind than a window plus this, jump to the newest audio. */
  private readonly lagLimit: number;
  /** A tail shorter than this (0.4 s) is noise. */
  private readonly minTail: number;

  // Buffer: buf[0] is absolute sample `base`, `len` samples are valid, transcribed up to `cursor`.
  private readonly cap: number;
  private buf: Float32Array;
  private len = 0;
  private base = 0;
  private cursor = 0;

  private ready: boolean;
  private stopped = false;
  private busy = false;
  private task: Promise<void> = Promise.resolve();
  private prevTokens: Token[] = [];
  /** Set when audio was skipped: the next window doesn't de-duplicate against the previous one. */
  private discontinuous = false;
  /** Latest end time reported, so times never go backwards. */
  private lastEndMs = 0;
  private readonly memory = createRepeatMemory();
  /** Backlog allowed while catching up after the model became ready (samples); 0 in steady state. */
  private catchUp = 0;
  private dropped = 0;
  /** Audio only failed windows heard (samples). */
  private failed = 0;
  /** Absolute sample up to which windows have run (transcribed, or skipped as silence). */
  private coveredTo = 0;
  private unreported = 0;
  private lastReportAt = -1;

  constructor(opts: StreamWindowerOptions) {
    const windowSec = opts.windowSec ?? 25;
    const overlapSec = opts.overlapSec ?? 3;
    if (!(overlapSec > 0) || overlapSec >= windowSec) throw new Error("overlapSec must be above 0 and below windowSec");
    this.transcribe = opts.transcribe;
    this.onFinal = opts.onFinal;
    this.onPartial = opts.onPartial;
    this.onStatus = opts.onStatus;
    this.skipSilence = opts.skipSilence ?? true;
    this.ready = opts.ready ?? false;

    this.winSamples = Math.round(windowSec * SAMPLE_RATE);
    this.stepSamples = Math.round((windowSec - overlapSec) * SAMPLE_RATE);
    this.overlapSamples = this.winSamples - this.stepSamples;
    this.maxOverlapTokens = Math.max(8, Math.ceil(overlapSec * 8));
    this.lagLimit = this.stepSamples * 2;
    this.minTail = Math.round(0.4 * SAMPLE_RATE);
    this.cap = Math.max(this.winSamples * 3, Math.round((opts.backlogSec ?? 240) * SAMPLE_RATE) + this.winSamples);
    this.buf = new Float32Array(this.cap);
  }

  /** Whether windows are being transcribed (the model is ready). */
  get isReady(): boolean {
    return this.ready;
  }

  /** Seconds of audio waiting to be transcribed. */
  get pendingSec(): number {
    return Math.max(0, this.base + this.len - this.cursor) / SAMPLE_RATE;
  }

  /** Seconds of audio never transcribed because the windower fell behind or its buffer filled up. */
  get droppedSec(): number {
    return this.dropped / SAMPLE_RATE;
  }

  /** Seconds of audio left out because `transcribe` failed on the only window that had it. */
  get failedSec(): number {
    return this.failed / SAMPLE_RATE;
  }

  /** Seconds of audio pushed so far. */
  get totalSec(): number {
    return (this.base + this.len) / SAMPLE_RATE;
  }

  /** All the numbers at once (take them before stop(), which empties the buffer). */
  stats(): WindowerStats {
    return { ready: this.ready, totalSec: this.totalSec, pendingSec: this.pendingSec, droppedSec: this.droppedSec, failedSec: this.failedSec };
  }

  /** The model is ready: start transcribing, catching up on what was buffered meanwhile. */
  setReady(): void {
    if (this.ready || this.stopped) return;
    this.ready = true;
    this.catchUp = Math.max(0, this.base + this.len - this.cursor);
    this.pump();
  }

  /** Adds samples (copied; the caller may reuse its buffer). */
  push(samples: Float32Array): void {
    if (this.stopped || !samples || samples.length === 0) return;
    this.append(samples);
    this.pump();
  }

  private lag(droppedSamples: number, reason: "buffer-full" | "slow-inference"): void {
    this.dropped += droppedSamples;
    this.unreported += droppedSamples;
    this.discontinuous = true;
    this.prevTokens = [];
    // A full buffer drops a little on every push (16 times a second): report at most every 5 s of audio.
    const now = this.base + this.len;
    if (this.lastReportAt >= 0 && now - this.lastReportAt < 5 * SAMPLE_RATE) return;
    this.lastReportAt = now;
    this.onStatus?.({ type: "lagging", droppedSec: +(this.unreported / SAMPLE_RATE).toFixed(1), reason });
    this.unreported = 0;
  }

  private append(chunk: Float32Array): void {
    let data = chunk;
    let n = data.length;

    // A single push longer than the whole buffer: keep only its last `cap` samples (without this the drop below
    // would make `len` negative and set() would throw a RangeError from push()).
    if (n > this.cap) {
      const skip = n - this.cap;
      const newBase = this.base + this.len + skip;
      const dropped = Math.max(0, newBase - this.cursor);
      data = data.subarray(skip);
      n = data.length;
      this.base = newBase;
      this.len = 0;
      if (this.cursor < newBase) {
        this.cursor = newBase;
        this.lag(dropped, "buffer-full");
      }
    }

    if (this.len + n > this.cap) {
      // Reclaim samples already transcribed.
      const consumed = Math.max(0, Math.min(this.cursor - this.base, this.len));
      if (consumed > 0) {
        this.buf.copyWithin(0, consumed, this.len);
        this.len -= consumed;
        this.base += consumed;
      }
    }

    if (this.len + n > this.cap) {
      // Still no room: transcription is far behind (or the model isn't ready) — drop the oldest audio.
      const drop = this.len + n - this.cap;
      this.buf.copyWithin(0, drop, this.len);
      this.len -= drop;
      this.base += drop;
      if (this.cursor < this.base) {
        const lost = this.base - this.cursor;
        this.cursor = this.base;
        this.lag(lost, "buffer-full");
      }
    }

    this.buf.set(data, this.len);
    this.len += n;
  }

  /** A copy of absolute samples [from, from + count). */
  private slice(from: number, count: number): Float32Array {
    const off = from - this.base;
    return this.buf.slice(off, off + count);
  }

  private pump(): void {
    if (this.busy || !this.ready || this.stopped) return;
    const end = this.base + this.len;
    let avail = end - this.cursor;
    if (avail < this.winSamples) {
      this.catchUp = 0; // caught up
      return;
    }

    if (avail > this.winSamples + this.lagLimit + this.catchUp) {
      const newCursor = end - this.winSamples;
      this.lag(newCursor - this.cursor, "slow-inference");
      this.cursor = newCursor;
      this.catchUp = 0;
      avail = this.winSamples;
    }

    const start = this.cursor;
    const win = this.slice(start, this.winSamples);
    this.cursor = start + this.stepSamples;
    this.busy = true;
    this.task = this.task
      .then(() => this.runWindow(win, start, start + this.stepSamples))
      .catch((err: unknown) => {
        this.onStatus?.({ type: "error", message: err instanceof Error ? err.message : String(err), missedSec: 0 });
      })
      .then(() => {
        this.busy = false;
        this.pump(); // another window may have filled meanwhile
      });
  }

  /** One window: absolute samples [startSample, startSample + pcm.length); the next window starts at `nextStart`. */
  private async runWindow(pcm: Float32Array, startSample: number, nextStart: number): Promise<void> {
    if (this.stopped) return;
    const discontinuous = this.discontinuous;
    this.discontinuous = false;
    const lenSamples = pcm.length;
    const winStartMs = (startSample / SAMPLE_RATE) * 1000;

    const ratio = this.skipSilence ? speechRatio(pcm) : 1;
    if (ratio < MIN_SPEECH_RATIO) {
      this.prevTokens = [];
      this.coveredTo = startSample + lenSamples;
      this.onPartial?.("");
      this.onStatus?.({ type: "silence", startMs: Math.round(winStartMs) });
      return;
    }

    let heard: string;
    try {
      heard = await this.transcribe(pcm);
    } catch (err) {
      if (this.stopped) return;
      // What no other window covers is lost: from where the last window that ran ended (its overlap with this one
      // is in the transcript) to where the next one starts.
      const missed = Math.max(0, nextStart - Math.max(startSample, this.coveredTo));
      this.failed += missed;
      // The next window has nothing to de-duplicate against, and its times mustn't be floored at older ones.
      this.discontinuous = true;
      this.prevTokens = [];
      this.onStatus?.({ type: "error", message: err instanceof Error ? err.message : String(err), missedSec: +(missed / SAMPLE_RATE).toFixed(1) });
      return;
    }
    if (this.stopped) return;
    this.coveredTo = startSample + lenSamples;
    const raw = dropSilenceHallucinations(heard.trim(), ratio);
    this.onPartial?.(raw);
    if (!raw) {
      this.prevTokens = [];
      return;
    }

    const curTokens = tokenize(raw);
    const k = discontinuous ? 0 : overlapJoinLength(this.prevTokens, curTokens, this.maxOverlapTokens);
    this.prevTokens = curTokens;

    // Cut the original string, keeping its punctuation and spacing.
    let text = k >= curTokens.length ? "" : raw.slice(curTokens[k] ? curTokens[k].start : 0).trim();
    text = dropRepeats(collapseLoops(text), this.memory);
    if (!text) return;

    // Window covers [start, start + window]; the k words cut are the first `overlap` seconds, so the text kept
    // belongs to [start + overlap, start + window] and consecutive windows join up. Never go backwards, except
    // after skipped audio.
    const winEndMs = ((startSample + lenSamples) / SAMPLE_RATE) * 1000;
    const offsetMs = discontinuous || k === 0 ? 0 : (this.overlapSamples / SAMPLE_RATE) * 1000;
    const floorMs = discontinuous ? 0 : this.lastEndMs;
    const s = Math.max(Math.round(winStartMs + offsetMs), floorMs);
    const e = Math.max(Math.round(winEndMs), s);
    this.lastEndMs = e;
    this.onFinal?.({ s, e, text });
  }

  /**
   * Transcribes everything still buffered (call after the last push, before stop()). Does nothing when the model
   * never became ready. Resolves when done.
   */
  async flush(): Promise<void> {
    if (!this.ready || this.stopped) return;

    // Finish the window in flight and every full window left. Awaiting once isn't enough: pump() starts the next
    // round from the previous one's then().
    for (;;) {
      await this.task.catch(() => {});
      if (this.stopped) return;
      if (this.busy) continue;
      if (this.base + this.len - this.cursor >= this.winSamples) {
        this.catchUp = Number.POSITIVE_INFINITY; // never jump while flushing
        this.pump();
        continue;
      }
      break;
    }

    // The tail (less than a window). When a window already ran, the first `overlap` of the tail was transcribed
    // with it; only run when there's more than that (any length when nothing ran yet, all of it when that window
    // failed).
    const end = this.base + this.len;
    const tail = end - this.cursor;
    const neverRan = this.cursor === 0;
    const uncovered = end - Math.max(this.cursor, this.coveredTo);
    if (tail >= this.minTail && (neverRan || uncovered > this.minTail)) {
      const start = this.cursor;
      const pcm = this.slice(start, tail);
      this.cursor = end;
      try {
        await this.runWindow(pcm, start, end);
      } catch (err) {
        this.onStatus?.({ type: "error", message: err instanceof Error ? err.message : String(err), missedSec: 0 });
      }
    }
  }

  /** Stops for good: no more windows, results still in flight are ignored, the buffer is released. */
  stop(): void {
    this.stopped = true;
    this.len = 0;
    this.prevTokens = [];
    this.buf = new Float32Array(0);
  }
}

/** How far the tap's audio may fall short of the recording's length before it counts as a gap: 5 s + 0.2%. */
function tapSlackSec(recordedSec: number): number {
  return 5 + recordedSec * 0.002;
}

/**
 * Whether the live transcript covers the whole recording, worked out at Stop: the model was ready, the last windows
 * were transcribed (`flushed`), nothing was skipped to keep up (under a second) or lost to a failed window, and the
 * tap delivered about as much audio as was recorded (a tap that stopped feeding the windower leaves a gap too).
 * `stats`: the windower's numbers at the end, or when the live transcript was turned off (null: there never was
 * one). `missedSec` estimates how much of the meeting isn't in it (0 when complete).
 */
export function liveTranscriptCoverage(
  stats: WindowerStats | null,
  { recordedSec, flushed }: { recordedSec: number; flushed: boolean },
): { complete: boolean; missedSec: number } {
  const recorded = Math.max(0, recordedSec);
  if (!stats) return { complete: false, missedSec: +recorded.toFixed(1) };
  const finished = flushed && stats.ready;
  const notHeard = Math.max(0, recorded - stats.totalSec);
  const complete = finished && stats.droppedSec < 1 && stats.failedSec === 0 && notHeard <= tapSlackSec(recorded);
  if (complete) return { complete, missedSec: 0 };
  const missed = stats.droppedSec + stats.failedSec + (finished ? 0 : stats.pendingSec) + notHeard;
  return { complete, missedSec: +Math.min(recorded, missed).toFixed(1) };
}
