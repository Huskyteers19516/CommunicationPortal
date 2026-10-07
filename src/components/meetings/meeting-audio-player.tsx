"use client";

import { Download, LoaderCircle, Play, RefreshCw, RotateCcw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { cn } from "@/lib/cn";
import { formatFileSize } from "@/lib/files";
import { meetingAudioExtension, normalizeMeetingAudioType } from "@/lib/meeting-recaps";
import { Alert } from "../ui/alert";
import { Button } from "../ui/button";
import { fetchRecording, RECORDING_GONE, RECORDING_LOAD_FAILED, RECORDING_MESSAGES, type RecordingParts } from "./fetch-recording";
import { useMeetingPlayback } from "./playback";
import { fixDuration } from "./recorder/engine/fix-duration";
import { saveFile } from "./save-file";

// Also used by the edit page's "Transcribe the recording again".
export { fetchRecording } from "./fetch-recording";

/** What to play. */
export type MeetingAudioSource =
  /** A saved recap's recording ("ready" MeetingAudioState): its parts, fetched in order and joined in the browser. */
  | RecordingParts
  /** A recording that's already in the browser (the recorder's review step): it plays right away. */
  | { blob: Blob };

const SPEEDS = [0.75, 1, 1.25, 1.5, 2] as const;

const CANT_PLAY = "This browser can't play this recording. Try again, or use another browser or a computer.";

/**
 * A recording to listen to. A saved one loads on "Listen (12 MB)" (the whole file, with progress — a part alone isn't
 * playable, and joining them keeps every request under Vercel's limit) and then plays; a Blob plays right away. WebM
 * from MediaRecorder gets its length found first (fixDuration), so it can be sought. Speeds 0.75×–2× keep the pitch.
 * Inside a MeetingPlaybackProvider it hands its <audio> over once it can play, so key points and transcript lines
 * play from their moment. `downloadName` (a file name without extension, e.g. recapFileBase(…)) adds "Download
 * recording".
 *
 * When it goes wrong: a failed load says why, with "Try again" (or, when the recording was deleted meanwhile, "Show
 * what's left", which refreshes the page). A file this browser can't decode — when it's loaded, or partway through —
 * says so with "Try again" (a fresh player for the same file); its moments then don't play, and the file can still be
 * downloaded.
 */
export function MeetingAudioPlayer({
  source,
  downloadName,
  className,
}: {
  source: MeetingAudioSource;
  downloadName?: string;
  className?: string;
}) {
  const { attachAudio } = useMeetingPlayback();
  const router = useRouter();
  const audioRef = useRef<HTMLAudioElement>(null);
  const [fetched, setFetched] = useState<Blob | null>(null);
  const [loadedBytes, setLoadedBytes] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [readyFor, setReadyFor] = useState<Blob | null>(null);
  // The file this browser couldn't play (its <audio> fired `error`).
  const [failedFor, setFailedFor] = useState<Blob | null>(null);
  // Bumped by "Try again" after a playback error: a fresh <audio> for the same file.
  const [attempt, setAttempt] = useState(0);
  const [rate, setRate] = useState<number>(1);
  const [saving, setSaving] = useState(false);
  const [refreshing, startRefresh] = useTransition();
  const [refreshAsked, setRefreshAsked] = useState(false);
  const rateRef = useRef(1);
  const playWhenReady = useRef(false);
  const loading = useRef<Promise<Blob | null> | null>(null);
  const abort = useRef<AbortController | null>(null);

  const blob = "blob" in source ? source.blob : fetched;
  const cantPlay = !!blob && failedFor === blob;
  const ready = !!blob && readyFor === blob && !cantPlay;
  const audioType = "blob" in source ? (normalizeMeetingAudioType(source.blob.type) ?? "audio/webm") : source.audioType;
  const totalBytes = "blob" in source ? source.blob.size : source.audioBytes;

  // "Show what's left" is done: the page shows the recording as it is now (a player again if it's still kept).
  if (refreshAsked && !refreshing) {
    setRefreshAsked(false);
    setError(null);
  }

  // The file goes into the <audio> through a Blob URL (let go when the file, the attempt, or the player goes).
  useEffect(() => {
    const el = audioRef.current;
    if (!el || !blob) return;
    let live = true;
    // This browser can't decode it (a format it doesn't play, or a damaged file): now, or partway through playing.
    const onError = () => {
      if (!live) return;
      live = false;
      playWhenReady.current = false;
      attachAudio(null);
      el.pause();
      setReadyFor(null);
      setFailedFor(blob);
    };
    el.addEventListener("error", onError);
    const url = URL.createObjectURL(blob);
    el.src = url;
    void fixDuration(el).then((seconds) => {
      if (!live) return;
      // It failed before the listener could hear it, or fixDuration gave up on a file that never loaded.
      if (el.error) {
        onError();
        return;
      }
      el.defaultPlaybackRate = rateRef.current;
      el.playbackRate = rateRef.current;
      el.preservesPitch = true;
      attachAudio(el, seconds > 0 ? seconds * 1000 : null);
      setReadyFor(blob);
      if (playWhenReady.current) {
        playWhenReady.current = false;
        // Refused when loading took long enough for the tap to stop counting (autoplay rules): the controls are there.
        void el.play().catch(() => {});
      }
    });
    return () => {
      live = false;
      // Taking the file out must not count as a playback error.
      el.removeEventListener("error", onError);
      attachAudio(null);
      el.pause();
      el.removeAttribute("src");
      el.load();
      URL.revokeObjectURL(url);
    };
  }, [blob, attempt, attachAudio]);

  useEffect(() => () => abort.current?.abort(), []);

  /** The whole recording (fetched once; a second call while it loads waits for the same one). Null when it failed. */
  function load(): Promise<Blob | null> {
    if (blob) return Promise.resolve(blob);
    if ("blob" in source) return Promise.resolve(source.blob);
    if (loading.current) return loading.current;
    const controller = new AbortController();
    abort.current = controller;
    setError(null);
    setLoadedBytes(0);
    const promise = fetchRecording(source, controller.signal, setLoadedBytes)
      .then((file) => {
        setFetched(file);
        return file;
      })
      .catch((e: unknown) => {
        if (!controller.signal.aborted) {
          setError(e instanceof Error && RECORDING_MESSAGES.has(e.message) ? e.message : RECORDING_LOAD_FAILED);
        }
        playWhenReady.current = false;
        return null;
      })
      .finally(() => {
        loading.current = null;
        setLoadedBytes(null);
      });
    loading.current = promise;
    return promise;
  }

  function listen() {
    playWhenReady.current = true;
    void load();
  }

  /** After a playback error: the same file in a fresh <audio> (a decoder that gave up once may cope the second time). */
  function playAgain() {
    playWhenReady.current = true;
    setFailedFor(null);
    setReadyFor(null);
    setAttempt((n) => n + 1);
  }

  /** The recording was deleted meanwhile: refresh the page, which then says so (or offers it again if it's still kept). */
  function showWhatsLeft() {
    setRefreshAsked(true);
    startRefresh(() => router.refresh());
  }

  async function download() {
    if (!downloadName || saving) return;
    setSaving(true);
    const file = await load();
    setSaving(false);
    if (file) saveFile(file, `${downloadName}.${meetingAudioExtension(audioType)}`);
  }

  function changeSpeed(speed: number) {
    rateRef.current = speed;
    setRate(speed);
    const el = audioRef.current;
    if (!el) return;
    el.defaultPlaybackRate = speed;
    el.playbackRate = speed;
    el.preservesPitch = true;
  }

  const pct = loadedBytes === null || totalBytes <= 0 ? 0 : Math.min(100, Math.round((loadedBytes / totalBytes) * 100));

  return (
    <div className={cn("space-y-3", className)}>
      {!blob &&
        (loadedBytes !== null ? (
          <div className="space-y-1.5">
            <p role="status" className="flex items-center gap-2 text-sm text-ink-600">
              <LoaderCircle className="size-4 animate-spin text-brand-600" aria-hidden />
              Loading the recording… {pct}%
            </p>
            <div
              className="h-2 overflow-hidden rounded-full bg-ink-100"
              role="progressbar"
              aria-label="Loading the recording"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={pct}
            >
              <div className="h-full bg-brand-500 transition-[width]" style={{ width: `${pct}%` }} />
            </div>
          </div>
        ) : (
          // After an error, the message below says what to do instead.
          !error && (
            <Button onClick={listen}>
              <Play className="size-4" aria-hidden />
              Listen ({formatFileSize(totalBytes)})
            </Button>
          )
        ))}

      {error && !blob && (
        <Alert tone="error">
          <p>{error}</p>
          {error === RECORDING_GONE ? (
            <Button
              variant="secondary"
              className={cn("mt-2", refreshing && "cursor-wait opacity-60")}
              onClick={showWhatsLeft}
              aria-busy={refreshing}
            >
              {refreshing ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : <RefreshCw className="size-4" aria-hidden />}
              Show what&apos;s left
            </Button>
          ) : (
            <Button variant="secondary" className="mt-2" onClick={listen}>
              <RotateCcw className="size-4" aria-hidden />
              Try again
            </Button>
          )}
        </Alert>
      )}

      {blob && (
        <>
          {/* Hidden until its length is known (finding it scans the file, which moves the position around). */}
          <audio key={attempt} ref={audioRef} controls preload="auto" className={cn("w-full", !ready && "hidden")}>
            Your browser can&apos;t play this recording. Download it to listen.
          </audio>
          {cantPlay ? (
            <Alert tone="error">
              <p>
                {CANT_PLAY}
                {downloadName && " You can also download it and play it in another app."}
              </p>
              <Button variant="secondary" className="mt-2" onClick={playAgain}>
                <RotateCcw className="size-4" aria-hidden />
                Try again
              </Button>
            </Alert>
          ) : (
            !ready && (
              <p role="status" className="flex items-center gap-2 text-sm text-ink-600">
                <LoaderCircle className="size-4 animate-spin text-brand-600" aria-hidden />
                Getting the recording ready…
              </p>
            )
          )}
          {ready && (
            <div role="group" aria-label="Playback speed" className="flex flex-wrap items-center gap-1.5">
              <span className="mr-1 text-xs font-medium text-ink-500" aria-hidden>
                Speed
              </span>
              {SPEEDS.map((speed) => (
                <button
                  key={speed}
                  type="button"
                  aria-pressed={rate === speed}
                  onClick={() => changeSpeed(speed)}
                  className={cn(
                    "h-10 min-w-12 rounded-lg border px-2 text-sm font-medium tabular-nums transition-colors",
                    rate === speed ? "border-brand-500 bg-brand-50 text-brand-800" : "border-ink-200 bg-white text-ink-700 hover:bg-ink-50",
                  )}
                >
                  {speed}×
                </button>
              ))}
            </div>
          )}
        </>
      )}

      {downloadName && (
        <Button variant="secondary" onClick={download} aria-busy={saving} className={cn(saving && "cursor-wait opacity-60")}>
          {saving ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : <Download className="size-4" aria-hidden />}
          Download recording
        </Button>
      )}
    </div>
  );
}
