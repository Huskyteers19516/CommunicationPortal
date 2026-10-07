"use client";

import { CircleCheck, Download, FileAudio, LoaderCircle, Mic, NotebookPen, Sparkles } from "lucide-react";
import { type ReactNode, useRef } from "react";
import { downloadProgressText, modelLine, modelStatusPhrase, modelStatusText, RECORDING_FILE_ACCEPT } from "@/lib/meeting-recorder/recorder-ui";
import { Alert } from "../../ui/alert";
import { Button, ButtonLink } from "../../ui/button";
import { Card, CardBody } from "../../ui/card";
import { CheckboxField, Field, Select } from "../../ui/field";
import { ASR_MODELS, type AsrDevice, type AsrModel, type AsrStatus, type AsrStatusDetail } from "./engine/asr-client";
import type { SummarizerAvailability } from "./engine/chrome-summarizer";

export interface MicOption {
  deviceId: string;
  label: string;
}

export interface ModelInfo {
  /** What the speech model will be (null until this computer's graphics chip was checked). */
  plan: { model: AsrModel; device: AsrDevice } | null;
  /** The planned model is in this browser already. */
  downloaded: boolean;
  /** A download or start in progress (or its failure). Null when idle. */
  status: { status: AsrStatus; detail: AsrStatusDetail } | null;
  /** WebGPU with 16-bit floats: the accurate model runs here (otherwise "Smaller download" changes nothing). */
  canRunAccurate: boolean;
  smaller: boolean;
}

export interface SummaryInfo {
  /** Chrome's on-device summarizer here (null while checking). */
  availability: SummarizerAvailability | null;
  /** "Turn on" is downloading: 0–100. */
  pct: number | null;
  failed: boolean;
}

/** The progress bar of a download. */
export function DownloadBar({ pct, label }: { pct: number; label: string }) {
  const value = Math.max(0, Math.min(100, Math.round(pct)));
  return (
    <div
      className="h-2 overflow-hidden rounded-full bg-ink-100"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value}
    >
      <div className="h-full bg-brand-500 transition-[width]" style={{ width: `${value}%` }} />
    </div>
  );
}

/**
 * The recorder's start screen: unsaved recordings to recover (`recovery`), the microphone, the live transcript
 * switch, which speech model this computer gets ("Download it now", "Smaller download"), Chrome's on-device summary
 * (a one-time "Turn on"), the consent line, **Start recording**, and the other ways in: **Upload a recording** and
 * "Write one up without a recording".
 */
export function RecorderSetup({
  recovery,
  mics,
  micId,
  onMicChange,
  live,
  onLiveChange,
  model,
  onDownloadModel,
  onSmallerChange,
  summary,
  onTurnOnSummary,
  starting,
  error,
  onStart,
  onFile,
}: {
  recovery?: ReactNode;
  mics: MicOption[];
  micId: string;
  onMicChange: (deviceId: string) => void;
  live: boolean;
  onLiveChange: (on: boolean) => void;
  model: ModelInfo;
  onDownloadModel: () => void;
  onSmallerChange: (smaller: boolean) => void;
  summary: SummaryInfo;
  onTurnOnSummary: () => void;
  starting: boolean;
  /** Why the last start (or file) didn't work. */
  error: string | null;
  onStart: () => void;
  onFile: (file: File) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const namesHidden = mics.length > 0 && mics.every((m) => !m.label);
  const planned = model.plan ? ASR_MODELS[model.plan.model] : null;
  // The status line says what the model is doing; a download's percent is shown under it (and in the bar), not announced.
  const busy = model.status && model.status.status !== "error" ? modelStatusPhrase(model.status.status, model.status.detail) : null;
  const downloading = model.status?.status === "downloading" ? model.status.detail : null;
  const modelError = model.status?.status === "error" ? modelStatusText("error", model.status.detail) : null;

  return (
    <div className="space-y-5">
      {recovery}

      <Card>
        <CardBody className="space-y-5">
          <Field
            label="Microphone"
            htmlFor="recorder-mic"
            hint={namesHidden ? "Their names show once the browser may use the microphone (after the first recording)." : undefined}
          >
            <Select id="recorder-mic" value={micId} onChange={(e) => onMicChange(e.currentTarget.value)}>
              <option value="">Default microphone</option>
              {mics
                .filter((m) => m.label)
                .map((m) => (
                  <option key={m.deviceId} value={m.deviceId}>
                    {m.label}
                  </option>
                ))}
            </Select>
          </Field>

          <label htmlFor="recorder-live" className="flex min-h-11 cursor-pointer items-center justify-between gap-4">
            <span className="min-w-0">
              <span id="recorder-live-label" className="block text-sm font-medium text-ink-900">
                Live transcript
              </span>
              <span id="recorder-live-desc" className="mt-0.5 block text-sm text-ink-500">
                Writes the transcript on this computer while you record. Off, it&apos;s written after you stop — better on phones.
              </span>
            </span>
            <span className="relative inline-flex shrink-0 items-center">
              <input
                id="recorder-live"
                type="checkbox"
                role="switch"
                checked={live}
                onChange={(e) => onLiveChange(e.currentTarget.checked)}
                aria-labelledby="recorder-live-label"
                aria-describedby="recorder-live-desc"
                className="peer sr-only"
              />
              <span
                aria-hidden
                className="h-7 w-12 rounded-full bg-ink-300 transition-colors peer-checked:bg-brand-600 peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-brand-600"
              />
              <span
                aria-hidden
                className="pointer-events-none absolute left-1 top-1 size-5 rounded-full bg-white shadow-sm transition-transform peer-checked:translate-x-5"
              />
            </span>
          </label>

          <div className="space-y-2">
            <p className="text-sm font-medium text-ink-800">Speech model</p>
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
              <p className="min-w-0 text-sm text-ink-600">
                {planned ? modelLine(planned) : "Checking this computer…"}
                <span className="block text-xs text-ink-500">
                  Downloaded once, then kept by this browser. Speech never leaves this computer.
                </span>
              </p>
              {planned &&
                (model.downloaded || model.status?.status === "ready" ? (
                  <span className="inline-flex items-center gap-1.5 text-sm font-medium text-brand-700">
                    <CircleCheck className="size-4" aria-hidden />
                    Ready
                  </span>
                ) : (
                  <Button variant="secondary" onClick={onDownloadModel} disabled={!!busy} aria-busy={!!busy}>
                    {busy ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : <Download className="size-4" aria-hidden />}
                    Download it now
                  </Button>
                ))}
            </div>
            <div role="status" className="space-y-1.5 text-sm text-ink-600 empty:hidden">
              {busy && <p>{busy}</p>}
              {modelError && <p className="text-red-700">{modelError} The recording itself still works.</p>}
            </div>
            {downloading && (
              <div className="space-y-1.5">
                <DownloadBar pct={downloading.pct ?? 0} label="Downloading the speech model" />
                <p className="text-xs text-ink-500" aria-hidden>
                  {downloadProgressText(downloading)}
                </p>
              </div>
            )}
            {model.canRunAccurate && (
              <CheckboxField
                checked={model.smaller}
                onChange={(e) => onSmallerChange(e.currentTarget.checked)}
                label="Smaller download"
                description={`${modelLine(ASR_MODELS.base)} — less accurate, quicker to get.`}
              />
            )}
          </div>

          <SummaryLine summary={summary} onTurnOn={onTurnOnSummary} />
        </CardBody>
      </Card>

      <Alert tone="info" title="Let everyone know the meeting is being recorded.">
        Recording works best on a computer near the people talking. Keep this tab open while you record.
      </Alert>

      {error && <Alert tone="error">{error}</Alert>}

      <div className="space-y-3">
        <Button size="lg" className="w-full sm:w-auto sm:px-8" onClick={onStart} aria-busy={starting} disabled={starting}>
          {starting ? <LoaderCircle className="size-5 animate-spin" aria-hidden /> : <Mic className="size-5" aria-hidden />}
          {starting ? "Starting…" : "Start recording"}
        </Button>
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          <Button variant="secondary" onClick={() => fileRef.current?.click()}>
            <FileAudio className="size-4" aria-hidden />
            Upload a recording
          </Button>
          <ButtonLink href="/meetings/new" variant="ghost">
            <NotebookPen className="size-4" aria-hidden />
            Write one up without a recording
          </ButtonLink>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept={RECORDING_FILE_ACCEPT}
          className="hidden"
          tabIndex={-1}
          aria-hidden
          onChange={(e) => {
            const file = e.currentTarget.files?.[0];
            e.currentTarget.value = "";
            if (file) onFile(file);
          }}
        />
        <p className="text-xs text-ink-500">
          An uploaded recording is transcribed on this computer, then you check the key points and save.
        </p>
      </div>
    </div>
  );
}

/** Chrome's on-device summary: what it adds, and the one-time "Turn on" where it can be downloaded. */
function SummaryLine({ summary, onTurnOn }: { summary: SummaryInfo; onTurnOn: () => void }) {
  const { availability, pct, failed } = summary;
  if (availability === null) return null;
  let text: string;
  if (failed) text = "Chrome's on-device summary couldn't be turned on. Key points are drafted from the transcript on this computer.";
  else if (availability === "available") text = "Key points are drafted on this computer, with Chrome's on-device summary.";
  else if (availability === "downloading" || pct !== null) text = "Chrome is getting its on-device summary ready…";
  else if (availability === "downloadable")
    text = "Chrome can add its on-device summary to the drafted key points, after a one-time download.";
  else text = "Key points are drafted from the transcript on this computer.";
  const canTurnOn = availability === "downloadable" && pct === null && !failed;
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
      <p className="flex min-w-0 items-start gap-2 text-sm text-ink-600">
        <Sparkles className="mt-0.5 size-4 shrink-0 text-brand-600" aria-hidden />
        {/* Announced when it changes; the download's percent is shown after it, not announced. */}
        <span role="status">{text}</span>
        {pct !== null && !failed && availability !== "available" && (
          <span className="tabular-nums" aria-hidden>
            {pct}%
          </span>
        )}
      </p>
      {canTurnOn && (
        <Button variant="secondary" onClick={onTurnOn}>
          Turn on
        </Button>
      )}
    </div>
  );
}
