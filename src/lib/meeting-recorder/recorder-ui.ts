// The meeting recorder's page (/meetings/record) and the recap edit page's tools, client-safe: the words they show
// (default title, progress lines, what status lines announce, the setup screen's model line, the recovery list, the
// leave guard), which recordings can be kept, what an upload's end means for this browser's copy, and drafting key
// points from a transcript. No DOM; unit-tested in tests/meeting-recorder-ui.test.ts.

import { type DateOnly, formatDateOnly } from "../dates";
import { formatFileSize } from "../files";
import {
  MEETING_AUDIO_MAX_BYTES,
  type MeetingAudioType,
  type MeetingAudioUploadState,
  type MeetingAudioUploadStateResult,
  sniffMeetingAudioType,
} from "../meeting-recaps";
import { generateKeyPoints, type KeyPointSegment, mergeKeyPoints } from "./key-points";
import { formatClock, formatKeyPoints, parseKeyPointLines, parseTranscriptLines } from "./transcript-format";

/** What "Upload a recording" offers in the file picker. */
export const RECORDING_FILE_ACCEPT = "audio/*,video/mp4,video/webm,.m4a,.mp3,.wav,.aac,.ogg,.opus,.webm";

const RECORDING_FILE_EXTENSIONS = new Set(["m4a", "mp3", "wav", "aac", "ogg", "oga", "opus", "webm", "mp4", "flac", "caf"]);

/** The live transcript's first line needs one full window of audio (the windower's 25 s) plus the model's time. */
export const FIRST_TEXT_SEC = 25;
/** With no line after this long, say the audio is safe anyway. */
const NO_TEXT_WARN_MS = 90_000;

/** "Meeting — Tue, Oct 7": a recap's title until the admin names it. */
export function defaultRecapTitle(day: DateOnly): string {
  return `Meeting — ${formatDateOnly(day)}`;
}

/** "Uploading the recording… 3 of 5 (9.0 MB of 14 MB)". */
export function uploadProgressText(p: { partsDone: number; partsTotal: number; bytesDone: number; bytesTotal: number }): string {
  return `Uploading the recording… ${p.partsDone} of ${p.partsTotal} (${formatFileSize(p.bytesDone)} of ${formatFileSize(p.bytesTotal)})`;
}

/** "Tue, Oct 7, 6:42 PM" in the team's timezone. */
function moment(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(ms));
}

function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

/** What the recovery list knows about a recording kept in this browser (a RecordingDoc). */
export interface RecoverableRecording {
  status: "recording" | "stopped" | "uploading";
  startedAt: number;
  durationMs: number;
  segments: unknown[];
  fileName?: string;
  draft?: { title?: string };
  audioPurged?: boolean;
}

/**
 * The recovery list's line for a recording kept in this browser: "Unsaved recording from Tue, Oct 7, 6:42 PM · 47:12 ·
 * 312 lines", "Unsaved recap of “team.m4a” …", or, for an interrupted upload, "“Build meeting” didn't finish uploading".
 */
export function recoveryTitle(doc: RecoverableRecording, timeZone: string): string {
  if (doc.status === "uploading") return `“${doc.draft?.title?.trim() || "A recap"}” didn't finish uploading its recording`;
  const what = doc.fileName ? `Unsaved recap of “${doc.fileName}”` : `Unsaved recording from ${moment(doc.startedAt, timeZone)}`;
  const parts = [what];
  if (doc.durationMs >= 1000) parts.push(formatClock(doc.durationMs));
  if (doc.segments.length) parts.push(plural(doc.segments.length, "line", "lines"));
  return parts.join(" · ");
}

/** The model line on the setup screen: "Accurate model · 286 MB · uses the graphics chip". */
export function modelLine(model: { label: string; sizeMB: number; note: string }): string {
  return `${model.label} · ${model.sizeMB} MB · ${model.note}`;
}

type ModelDetail = { pct?: number; loadedMB?: number; totalMB?: number; message?: string; reason?: string };

/** A download's progress: "42% (120 of 286 MB)", or "42%" when the size isn't known. */
export function downloadProgressText(detail: ModelDetail): string {
  const pct = Math.max(0, Math.min(100, Math.round(detail.pct ?? 0)));
  const mb = detail.totalMB ? ` (${Math.round(detail.loadedMB ?? 0)} of ${Math.round(detail.totalMB)} MB)` : "";
  return `${pct}%${mb}`;
}

/** The speech model's status (AsrStatus + detail) in words, or null when there's nothing to say. */
export function modelStatusText(status: string, detail: ModelDetail = {}): string | null {
  switch (status) {
    case "downloading":
      return `Downloading the speech model… ${downloadProgressText(detail)}`;
    case "loading":
      return "Starting the speech model…";
    case "fallback":
      // AsrFallbackReason: the graphics chip failed, or the accurate model's download stalled.
      return detail.reason === "download"
        ? "The download stalled, so the smaller standard model is starting instead…"
        : "The graphics chip didn't work out, so the standard model is starting instead…";
    case "error":
      return `The speech model couldn't start${detail.message ? ` (${detail.message})` : ""}.`;
    default:
      return null;
  }
}

/** Whole-file transcription's progress (TranscribeProgress) in words. */
export function transcribeProgressText(
  p:
    | { phase: "decoding" }
    | { phase: "model"; status: string; detail: { pct?: number; loadedMB?: number; totalMB?: number; message?: string } }
    | { phase: "transcribing"; pct: number },
): string {
  if (p.phase === "decoding") return "Reading the recording…";
  if (p.phase === "model") return modelStatusText(p.status, p.detail) ?? "Starting the speech model…";
  return `Transcribing… ${Math.max(0, Math.min(100, Math.round(p.pct)))}%`;
}

// What status lines (live regions) announce: a new step, never a number that changes every second or every percent
// (screen readers would queue each one). The numbers are still shown, next to the line and in the progress bar.

/** The speech model's status as a status line announces it: like modelStatusText, without the download's numbers. */
export function modelStatusPhrase(status: string, detail: ModelDetail = {}): string | null {
  return status === "downloading" ? "Downloading the speech model…" : modelStatusText(status, detail);
}

/** Whole-file transcription's step, as its status line announces it ("Transcribing…", without the percent). */
export function transcribePhaseText(
  p:
    | { phase: "decoding" }
    | { phase: "model"; status: string; detail: ModelDetail }
    | { phase: "transcribing"; pct: number },
): string {
  if (p.phase === "decoding") return "Reading the recording…";
  if (p.phase === "model") return modelStatusPhrase(p.status, p.detail) ?? "Starting the speech model…";
  return "Transcribing…";
}

/** Phones and tablets, from the user agent and the pointer (no hover, coarse). */
export function looksLikePhone(userAgent: string, coarsePointer: boolean): boolean {
  return /Android|iPhone|iPad|iPod|Mobile/i.test(userAgent) || (coarsePointer && /Macintosh/.test(userAgent));
}

/**
 * Whether the live transcript starts switched on: yes, except on a phone or tablet without WebGPU (the CPU model
 * would fall behind and drain the battery; the recording is transcribed after Stop instead).
 */
export function liveTranscriptDefault({ phone, webgpu }: { phone: boolean; webgpu: boolean }): boolean {
  return !phone || webgpu;
}

type FirstTextInput = { elapsedMs: number; readyAtMs: number | null; lines: number };

/** Where the live transcript is before its first line: counting down, any moment now, or late (90 s without any). */
function firstTextStep({ elapsedMs, readyAtMs, lines }: FirstTextInput): "countdown" | "soon" | "late" | null {
  if (lines > 0 || readyAtMs === null) return null;
  if (elapsedMs - readyAtMs >= NO_TEXT_WARN_MS || (elapsedMs >= NO_TEXT_WARN_MS && elapsedMs - readyAtMs >= 30_000)) return "late";
  return Math.ceil(FIRST_TEXT_SEC - elapsedMs / 1000) > 0 ? "countdown" : "soon";
}

/**
 * The line under the live transcript before its first line: a countdown once the model is ready ("First text in about
 * 18 s"), and after 90 s without any, that the audio is safe anyway. Null once there are lines, or while the model is
 * still loading (its own status says so).
 */
export function liveTranscriptHint(input: FirstTextInput): string | null {
  switch (firstTextStep(input)) {
    case "late":
      return "No text yet after 90 seconds — keep going, the audio is safe and can be transcribed after you stop.";
    case "countdown":
      return `First text in about ${Math.ceil(FIRST_TEXT_SEC - input.elapsedMs / 1000)} s…`;
    case "soon":
      return "First text any moment now…";
    default:
      return null;
  }
}

/**
 * What the live transcript's status line announces before its first line: the model's step while it gets ready
 * (without the download's numbers), then "First text any moment now…" and the 90-second reassurance — never the
 * countdown's seconds (liveTranscriptHint shows those, outside the status line). Null when there's nothing to announce.
 */
export function liveTranscriptAnnouncement({
  model,
  ...input
}: FirstTextInput & { model: { status: string; detail: ModelDetail } | null }): string | null {
  if (model) return modelStatusPhrase(model.status, model.detail);
  return firstTextStep(input) === "countdown" ? null : liveTranscriptHint(input);
}

/**
 * Whether a file can go through "Upload a recording": null when it can, else why not. The browser's own check of the
 * format happens when it's decoded (decode.ts).
 */
export function checkRecordingFile(file: { name: string; type: string; size: number }, maxBytes: number): string | null {
  const ext = file.name.includes(".") ? file.name.split(".").pop()!.toLowerCase() : "";
  const media = /^(?:audio|video)\//i.test(file.type);
  if (!media && !RECORDING_FILE_EXTENSIONS.has(ext)) {
    return "That doesn't look like a recording. Pick an audio file (MP3, M4A, WAV, WebM, Ogg).";
  }
  if (file.size === 0) return "That file is empty.";
  if (file.size > maxBytes) {
    return `That file is ${formatFileSize(file.size)}. Recordings up to ${formatFileSize(maxBytes)} can be transcribed here.`;
  }
  return null;
}

/**
 * Whether a recording can be kept (uploaded for 3 days) and as what, from its first bytes (the server checks them the
 * same way) and its size. `note` says why not.
 */
export function keptRecording(head: Uint8Array, bytes: number): { audioType: MeetingAudioType | null; note: string | null } {
  if (bytes <= 0) return { audioType: null, note: "There's no audio to keep." };
  const audioType = sniffMeetingAudioType(head);
  if (!audioType) {
    return {
      audioType: null,
      note: "This kind of file can't be kept (WebM, M4A, MP3, Ogg and WAV can), so the recap is saved without the recording.",
    };
  }
  if (bytes > MEETING_AUDIO_MAX_BYTES) {
    return {
      audioType: null,
      note: `This recording is ${formatFileSize(bytes)}, and recordings up to ${formatFileSize(MEETING_AUDIO_MAX_BYTES)} can be kept, so the recap is saved without it.`,
    };
  }
  return { audioType, note: null };
}

// ── Uploading to a saved recap, this browser's copy, and leaving ───────────────────────────────────────────────────

/** How uploading a recording to its saved recap ended. */
export type UploadOutcome =
  | { kind: "complete" }
  /** It stopped (the network, a refusal, a check that couldn't be made): this browser's copy can try again. */
  | { kind: "failed"; message: string }
  /** The recap was deleted: the copy can be saved again as a new recap. */
  | { kind: "orphaned"; message: string }
  /** Nothing to upload anymore: past its 3 days (or deleted), or the recap has no recording. */
  | { kind: "over"; message: string };

/** Getting on with an interrupted upload: the parts the portal has (skipped) and the type it was saved with. */
export type ResumePlan = { kind: "resume"; present: number[]; audioType: MeetingAudioType | null };

export const RECAP_GONE_MESSAGE = "This recording's recap isn't on the portal anymore (someone deleted it).";

/**
 * Before finishing an interrupted upload of a copy of `bytes`: what the portal's answer
 * (getMeetingAudioUploadStateAction) means — an outcome already, or the plan for the parts it's missing. Only a
 * deleted recap (`gone`) is "orphaned"; any other failure (signed out, the database, no access) is "failed": the copy
 * stays, and trying again may well work.
 */
export function resumeUpload(result: MeetingAudioUploadStateResult, bytes: number): UploadOutcome | ResumePlan {
  if (!result.ok) {
    return result.gone
      ? { kind: "orphaned", message: RECAP_GONE_MESSAGE }
      : { kind: "failed", message: `Couldn't check the upload with the portal. ${result.message}` };
  }
  const { state } = result;
  if (state.complete) return { kind: "complete" };
  if (state.audioParts === 0) return { kind: "over", message: "This recap was saved without its recording, so there's nothing to upload." };
  if (state.expired) {
    return { kind: "over", message: "The recording's 3 days are up (or it was deleted), so it can't be uploaded anymore. The recap stays, without it." };
  }
  if (state.audioBytes !== bytes) {
    return { kind: "failed", message: "The copy on this computer isn't the recording this recap expects, so it can't be finished." };
  }
  return { kind: "resume", present: state.present, audioType: state.audioType };
}

/**
 * What becomes of this browser's copy once an upload ends: deleted only when the portal has the whole recording;
 * otherwise kept as it is (to try again, or to download or discard by hand) — and after "orphaned", turned back into
 * an unsaved recording (no recap), so it can be saved as a new one.
 */
export function copyAfterUpload(kind: UploadOutcome["kind"]): "delete" | "keep" | "unsaved" {
  return kind === "complete" ? "delete" : kind === "orphaned" ? "unsaved" : "keep";
}

/**
 * Whether discarding the copy of a recording that didn't finish uploading should also delete what reached the portal:
 * only while it's still uploading there (not complete, not past its 3 days or deleted), so the recap stops saying
 * "still uploading" for 3 days. A complete recording stays (the copy just wasn't told).
 */
export function serverAudioToDelete(state: MeetingAudioUploadState): boolean {
  return state.audioParts > 0 && !state.complete && !state.expired;
}

/** Under "The recap is saved, but its recording didn't finish uploading.": what can still be done. */
export function uploadFailedHint(kept: boolean): string {
  return kept
    ? "The recording stays on this computer: try again now, or later from Record a meeting on this computer (until 3 days after saving)."
    : "This browser can't keep the recording after this tab closes. Try the upload again now, or download the recording before you leave.";
}

export type RecorderPhase = "setup" | "recording" | "processing" | "review" | "finishing";

/**
 * What the recorder asks before the page is left (useLeaveGuard), or null when leaving loses nothing: while recording,
 * processing, or reviewing a recording that isn't saved; while an upload runs (it stops, and can be finished later
 * only from a copy this browser kept); and while a saved recap's recording is only in this tab (a failed upload this
 * browser couldn't keep a copy of, or one the portal refused).
 */
export function recorderLeaveMessage(s: {
  phase: RecorderPhase;
  saveStage: "idle" | "saving" | "refused" | "uploading" | "upload-failed" | "audio-refused" | "done";
  finishStage: string;
  /** This browser keeps recordings as they go (IndexedDB works). */
  keptHere: boolean;
  /** The copy that can finish the upload was kept (null: not saved yet). */
  uploadKept: boolean | null;
  /** The recording under review is in this tab (what a refused recording's Download offers). */
  hasAudio: boolean;
}): string | null {
  const unsaved = s.keptHere
    ? "Leave without saving? The recording stays on this computer — open Record a meeting again to save it."
    : "Leave without saving? This browser can't keep the recording, so it will be lost.";
  const uploading =
    s.uploadKept === false
      ? "Leave while the recording uploads? The upload stops, and this browser can't keep the recording, so the rest of it can't be uploaded later."
      : "Leave while the recording uploads? The upload stops; open Record a meeting on this computer again to finish it.";
  switch (s.phase) {
    case "recording":
      return s.keptHere
        ? "Leave the recorder? The recording stops. What was recorded so far stays on this computer — open Record a meeting again to save it."
        : "Leave the recorder? The recording stops, and this browser can't keep it, so it will be lost.";
    case "processing":
      return unsaved;
    case "review":
      switch (s.saveStage) {
        case "idle":
        case "saving":
        case "refused":
          return unsaved;
        case "uploading":
          return uploading;
        case "upload-failed":
          return s.uploadKept === false
            ? "Leave without the recording? This browser can't keep it, so its upload can't be finished later — try again, or download it first."
            : null;
        case "audio-refused":
          return s.hasAudio
            ? "Leave without the recording? The portal couldn't keep it, and it isn't kept on this computer — download it first if you want a copy."
            : null;
        default:
          return null;
      }
    case "finishing":
      return s.finishStage === "uploading" ? uploading : null;
    default:
      return null;
  }
}

/**
 * Key points drafted from transcript segments: the extractive ones (decisions, to-dos with owners from `roster`,
 * marked moments…) merged with Chrome's on-device summary `bullets` when there are any — as the key points box's
 * text, one "[m:ss] …" line each.
 */
export function draftKeyPoints(
  segments: KeyPointSegment[],
  opts: { roster?: string[]; marks?: number[]; bullets?: string[] | null } = {},
): string {
  const extractive = generateKeyPoints(segments, { roster: opts.roster, marks: opts.marks });
  return formatKeyPoints(mergeKeyPoints(opts.bullets ?? [], extractive, segments));
}

/**
 * A saved transcript's text as segments for the key points: each line at its time, a line without one at the time of
 * the line before. `timed` is false when no line has a time (then the key points get none either).
 */
export function transcriptSegments(text: string): { segments: KeyPointSegment[]; timed: boolean } {
  const lines = parseTranscriptLines(text);
  let at = 0;
  const segments = lines.map((l) => {
    if (l.atMs !== null) at = l.atMs;
    return { s: at, text: l.text };
  });
  return { segments, timed: lines.some((l) => l.atMs !== null) };
}

/** "Suggest key points" on the edit page: drafted from the transcript box's text (no times when it has none). */
export function suggestKeyPoints(transcript: string, opts: { roster?: string[]; bullets?: string[] | null } = {}): string {
  const { segments, timed } = transcriptSegments(transcript);
  if (!segments.length) return "";
  const text = draftKeyPoints(segments, opts);
  return timed ? text : formatKeyPoints(parseKeyPointLines(text).map((p) => ({ atMs: null, text: p.text })));
}

/** Suggested key points added under the ones typed already, without repeating a point that's there. */
export function appendKeyPoints(current: string, added: string): string {
  const have = new Set(parseKeyPointLines(current).map((p) => p.text.toLowerCase()));
  const extra = added
    .split("\n")
    .filter((line) => {
      const [p] = parseKeyPointLines(line);
      return p && !have.has(p.text.toLowerCase());
    })
    .join("\n");
  const base = current.replace(/\s+$/, "");
  if (!extra) return base;
  return base ? `${base}\n${extra}` : extra;
}
