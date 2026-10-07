"use client";

import { AudioLines, LoaderCircle, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { MeetingAudioType } from "@/lib/meeting-recaps";
import { appendKeyPoints, suggestKeyPoints, transcribeProgressText, transcriptSegments } from "@/lib/meeting-recorder/recorder-ui";
import { formatClock, formatTranscript, parseKeyPointLines } from "@/lib/meeting-recorder/transcript-format";
import { Button } from "../ui/button";
import { fetchRecording } from "./meeting-audio-player";
import { useMeetingRecapDraft } from "./meeting-recap-form";
import { AsrClient } from "./recorder/engine/asr-client";
import {
  prepareSummarizer,
  summarizerAvailability,
  summarizeTranscript,
  type SummarizerAvailability,
} from "./recorder/engine/chrome-summarizer";
import { type TranscribeProgress, transcribeBlob } from "./recorder/engine/live-session";
import { DownloadBar } from "./recorder/recorder-setup";

// Tools on a recap's edit page (MeetingRecapForm's keyPointsActions / transcriptActions; they reach the fields with
// useMeetingRecapDraft): "Suggest key points" from the transcript in the box, and, while the recording is kept,
// "Transcribe the recording again" on this computer. Neither changes anything until the person picks what to do
// with the result (nothing is saved until "Save changes").

function errorText(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

/** The latest form fields, for code that runs after an await. */
function useLatestDraft() {
  const draft = useMeetingRecapDraft();
  const latest = useRef(draft);
  useEffect(() => {
    latest.current = draft;
  });
  return { draft, latest };
}

/**
 * "Suggest key points": drafted from the transcript box (the recorder's extractive key points — decisions, to-dos with
 * owners from `roster` — plus Chrome's on-device summary when this browser has it ready). Empty key points are filled
 * right away; otherwise the suggestion is shown first, to replace the key points or go under them.
 */
export function SuggestKeyPointsTool({ roster }: { roster: string[] }) {
  const { draft, latest } = useLatestDraft();
  const [availability, setAvailability] = useState<SummarizerAvailability | null>(null);
  const [working, setWorking] = useState<{ done: number; total: number } | "drafting" | null>(null);
  const [suggestion, setSuggestion] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const skip = useRef<AbortController | null>(null);

  useEffect(() => {
    let active = true;
    void summarizerAvailability().then((a) => {
      if (active) setAvailability(a);
    });
    const ref = skip;
    return () => {
      active = false;
      ref.current?.abort();
    };
  }, []);

  async function suggest() {
    // First, while the click still counts: Chrome's summarizer (only when its model is here already).
    const handle = availability === "available" ? prepareSummarizer("available") : null;
    const transcript = latest.current?.values.transcript ?? "";
    setSuggestion(null);
    if (!transcriptSegments(transcript).segments.length) {
      void handle?.then((s) => s?.destroy?.());
      setMessage("There's no transcript to draft key points from. Add one first, or type the key points.");
      return;
    }
    setMessage(null);
    let bullets: string[] | null = null;
    if (handle) {
      const controller = new AbortController();
      skip.current = controller;
      setWorking({ done: 0, total: 1 });
      const skipped = new Promise<null>((resolve) => controller.signal.addEventListener("abort", () => resolve(null), { once: true }));
      bullets = await Promise.race([
        summarizeTranscript(handle, transcriptSegments(transcript).segments, {
          signal: controller.signal,
          onProgress: (done, total) => {
            if (!controller.signal.aborted) setWorking({ done, total });
          },
        }),
        skipped,
      ]);
      skip.current = null;
    }
    setWorking("drafting");
    const text = suggestKeyPoints(transcript, { roster, bullets });
    setWorking(null);
    const current = latest.current;
    if (!text) {
      setMessage("No key points stood out in the transcript. Type them instead.");
      return;
    }
    const count = parseKeyPointLines(text).length;
    if (current && !current.values.keyPoints.trim()) {
      current.update({ keyPoints: text });
      setMessage(`Added ${count} suggested key ${count === 1 ? "point" : "points"}. Check them before saving.`);
      return;
    }
    setSuggestion(text);
  }

  function apply(mode: "replace" | "append") {
    if (!draft || !suggestion) return;
    draft.update({ keyPoints: mode === "replace" ? suggestion : appendKeyPoints(draft.values.keyPoints, suggestion) });
    setSuggestion(null);
    setMessage(
      mode === "replace" ? "Key points replaced. Check them before saving." : "Added under the key points. Check them before saving.",
    );
  }

  const points = suggestion ? parseKeyPointLines(suggestion) : [];
  return (
    <>
      <Button variant="secondary" onClick={() => void suggest()} disabled={!draft || working !== null} aria-busy={working !== null}>
        {working !== null ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : <Sparkles className="size-4" aria-hidden />}
        Suggest key points
      </Button>
      <div role="status" className="basis-full space-y-2 text-sm empty:hidden">
        {working !== null && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-ink-600">
            <span>
              {working === "drafting"
                ? "Drafting key points…"
                : `Drafting key points with Chrome's on-device summary… (part ${Math.min(working.done + 1, working.total)} of ${working.total})`}
            </span>
            {working !== "drafting" && (
              <Button variant="ghost" onClick={() => skip.current?.abort()}>
                Skip the summary
              </Button>
            )}
          </div>
        )}
        {message && <p className="text-ink-600">{message}</p>}
      </div>
      {suggestion && (
        <div className="basis-full space-y-3 rounded-lg border border-brand-200 bg-brand-50/60 p-3">
          <p className="text-sm font-medium text-ink-900">
            Suggested key points ({points.length}) — they don&apos;t change anything until you pick:
          </p>
          <ul className="list-disc space-y-1 pl-5 text-sm text-ink-800">
            {points.map((p, i) => (
              <li key={i} className="wrap-anywhere">
                {p.atMs !== null && <span className="mr-1.5 font-mono text-xs text-ink-500 tabular-nums">{formatClock(p.atMs)}</span>}
                {p.text}
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => apply("replace")}>Replace the key points</Button>
            <Button variant="secondary" onClick={() => apply("append")}>
              Add them below
            </Button>
            <Button variant="ghost" onClick={() => setSuggestion(null)}>
              Dismiss
            </Button>
          </div>
        </div>
      )}
    </>
  );
}

type RetranscribeStep = { phase: "fetching"; pct: number } | TranscribeProgress;

/**
 * "Transcribe the recording again" (while it's kept): loads the recording's parts, transcribes the whole of it on this
 * computer (the speech model downloads once), and offers the new transcript in place of the one in the box. Useful
 * when the live transcript fell behind or garbled words.
 */
export function RetranscribeTool({ source }: { source: { partIds: string[]; audioType: MeetingAudioType; audioBytes: number } }) {
  const { draft, latest } = useLatestDraft();
  const [step, setStep] = useState<RetranscribeStep | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const asrRef = useRef<AsrClient | null>(null);
  const running = useRef<AbortController | null>(null);

  useEffect(() => {
    const refs = { asrRef, running };
    return () => {
      refs.running.current?.abort();
      refs.asrRef.current?.dispose();
      refs.asrRef.current = null;
    };
  }, []);

  async function run() {
    const controller = new AbortController();
    running.current = controller;
    setMessage(null);
    setResult(null);
    setStep({ phase: "fetching", pct: 0 });
    try {
      const blob = await fetchRecording(source, controller.signal, (bytes) =>
        setStep({ phase: "fetching", pct: source.audioBytes ? (bytes / source.audioBytes) * 100 : 0 }),
      );
      if (!asrRef.current) asrRef.current = new AsrClient();
      const segments = await transcribeBlob(blob, {
        asr: asrRef.current,
        signal: controller.signal,
        onProgress: (p) => {
          if (!controller.signal.aborted) setStep(p);
        },
      });
      if (controller.signal.aborted) return;
      setStep(null);
      const text = formatTranscript(segments);
      if (!text) {
        setMessage({ text: "No speech was found in the recording, so the transcript stays as it is.", error: true });
        return;
      }
      const current = latest.current;
      if (current && !current.values.transcript.trim()) {
        current.update({ transcript: text });
        setMessage({ text: "Transcript added. Check it before saving.", error: false });
        return;
      }
      setResult(text);
    } catch (err) {
      if (controller.signal.aborted) return;
      setStep(null);
      setMessage({ text: errorText(err, "Couldn't transcribe the recording."), error: true });
    } finally {
      if (running.current === controller) running.current = null;
    }
  }

  function cancel() {
    running.current?.abort();
    running.current = null;
    setStep(null);
  }

  function replace() {
    if (!draft || !result) return;
    draft.update({ transcript: result });
    setResult(null);
    setMessage({ text: "Transcript replaced. Check it before saving.", error: false });
  }

  const pct = step
    ? step.phase === "fetching"
      ? step.pct
      : step.phase === "transcribing"
        ? step.pct
        : step.phase === "model" && step.status === "downloading"
          ? (step.detail.pct ?? 0)
          : null
    : null;
  const stepText = step
    ? step.phase === "fetching"
      ? `Loading the recording… ${Math.round(step.pct)}%`
      : transcribeProgressText(step)
    : null;
  const lines = result ? result.split("\n") : [];

  return (
    <>
      <Button variant="secondary" onClick={() => void run()} disabled={!draft || step !== null} aria-busy={step !== null}>
        {step ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : <AudioLines className="size-4" aria-hidden />}
        Transcribe the recording again
      </Button>
      <div role="status" className="basis-full space-y-2 text-sm empty:hidden">
        {stepText && (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-ink-600">
              <span>{stepText}</span>
              <Button variant="ghost" onClick={cancel}>
                Cancel
              </Button>
            </div>
            {pct !== null && <DownloadBar pct={pct} label={stepText} />}
          </div>
        )}
        {message && <p className={message.error ? "text-red-700" : "text-ink-600"}>{message.text}</p>}
      </div>
      {result && (
        <div className="basis-full space-y-3 rounded-lg border border-brand-200 bg-brand-50/60 p-3">
          <p className="text-sm font-medium text-ink-900">
            New transcript: {lines.length.toLocaleString("en-US")} {lines.length === 1 ? "line" : "lines"}. Replace the one in the box?
          </p>
          <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded-md bg-white p-2 font-mono text-xs text-ink-700 wrap-anywhere">
            {lines.slice(0, 6).join("\n")}
            {lines.length > 6 ? "\n…" : ""}
          </pre>
          <div className="flex flex-wrap gap-2">
            <Button onClick={replace}>Replace the transcript</Button>
            <Button variant="ghost" onClick={() => setResult(null)}>
              Keep the current one
            </Button>
          </div>
        </div>
      )}
    </>
  );
}
