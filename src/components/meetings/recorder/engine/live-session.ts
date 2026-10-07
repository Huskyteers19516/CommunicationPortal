// The meeting recorder's engine: records a meeting in the browser, transcribes it live on this computer, and keeps
// a crash-safe copy as it goes. Ported from VoiceCollector's recording flow (app.js). Browser only; no React.
//
// ── MeetingRecorder ───────────────────────────────────────────────────────────────────────────────────────────
//   const rec = new MeetingRecorder({ liveTranscript: true, asr, onState, onSegment, onPartial, onStatus, onLevel, onError });
//   await rec.start();          // from the Start click (opens the microphone); idempotent
//   rec.pause(); rec.resume();  // paused time is left out of the recording and of every timestamp
//   rec.mark();                 // "Mark key moment" → ms into the meeting
//   const result = await rec.stop();   // idempotent: { recordingId, blob, audioType, mime, durationMs, segments, marks,
//                                      //   liveTranscriptComplete, liveTranscriptMissedSec }
//   rec.destroy();              // unmount: stops everything, keeps the IndexedDB copy (recoverable)
//   await rec.discard();        // stops everything and deletes the IndexedDB copy
//
//   - The recording never waits for the model: MediaRecorder (24 kbps, a chunk every 5 s) and the 16 kHz tap start
//     together; the live transcript buffers audio until `asr.load()` finishes (downloads included) and catches up.
//   - Every chunk goes to IndexedDB as it arrives; the recording doc (transcript so far, marks, duration) is saved
//     3 s after each change, every 10 s (heartbeat), and right away on pause, mark and stop. See recorder-db.ts.
//   - Stops by itself after 3 hours (status "auto-stop"; call stop() to get the result). A microphone that
//     disappears also stops it (onError first).
//   - Keeps the screen on, and warns before the tab is closed while recording.
//   - `asr` belongs to the caller (it may be preloaded and is reused afterwards): the recorder never disposes it.
//   - `liveTranscriptComplete` is false whenever the live transcript doesn't cover the whole recording: it was off,
//     the model never got ready, it fell behind and skipped audio, a window failed (status "live-gap"), it stopped,
//     or Stop couldn't wait for the last windows. Then offer "Transcribe the whole recording" (transcribeBlob).
//     `liveTranscriptMissedSec` says about how much is missing (the whole length when there was no live transcript;
//     0 when complete). Both are saved in the IndexedDB doc too.
//
// ── transcribeBlob ────────────────────────────────────────────────────────────────────────────────────────────
//   const segments = await transcribeBlob(blob, { asr, onProgress, signal });
//   An uploaded file, or the recording after Stop when the live transcript was off or incomplete: decodes to
//   16 kHz, transcribes ~4-minute pieces (cut at quiet moments) with timestamps, drops silence hallucinations,
//   cleans loops and repeats, and joins the pieces into sentence segments { s, e, text } (ms).

import { MEETING_RECORDING_MAX_MS, type MeetingAudioType, normalizeMeetingAudioType } from "@/lib/meeting-recaps";
import { liveTranscriptCoverage, StreamWindower, type WindowerStats, type WindowerStatus } from "@/lib/meeting-recorder/stream-windower";
import {
  type AsrChunk,
  chunksToSegments,
  cleanTranscript,
  dropSilenceHallucinations,
  splitSegmentSentences,
  type TimedSegment,
} from "@/lib/meeting-recorder/transcript-text";
import { pieceRanges, SAMPLE_RATE, speechBlocks, speechShare } from "@/lib/meeting-recorder/vad";
import type { AsrClient, AsrResult, AsrStatus, AsrStatusDetail } from "./asr-client";
import { blobToPcm16k } from "./decode";
import { createRecorder, type OpenMic, openMic, pickMime, RECORDING_TIMESLICE_MS } from "./mic";
import { PcmTap } from "./pcm-tap";
import { openRecorderDb, type RecorderDb, type RecordingDoc, requestPersistentStorage } from "./recorder-db";
import { createScreenWakeLock, type ScreenWakeLock } from "./wake-lock";

export type { TimedSegment };

export type RecorderState = "idle" | "starting" | "recording" | "paused" | "stopping" | "stopped" | "failed";

export type RecorderStatus =
  /** The speech model, passed through from the AsrClient while the live transcript waits for it. */
  | { type: "model"; status: AsrStatus; detail: AsrStatusDetail }
  /** The live transcript skipped audio to keep up (the recording itself is complete). */
  | { type: "lagging"; droppedSec: number; reason: "buffer-full" | "slow-inference" }
  /** The speech model failed on one window, so about `missedSec` is missing from the live transcript (the audio is fine). */
  | { type: "live-gap"; missedSec: number; message: string }
  /** No live transcript for this recording (turned off, not possible here, or it failed); the audio is fine. */
  | { type: "live-transcript-off"; reason: "disabled" | "unavailable" | "failed"; message: string }
  /** Crash protection: false = this browser can't save the recording as it goes (memory only). */
  | { type: "storage"; persistent: boolean; message?: string }
  /** Hit the length limit: stopping. Call stop() for the result. */
  | { type: "auto-stop"; afterMs: number };

export type RecorderResult = {
  recordingId: string;
  blob: Blob;
  /** The portal's name for the format, or null when the browser made one the portal doesn't keep. */
  audioType: MeetingAudioType | null;
  /** MediaRecorder's own type, e.g. "audio/webm;codecs=opus". */
  mime: string;
  durationMs: number;
  segments: TimedSegment[];
  marks: number[];
  /** Whether the live transcript covers the whole recording; if not, offer to transcribe the audio. */
  liveTranscriptComplete: boolean;
  /** About how much of the recording the live transcript missed, in seconds (0 when complete). */
  liveTranscriptMissedSec: number;
};

export type MeetingRecorderOptions = {
  deviceId?: string;
  /** Transcribe while recording (default true). Off: the audio is transcribed after Stop, if at all. */
  liveTranscript?: boolean;
  /** The speech model (needed for the live transcript). Owned by the caller. */
  asr?: AsrClient | null;
  /** The crash-protection store (default: openRecorderDb()). */
  db?: RecorderDb | null;
  /** Auto-stop after this much recorded time (default MEETING_RECORDING_MAX_MS, 3 h). */
  maxDurationMs?: number;
  /** Warn before closing the tab while recording (default true). */
  guardUnload?: boolean;
  /** How long Stop waits for the live transcript to finish (default 2 minutes). */
  flushTimeoutMs?: number;
  onState?: (state: RecorderState) => void;
  /** A new transcript line (a sentence of a finished window). */
  onSegment?: (segment: TimedSegment) => void;
  /** What the model is hearing right now (raw, may repeat words; "" clears it). */
  onPartial?: (text: string) => void;
  onStatus?: (status: RecorderStatus) => void;
  /** Microphone level 0–1, about 8 times a second while the tab is visible. */
  onLevel?: (level: number) => void;
  /** Something stopped the recording or start() failed; a message for people. */
  onError?: (message: string) => void;
};

const DOC_DEBOUNCE_MS = 3000;
const HEARTBEAT_MS = 10_000;
const LEVEL_MS = 125;
/** Consecutive failed windows before the live transcript gives up. */
const MAX_WINDOW_FAILURES = 3;

function newId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `rec-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function message(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

export class MeetingRecorder {
  readonly recordingId = newId();
  private readonly opts: MeetingRecorderOptions;
  private currentState: RecorderState = "idle";
  private startPromise: Promise<void> | null = null;
  private stopPromise: Promise<RecorderResult> | null = null;
  private destroyed = false;

  private mic: OpenMic | null = null;
  private recorder: MediaRecorder | null = null;
  private mime = "";
  private readonly chunks: Blob[] = [];
  private seq = 0;
  private tap: PcmTap | null = null;
  private windower: StreamWindower | null = null;
  private liveOff = false;
  /** The windower's numbers when the live transcript was turned off (null: never had one). */
  private liveStats: WindowerStats | null = null;
  private windowFailures = 0;
  private reloadedModel = false;
  private asrUnsubscribe: (() => void) | null = null;
  private readonly wakeLock: ScreenWakeLock | null = typeof document !== "undefined" ? createScreenWakeLock() : null;

  private startedAt = 0; // Date.now()
  private t0 = 0; // performance.now()
  private pausedMs = 0;
  private pauseAt = 0;
  private finalMs: number | null = null;
  private readonly segments: TimedSegment[] = [];
  private readonly markList: number[] = [];

  private db: Promise<RecorderDb> | null = null;
  private writes: Promise<unknown> = Promise.resolve();
  private storageWarned = false;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private tickTimer: ReturnType<typeof setInterval> | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private levelTimer: ReturnType<typeof setInterval> | undefined;
  private levelZeroed = false;

  constructor(opts: MeetingRecorderOptions = {}) {
    this.opts = opts;
  }

  get state(): RecorderState {
    return this.currentState;
  }

  /** The transcript so far (a copy). */
  get transcript(): TimedSegment[] {
    return this.segments.slice();
  }

  get marks(): number[] {
    return this.markList.slice();
  }

  /** Recorded time so far in ms (paused time left out). */
  elapsedMs(): number {
    if (this.finalMs !== null) return this.finalMs;
    if (!this.t0) return 0;
    const now = performance.now();
    return Math.max(0, now - this.t0 - this.pausedMs - (this.currentState === "paused" ? now - this.pauseAt : 0));
  }

  private setState(state: RecorderState) {
    if (this.currentState === state) return;
    this.currentState = state;
    this.opts.onState?.(state);
  }

  private emit(status: RecorderStatus) {
    try {
      this.opts.onStatus?.(status);
    } catch {
      // the page's problem
    }
  }

  // ── start ────────────────────────────────────────────────────────────────────────────────────────────────────

  /** Opens the microphone and starts recording. Call from the Start click. Idempotent; a stopped recorder can't restart. */
  start(): Promise<void> {
    if (!this.startPromise) this.startPromise = this.doStart();
    return this.startPromise;
  }

  private async doStart(): Promise<void> {
    if (this.destroyed || this.stopPromise) throw new Error("This recorder was already used.");
    this.setState("starting");
    let mic: OpenMic;
    try {
      mic = await openMic({ deviceId: this.opts.deviceId }); // first: the click's user activation
    } catch (err) {
      this.setState("failed");
      const msg = message(err, "Couldn't start the microphone.");
      this.opts.onError?.(msg);
      throw err instanceof Error ? err : new Error(msg);
    }
    if (this.destroyed) {
      mic.close();
      return;
    }
    this.mic = mic;

    let recorder: MediaRecorder;
    try {
      recorder = createRecorder(mic.stream, pickMime());
    } catch {
      mic.close();
      this.mic = null;
      this.setState("failed");
      const msg = "This browser can't record audio. Try Chrome, Edge or Safari on a computer.";
      this.opts.onError?.(msg);
      throw new Error(msg);
    }
    this.recorder = recorder;
    recorder.ondataavailable = (e) => {
      if (!e.data || !e.data.size) return;
      this.chunks.push(e.data);
      const seq = this.seq++;
      this.persist((db) => db.putChunk(this.recordingId, seq, e.data));
    };
    recorder.onerror = () => this.interrupt("The recording stopped unexpectedly. What was recorded until then is kept.");
    for (const track of mic.stream.getAudioTracks()) {
      track.addEventListener("ended", () => this.interrupt("The microphone was disconnected. What was recorded until then is kept."));
    }
    recorder.start(RECORDING_TIMESLICE_MS);
    this.mime = recorder.mimeType || pickMime() || "audio/webm";
    this.startedAt = Date.now();
    this.t0 = performance.now();
    this.setState("recording");

    // Everything below helps but never holds up the recording.
    this.db = this.opts.db ? Promise.resolve(this.opts.db) : openRecorderDb();
    void this.db.then((db) => {
      if (!db.persistent) this.storageLost();
      else if (!this.storageWarned) this.emit({ type: "storage", persistent: true });
    });
    void requestPersistentStorage();
    this.saveNow();
    void this.wakeLock?.acquire();
    if (this.opts.guardUnload !== false) window.addEventListener("beforeunload", this.onBeforeUnload);
    this.tickTimer = setInterval(() => this.tick(), 1000);
    this.heartbeatTimer = setInterval(() => this.saveNow(), HEARTBEAT_MS);
    if (this.opts.onLevel) this.levelTimer = setInterval(() => this.pollLevel(), LEVEL_MS);
    this.startLiveTranscript(mic);
  }

  private startLiveTranscript(mic: OpenMic) {
    const asr = this.opts.asr;
    if (this.opts.liveTranscript === false || !asr) {
      this.turnLiveOff("disabled", "Live transcript is off. You can transcribe the recording after you stop.");
      return;
    }
    const windower = new StreamWindower({
      transcribe: (pcm) => this.transcribeWindow(pcm),
      onFinal: (seg) => this.addFinal(seg),
      onPartial: (text) => this.opts.onPartial?.(text),
      onStatus: (s) => this.onWindowerStatus(s),
    });
    this.windower = windower;
    this.tap = new PcmTap(mic.ctx, mic.source, {
      onSamples: (samples) => {
        if (this.currentState === "recording") windower.push(samples);
      },
    });
    void this.tap.connect().then((ok) => {
      if (!ok) this.turnLiveOff("unavailable", "Live transcript isn't available in this browser. You can transcribe the recording after you stop.");
    });
    this.asrUnsubscribe = asr.subscribe((status, detail) => this.emit({ type: "model", status, detail }));
    if (asr.ready) windower.setReady();
    else {
      asr.load().then(
        () => windower.setReady(),
        (err) =>
          this.turnLiveOff(
            "failed",
            `The speech model couldn't start (${message(err, "unknown error")}). The recording continues — you can transcribe it after you stop.`,
          ),
      );
    }
  }

  private async transcribeWindow(pcm: Float32Array): Promise<string> {
    const asr = this.opts.asr;
    if (!asr || this.liveOff) return "";
    try {
      if (!asr.ready && !this.reloadedModel) {
        // A stuck window stops the worker; give the model one more start.
        this.reloadedModel = true;
        await asr.load();
      }
      const { text } = await asr.transcribe(pcm, { timestamps: false });
      this.windowFailures = 0;
      return text;
    } catch (err) {
      if (++this.windowFailures >= MAX_WINDOW_FAILURES) {
        this.turnLiveOff("failed", `The live transcript stopped (${message(err, "unknown error")}). The recording continues — you can transcribe it after you stop.`);
      }
      throw err;
    }
  }

  private onWindowerStatus(s: WindowerStatus) {
    if (s.type === "lagging") this.emit({ type: "lagging", droppedSec: s.droppedSec, reason: s.reason });
    else if (s.type === "error" && s.missedSec > 0 && !this.liveOff) {
      this.emit({
        type: "live-gap",
        missedSec: s.missedSec,
        message: `The speech model had a problem, so about ${Math.max(1, Math.round(s.missedSec))} s is missing from the live transcript. The recording itself is fine — you can transcribe it after you stop.`,
      });
    }
  }

  private turnLiveOff(reason: "disabled" | "unavailable" | "failed", text: string) {
    if (this.liveOff) return;
    this.liveOff = true;
    this.liveStats = this.windower?.stats() ?? null;
    this.tap?.disconnect();
    this.tap = null;
    this.windower?.stop();
    this.windower = null;
    this.asrUnsubscribe?.();
    this.asrUnsubscribe = null;
    this.opts.onPartial?.("");
    this.emit({ type: "live-transcript-off", reason, message: text });
  }

  private addFinal(seg: TimedSegment) {
    if (this.destroyed) return;
    for (const line of splitSegmentSentences(seg)) {
      this.segments.push(line);
      try {
        this.opts.onSegment?.(line);
      } catch {
        // the page's problem
      }
    }
    this.scheduleSave();
  }

  // ── during the recording ─────────────────────────────────────────────────────────────────────────────────────

  pause(): void {
    if (this.currentState !== "recording" || !this.recorder) return;
    try {
      if (this.recorder.state === "recording") this.recorder.pause();
    } catch {
      // keep the state in step anyway
    }
    this.tap?.pause();
    this.pauseAt = performance.now();
    this.setState("paused");
    this.opts.onPartial?.("");
    this.saveNow();
  }

  resume(): void {
    if (this.currentState !== "paused" || !this.recorder) return;
    try {
      if (this.recorder.state === "paused") this.recorder.resume();
    } catch {
      // keep the state in step anyway
    }
    this.tap?.resume();
    this.pausedMs += performance.now() - this.pauseAt;
    this.setState("recording");
    this.saveNow();
  }

  /** "Mark key moment": remembers this moment (ms into the meeting) for the key points. Null when not recording. */
  mark(): number | null {
    if (this.currentState !== "recording" && this.currentState !== "paused") return null;
    const at = Math.round(this.elapsedMs());
    this.markList.push(at);
    this.saveNow();
    return at;
  }

  private tick() {
    const max = this.opts.maxDurationMs ?? MEETING_RECORDING_MAX_MS;
    if (this.currentState === "recording" && this.elapsedMs() >= max) {
      this.emit({ type: "auto-stop", afterMs: max });
      void this.stop().catch(() => {});
    }
  }

  private pollLevel() {
    if (typeof document !== "undefined" && document.hidden) {
      if (!this.levelZeroed) this.opts.onLevel?.(0);
      this.levelZeroed = true;
      return;
    }
    this.levelZeroed = false;
    this.opts.onLevel?.(this.currentState === "recording" ? (this.mic?.level() ?? 0) : 0);
  }

  private interrupt(text: string) {
    if (this.currentState !== "recording" && this.currentState !== "paused") return;
    this.opts.onError?.(text);
    void this.stop().catch(() => {});
  }

  private readonly onBeforeUnload = (e: BeforeUnloadEvent) => {
    if (this.currentState === "starting" || this.currentState === "recording" || this.currentState === "paused" || this.currentState === "stopping") {
      e.preventDefault();
      e.returnValue = "";
    }
  };

  // ── saving as it goes ────────────────────────────────────────────────────────────────────────────────────────

  private storageLost() {
    if (this.storageWarned) return;
    this.storageWarned = true;
    this.emit({
      type: "storage",
      persistent: false,
      message: "This browser can't save the recording as it goes, so keep this tab open until it's saved.",
    });
  }

  /** Queues a write (in order, after the store opens); a failed write turns crash protection off. */
  private persist(write: (db: RecorderDb) => Promise<boolean>) {
    const db = this.db;
    if (!db) return;
    this.writes = this.writes.then(async () => {
      const store = await db;
      if (!(await write(store).catch(() => false)) || !store.persistent) this.storageLost();
    });
  }

  private doc(status: RecordingDoc["status"], extra: Partial<RecordingDoc> = {}): RecordingDoc {
    return {
      id: this.recordingId,
      status,
      startedAt: this.startedAt,
      heartbeatAt: Date.now(),
      durationMs: Math.round(this.elapsedMs()),
      mime: this.mime,
      segments: this.segments.slice(),
      marks: this.markList.slice(),
      ...extra,
    };
  }

  private scheduleSave() {
    if (this.saveTimer || this.currentState === "stopped") return;
    this.saveTimer = setTimeout(() => this.saveNow(), DOC_DEBOUNCE_MS);
  }

  private saveNow() {
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    if (this.currentState !== "recording" && this.currentState !== "paused") return;
    const doc = this.doc("recording");
    this.persist((db) => db.putRecording(doc));
  }

  // ── stop ─────────────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * Stops recording, finishes the live transcript (up to flushTimeoutMs), waits for the crash-safe copy, and
   * resolves with the recording. Idempotent: an auto-stop or a lost microphone calls it too — call it to get the
   * same result.
   */
  stop(): Promise<RecorderResult> {
    if (!this.stopPromise) this.stopPromise = this.doStop();
    return this.stopPromise;
  }

  private async doStop(): Promise<RecorderResult> {
    await this.startPromise?.catch(() => {});
    const recorder = this.recorder;
    if (!recorder || this.destroyed) throw new Error("Nothing was recorded.");
    this.finalMs = Math.round(this.elapsedMs());
    this.setState("stopping");
    this.opts.onPartial?.("");
    clearInterval(this.tickTimer);
    clearInterval(this.heartbeatTimer);
    clearInterval(this.levelTimer);
    clearTimeout(this.saveTimer);

    // The last chunk arrives before "stop".
    await new Promise<void>((resolve) => {
      if (recorder.state === "inactive") return resolve();
      recorder.addEventListener("stop", () => resolve(), { once: true });
      try {
        recorder.stop();
      } catch {
        resolve();
      }
    });
    this.tap?.disconnect();
    this.tap = null;
    this.mic?.close(); // frees the microphone right away

    let flushed = false;
    let stats = this.liveStats;
    const windower = this.windower;
    if (windower && !this.liveOff) {
      flushed = await Promise.race([
        windower.flush().then(() => true),
        new Promise<boolean>((r) => setTimeout(() => r(false), this.opts.flushTimeoutMs ?? 120_000)),
      ]);
      // Turned off during the flush (the model failed again): its numbers from then.
      stats = this.liveOff ? this.liveStats : windower.stats();
      windower.stop();
    }
    this.windower = null;
    this.asrUnsubscribe?.();
    this.asrUnsubscribe = null;
    const coverage = liveTranscriptCoverage(stats, { recordedSec: this.finalMs / 1000, flushed: flushed && !this.liveOff });
    const liveComplete = coverage.complete;

    const blob = new Blob(this.chunks, { type: recorder.mimeType || this.mime });
    const doc = this.doc("stopped", {
      durationMs: this.finalMs,
      liveTranscriptComplete: liveComplete,
      liveTranscriptMissedSec: coverage.missedSec,
    });
    this.persist((db) => db.putRecording(doc));
    await this.writes;
    this.wakeLock?.release();
    window.removeEventListener("beforeunload", this.onBeforeUnload);
    this.setState("stopped");
    return {
      recordingId: this.recordingId,
      blob,
      audioType: normalizeMeetingAudioType(blob.type || this.mime),
      mime: blob.type || this.mime,
      durationMs: this.finalMs,
      segments: this.segments.slice(),
      marks: this.markList.slice(),
      liveTranscriptComplete: liveComplete,
      liveTranscriptMissedSec: coverage.missedSec,
    };
  }

  // ── leaving ──────────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * Stops everything without a result (the component unmounted). The IndexedDB copy stays, so the recording can be
   * recovered from the recorder page. Safe to call any time, any number of times.
   */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    clearInterval(this.tickTimer);
    clearInterval(this.heartbeatTimer);
    clearInterval(this.levelTimer);
    clearTimeout(this.saveTimer);
    if (this.currentState === "recording" || this.currentState === "paused") {
      // A last save, so the copy has the transcript up to now (it will look interrupted, as it was).
      this.persist((db) => db.putRecording(this.doc("recording")));
    }
    try {
      if (this.recorder && this.recorder.state !== "inactive") this.recorder.stop();
    } catch {
      // already stopped
    }
    this.tap?.disconnect();
    this.tap = null;
    this.windower?.stop();
    this.windower = null;
    this.asrUnsubscribe?.();
    this.asrUnsubscribe = null;
    this.mic?.close();
    this.wakeLock?.release();
    if (typeof window !== "undefined") window.removeEventListener("beforeunload", this.onBeforeUnload);
    if (this.currentState !== "stopped" && this.currentState !== "failed") this.setState("stopped");
  }

  /** Stops everything and deletes this recording's IndexedDB copy ("Discard"). */
  async discard(): Promise<void> {
    this.destroy();
    await this.writes.catch(() => {});
    const db = await (this.db ?? Promise.resolve(this.opts.db ?? null));
    await db?.deleteRecording(this.recordingId);
  }
}

// ── whole-file transcription ─────────────────────────────────────────────────────────────────────────────────

export type TranscribeProgress =
  | { phase: "decoding" }
  /** The speech model is downloading or loading (detail.pct etc., see AsrStatus). */
  | { phase: "model"; status: AsrStatus; detail: AsrStatusDetail }
  /** `done` of `total` pieces (~4 minutes each) finished; `pct` 0–100; `audioSec` = the recording's length. */
  | { phase: "transcribing"; done: number; total: number; pct: number; audioSec: number };

/** Each ~4-minute piece may take this long per second of audio (a slow CPU), and at least 10 minutes. */
const PIECE_SEC_TIMEOUT_MS = 5000;

/**
 * Transcribes a whole recording on this computer → sentence segments { s, e, text } (ms from the start). Throws an
 * Error with a message for people (file too big or long, can't decode, model failed) or an "AbortError" DOMException
 * when `signal` aborts. A piece whose worker got stuck is retried once after reloading the model.
 */
export async function transcribeBlob(
  blob: Blob,
  opts: { asr: AsrClient; onProgress?: (p: TranscribeProgress) => void; signal?: AbortSignal },
): Promise<TimedSegment[]> {
  const { asr, onProgress, signal } = opts;
  const check = () => {
    if (signal?.aborted) throw new DOMException("The transcription was stopped.", "AbortError");
  };
  onProgress?.({ phase: "decoding" });
  const pcm = await blobToPcm16k(blob);
  check();
  const audioSec = pcm.length / SAMPLE_RATE;
  if (audioSec < 0.4) return [];
  // Worked out before any samples go to the worker: which seconds have speech (for the hallucination filter).
  const speech = speechBlocks(pcm);

  const unsubscribe = asr.subscribe((status, detail) => onProgress?.({ phase: "model", status, detail }));
  try {
    await asr.load();
  } finally {
    unsubscribe();
  }
  check();

  const ranges = pieceRanges(pcm);
  const chunks: AsrChunk[] = [];
  for (let i = 0; i < ranges.length; i++) {
    check();
    const [start, end] = ranges[i];
    onProgress?.({ phase: "transcribing", done: i, total: ranges.length, pct: Math.round((start / pcm.length) * 100), audioSec });
    const timeoutMs = Math.max(600_000, ((end - start) / SAMPLE_RATE) * PIECE_SEC_TIMEOUT_MS);
    let result: AsrResult;
    try {
      result = await asr.transcribe(pcm.slice(start, end), { timestamps: true, timeoutMs });
    } catch (err) {
      if (asr.ready) throw err;
      await asr.load(); // the worker was stopped (stuck): one more try
      check();
      result = await asr.transcribe(pcm.slice(start, end), { timestamps: true, timeoutMs });
    }
    const offset = start / SAMPLE_RATE;
    const pieceEnd = end / SAMPLE_RATE;
    if (!result.chunks.length && result.text.trim()) result.chunks = [{ text: result.text, timestamp: [0, null] }];
    for (const c of result.chunks) {
      const s = offset + (Number(c.timestamp[0]) || 0);
      const e = c.timestamp[1] === null ? pieceEnd : Math.min(pieceEnd, offset + Number(c.timestamp[1]));
      const text = dropSilenceHallucinations(String(c.text || ""), speechShare(speech, s, Math.max(e, s + 0.5)));
      if (text) chunks.push({ text: ` ${text}`, timestamp: [s, e] });
    }
  }
  onProgress?.({ phase: "transcribing", done: ranges.length, total: ranges.length, pct: 100, audioSec });
  return chunksToSegments(cleanTranscript({ text: "", chunks }).chunks);
}
