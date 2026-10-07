"use client";

// The meeting recorder (/meetings/record, people with admin access): record a meeting in the browser, transcribe it
// on this computer, draft its key points, review, and save — the recap first, then the recording in parts. A port of
// VoiceCollector's recorder on the engine in ./engine (see live-session.ts) and the recap fields of
// ../meeting-recap-fields.tsx.
//
//   setup ──Start──▶ recording ──Stop──▶ processing ──▶ review ──Save──▶ (upload) ──▶ /meetings/<id>?saved=new (or first)
//     │                                    ▲   finishing the live transcript; no (whole) transcript → transcribe
//     ├──Upload a recording────────────────┘   the recording or skip; drafting the key points
//     ├──Review & save (a recording kept in this browser) ──▶ processing / review
//     └──Finish uploading (a recap whose recording didn't finish) ──▶ finishing ──▶ the recap
//
// Everything is kept in IndexedDB as it goes (recorder-db.ts), so a closed tab loses at most 5 seconds; the copy is
// deleted once the portal has the whole recording (or the recap was saved without it), or when the admin discards it —
// never because a check failed. A tab holds a Web Lock on the recording it has open (recording-lock.ts), so another tab
// doesn't offer it again. Each save sends a request id (kept with the copy), so saving again after a lost answer or a
// reload finds the same recap instead of making a second one (with this save's text, unless that recap was edited
// since or is another admin's: then `textKept`, it opens with `?saved=first`, which says so, and the copy stays until
// it has). Leaving the page stops an upload (nothing navigates afterwards); the copy finishes it later.

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  createMeetingRecapAction,
  deleteMeetingAudioAction,
  getMeetingAudioUploadStateAction,
  type MeetingRecapCreateState,
  uploadMeetingAudioPartAction,
} from "@/app/(app)/meetings/actions";
import type { ActionState } from "@/lib/action-state";
import { type DateOnly, todayInTimezone } from "@/lib/dates";
import { meetingAudioUntilLabel } from "@/lib/meeting-recap-view";
import {
  MEETING_AUDIO_KEEP_MS,
  MEETING_DURATION_MAX_SEC,
  meetingAudioPartCount,
  type MeetingAudioType,
  type MeetingAudioUploadStateResult,
  type MeetingCategoryOption,
  meetingRecapHref,
  newMeetingRequestId,
  normalizeMeetingAudioType,
} from "@/lib/meeting-recaps";
import {
  checkRecordingFile,
  copyAfterUpload,
  defaultRecapTitle,
  draftKeyPoints,
  keptRecording,
  liveTranscriptDefault,
  looksLikePhone,
  type RecorderPhase,
  recorderLeaveMessage,
  resumeUpload,
  serverAudioToDelete,
  type UploadOutcome,
} from "@/lib/meeting-recorder/recorder-ui";
import { formatTranscript } from "@/lib/meeting-recorder/transcript-format";
import { Alert } from "../../ui/alert";
import type { MeetingRecapFieldValues } from "../meeting-recap-fields";
import { AsrClient, downloadedAsrModels } from "./engine/asr-client";
import { prepareSummarizer, summarizerAvailability, summarizeTranscript, type SummarizerHandle } from "./engine/chrome-summarizer";
import { DECODE_MAX_BYTES } from "./engine/decode";
import {
  MeetingRecorder,
  type RecorderResult,
  type RecorderState,
  type RecorderStatus,
  type TimedSegment,
  transcribeBlob,
} from "./engine/live-session";
import { listMics } from "./engine/mic";
import { findRecoverable, openRecorderDb, type RecorderDb, type RecorderDraft, type RecordingDoc } from "./engine/recorder-db";
import { type UploadProgress, uploadRecording } from "./engine/upload";
import { FinishUploadPanel, type FinishState } from "./finish-upload-panel";
import { ProcessingPanel, type ProcessingStep } from "./processing-panel";
import { type MicOption, type ModelInfo, RecorderSetup, type SummaryInfo } from "./recorder-setup";
import { type LiveTranscriptState, RecordingPanel } from "./recording-panel";
import { lockRecording, recordingsOpenElsewhere } from "./recording-lock";
import { RecoveryList } from "./recovery-list";
import { ReviewPanel, type SaveState } from "./review-panel";
import { useLeaveGuard } from "./use-leave-guard";

type Phase = RecorderPhase;

/**
 * This browser's copy of a recording, with the request id of its save (see saveRecap), and whether that recap kept its
 * own text instead of this copy's (`textKept`: finishing the upload opens it with `?saved=first`).
 */
type RecorderDoc = RecordingDoc & { requestId?: string; textKept?: boolean };

/** The recording being processed and reviewed (from the recorder, a picked file, or this browser's copy). */
interface Take {
  /** Its id in IndexedDB (recorder-db.ts). */
  id: string;
  /** The audio; null when this browser's copy was deleted after 3 days. */
  blob: Blob | null;
  mime: string;
  /** What it's kept as on the portal, or null when it can't be (`audioNote` says why). */
  audioType: MeetingAudioType | null;
  audioNote: string | null;
  durationMs: number;
  /** Date.now() when it started (the meeting's day). */
  startedAt: number;
  segments: TimedSegment[];
  marks: number[];
  liveTranscriptComplete: boolean;
  fileName?: string;
  /** Sent with its save, so saving again finds the same recap (set at the first save, kept with the copy). */
  requestId?: string;
}

const HEADINGS: Record<Phase, string> = {
  setup: "Record a meeting",
  recording: "Recording",
  processing: "Finishing up",
  review: "Review and save",
  finishing: "Finish uploading",
};

const OFFLINE = "Couldn't reach the portal. Check the internet connection and try again — nothing is lost.";
const UNREACHABLE = "Couldn't reach the portal.";
/** After a failed attempt to delete what reached the portal of a recording being discarded. */
const NOT_DISCARDED = "The part of the recording on the portal couldn't be deleted, so nothing was deleted here either — try again in a moment.";
const EMPTY_DRAFT: MeetingRecapFieldValues = { title: "", meetingDate: "", categoryIds: [], keyPoints: "", transcript: "" };
const IDLE_LIVE: LiveTranscriptState = {
  on: false,
  segments: [],
  partial: "",
  readyAtMs: null,
  model: null,
  offMessage: null,
  droppedSec: 0,
  missedSec: 0,
};

/**
 * How a saved recap opens: `?saved=first` when it kept its own text (createMeetingRecap's `textKept`: an earlier try
 * had saved it, and it was edited since or is another admin's), so its page says this save's changes weren't added;
 * else `otherwise`.
 */
function savedQuery(textKept: boolean | undefined, otherwise = "?saved=new"): string {
  return textKept ? "?saved=first" : otherwise;
}

function errorText(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

/** This browser's copy of a take (status "stopped" unless `extra` says otherwise). */
function docOf(take: Take, extra: Partial<RecorderDoc> = {}): RecorderDoc {
  return {
    id: take.id,
    status: "stopped",
    startedAt: take.startedAt,
    heartbeatAt: Date.now(),
    durationMs: take.durationMs,
    mime: take.mime,
    segments: take.segments,
    marks: take.marks,
    liveTranscriptComplete: take.liveTranscriptComplete,
    ...(take.fileName ? { fileName: take.fileName } : {}),
    ...(take.requestId ? { requestId: take.requestId } : {}),
    ...extra,
  };
}

/** A copy whose recap was deleted, as an unsaved recording again (no recap; its next save is a new one). */
function asUnsaved(doc: RecorderDoc): RecorderDoc {
  return { ...doc, status: "stopped", recapId: undefined, requestId: undefined, textKept: undefined, uploadedParts: undefined };
}

/** What a recording's first bytes and size say about keeping it. */
async function keepability(blob: Blob | null): Promise<{ audioType: MeetingAudioType | null; note: string | null }> {
  if (!blob) return { audioType: null, note: null };
  return keptRecording(new Uint8Array(await blob.slice(0, 16).arrayBuffer()), blob.size);
}

/**
 * The recordings this browser kept that are worth offering: over-3-day-old audio deleted first (the text stays), the
 * ones a tab has open left out (without Web Locks: a "recording" whose heartbeat is fresh), and empty leftovers
 * (no audio, no text) deleted.
 */
async function loadRecoverable(db: RecorderDb, justReleased: string | null = null): Promise<RecordingDoc[]> {
  await db.purgeOldAudio();
  const [docs, open] = await Promise.all([db.listRecordings(), recordingsOpenElsewhere()]);
  // This tab's own lock may still be letting go (`justReleased`).
  if (open && justReleased) open.delete(justReleased);
  const out: RecordingDoc[] = [];
  for (const doc of open ? docs.filter((d) => !open.has(d.id)) : findRecoverable(docs)) {
    const empty = doc.status !== "uploading" && doc.durationMs < 1000 && !doc.segments.length && !doc.draft && !doc.fileName;
    if (empty && (doc.audioPurged || !(await db.getAudio(doc.id, doc.mime)))) {
      await db.deleteRecording(doc.id);
      continue;
    }
    out.push(doc);
  }
  return out;
}

/**
 * Uploads `blob` to recap `recapId`. `resume`: first ask the portal which parts it has (finishing an interrupted
 * upload), and check the recap still expects this recording (resumeUpload: only a deleted recap is "orphaned").
 * `signal`: leaving the recorder stops it (between parts).
 */
async function sendRecording(
  blob: Blob,
  opts: {
    recapId: string;
    audioType: MeetingAudioType | null;
    resume: boolean;
    signal: AbortSignal;
    onProgress: (p: UploadProgress) => void;
  },
): Promise<UploadOutcome> {
  let present: number[] = [];
  let audioType = opts.audioType;
  if (opts.resume) {
    let answer: MeetingAudioUploadStateResult;
    try {
      answer = await getMeetingAudioUploadStateAction(opts.recapId);
    } catch {
      return { kind: "failed", message: OFFLINE };
    }
    const plan = resumeUpload(answer, blob.size);
    if (plan.kind !== "resume") return plan;
    present = plan.present;
    audioType = plan.audioType ?? audioType;
  }
  if (opts.signal.aborted) return { kind: "failed", message: "The upload was stopped." };
  const result = await uploadRecording(blob, {
    recapId: opts.recapId,
    audioType: audioType ?? normalizeMeetingAudioType(blob.type) ?? "audio/webm",
    present,
    sendPart: (fd) => uploadMeetingAudioPartAction(null, fd),
    onProgress: opts.onProgress,
    signal: opts.signal,
  });
  if (!result.ok) return { kind: "failed", message: result.message };
  return result.complete ? { kind: "complete" } : { kind: "failed", message: "The portal didn't get the whole recording. Try again." };
}

/**
 * Deletes what reached the portal of a recording whose upload won't be finished (its copy here is being discarded, or
 * is gone), so the recap stops saying "still uploading" for 3 days — only while it's still uploading there: a complete
 * recording stays, and one past its 3 days or already deleted needs nothing. `ok: false` says why it couldn't be done
 * (nothing was changed then).
 */
async function abandonServerAudio(recapId: string): Promise<{ ok: true } | { ok: false; message: string }> {
  const ask = async (): Promise<MeetingAudioUploadStateResult | null> => {
    try {
      return await getMeetingAudioUploadStateAction(recapId);
    } catch {
      return null;
    }
  };
  const before = await ask();
  if (!before) return { ok: false, message: UNREACHABLE };
  if (!before.ok) return before.gone ? { ok: true } : { ok: false, message: before.message };
  if (!serverAudioToDelete(before.state)) return { ok: true };
  const fd = new FormData();
  fd.set("recapId", recapId);
  let res: ActionState;
  try {
    res = await deleteMeetingAudioAction(null, fd);
  } catch {
    return { ok: false, message: UNREACHABLE };
  }
  if (res?.ok) return { ok: true };
  // Someone deleted it (or the recap) meanwhile, or its 3 days ran out: done all the same.
  const after = await ask();
  if (after && (after.ok ? !serverAudioToDelete(after.state) : after.gone)) return { ok: true };
  return { ok: false, message: res?.message || "The portal didn't delete it." };
}

/**
 * The recorder app. Props come from the page (getMeetingRecorderSetup): the categories, the team's first names (to-do
 * owners in the drafted key points), the team's today, and its timezone.
 */
export function MeetingRecorderApp({
  categories,
  roster,
  today,
  timeZone,
}: {
  categories: MeetingCategoryOption[];
  roster: string[];
  today: DateOnly;
  timeZone: string;
}) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("setup");
  const [db, setDb] = useState<RecorderDb | null>(null);
  const [recoverable, setRecoverable] = useState<RecordingDoc[]>([]);
  const [recoveryBusy, setRecoveryBusy] = useState<string | null>(null);
  const [recoveryNote, setRecoveryNote] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Setup.
  const [mics, setMics] = useState<MicOption[]>([]);
  const [micId, setMicId] = useState("");
  const [live, setLive] = useState(true);
  const liveChosen = useRef(false);
  const [model, setModel] = useState<ModelInfo>({ plan: null, downloaded: false, status: null, canRunAccurate: false, smaller: false });
  const [summary, setSummary] = useState<SummaryInfo>({ availability: null, pct: null, failed: false });
  const [setupError, setSetupError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  // Recording.
  const [recState, setRecState] = useState<RecorderState>("idle");
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(0);
  const [marks, setMarks] = useState<number[]>([]);
  const [liveState, setLiveState] = useState<LiveTranscriptState>(IDLE_LIVE);
  const [persistent, setPersistent] = useState<boolean | null>(null);

  // Processing and review.
  const [take, setTake] = useState<Take | null>(null);
  const [processing, setProcessing] = useState<ProcessingStep>({ step: "finishing" });
  const [draft, setDraft] = useState<MeetingRecapFieldValues>(EMPTY_DRAFT);
  const [keepAudio, setKeepAudio] = useState(true);
  const [keepUntil, setKeepUntil] = useState("");
  const [reviewNote, setReviewNote] = useState<string | null>(null);
  const [save, setSave] = useState<SaveState>({ stage: "idle" });
  /** Whether this browser kept the copy that can finish the upload (null until a recap with a recording is saved). */
  const [uploadKept, setUploadKept] = useState<boolean | null>(null);

  // Finishing an interrupted upload.
  const [finishDoc, setFinishDoc] = useState<RecordingDoc | null>(null);
  const [finish, setFinish] = useState<FinishState>({ stage: "checking" });

  const asrRef = useRef<AsrClient | null>(null);
  const recorderRef = useRef<MeetingRecorder | null>(null);
  const takeRef = useRef<Take | null>(null);
  const summarizerRef = useRef<SummarizerHandle | null>(null);
  const stopping = useRef(false);
  const startedAt = useRef(0);
  const lock = useRef<{ id: string; release: () => void } | null>(null);
  const transcribing = useRef<AbortController | null>(null);
  const summarizing = useRef<AbortController | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const shownPhase = useRef<Phase>("setup");
  /** False once the page was left (React unmounted it): nothing is shown or navigated after that. */
  const mounted = useRef(false);
  /** The upload running now: leaving the page stops it. */
  const uploadAbort = useRef<AbortController | null>(null);

  // ── leaving ────────────────────────────────────────────────────────────────────────────────────────────────────
  // Kept here only while the recorder says so (or hasn't said yet) and the store still works (a failed write turns
  // it to memory only).
  const keptHere = (persistent ?? true) && (db?.persistent ?? false);
  const leaveMessage = recorderLeaveMessage({
    phase,
    saveStage: save.stage,
    finishStage: finish.stage,
    keptHere,
    uploadKept,
    hasAudio: !!take?.blob && !(save.stage === "audio-refused" && save.kept),
  });
  const allowLeave = useLeaveGuard(leaveMessage);

  // ── on load: the speech model, Chrome's summarizer, microphones, this browser's copies ──────────────────────────
  useEffect(() => {
    const asr = new AsrClient();
    asrRef.current = asr;
    const unsubscribe = asr.subscribe((status, detail) => {
      setModel((m) => ({
        ...m,
        status: status === "ready" ? null : { status, detail },
        downloaded: status === "ready" ? true : m.downloaded,
        plan: status === "ready" && detail.model && detail.device ? { model: detail.model, device: detail.device } : m.plan,
      }));
    });
    void (async () => {
      const probe = await asr.probe();
      const plan = await asr.plan();
      const downloaded = (await downloadedAsrModels()).includes(plan.model);
      if (asrRef.current !== asr) return;
      setModel((m) => ({ ...m, plan: m.plan ?? plan, downloaded: m.downloaded || downloaded, canRunAccurate: probe.webgpu && probe.fp16 }));
      if (!liveChosen.current) {
        const phone = looksLikePhone(navigator.userAgent, window.matchMedia?.("(pointer: coarse)").matches ?? false);
        setLive(liveTranscriptDefault({ phone, webgpu: probe.webgpu }));
      }
    })();
    return () => {
      unsubscribe();
      asr.dispose();
      if (asrRef.current === asr) asrRef.current = null;
    };
  }, []);

  useEffect(() => {
    let active = true;
    void summarizerAvailability().then((availability) => {
      if (active) setSummary((s) => ({ ...s, availability }));
    });
    const refreshMics = () => {
      void listMics().then((list) => {
        if (!active) return;
        // "default" / "communications" repeat a real device; "Default microphone" stands for them.
        setMics(
          list
            .filter((d) => d.deviceId && d.deviceId !== "default" && d.deviceId !== "communications")
            .map((d) => ({ deviceId: d.deviceId, label: d.label })),
        );
      });
    };
    refreshMics();
    navigator.mediaDevices?.addEventListener?.("devicechange", refreshMics);
    void (async () => {
      const store = await openRecorderDb();
      if (!active) return;
      setDb(store);
      const docs = await loadRecoverable(store);
      if (active) setRecoverable(docs);
    })();
    return () => {
      active = false;
      navigator.mediaDevices?.removeEventListener?.("devicechange", refreshMics);
    };
  }, []);

  // Leaving the page (or React unmounting it): the recording and any upload stop, the copy stays. (Set in the effect
  // too: StrictMode runs it, its cleanup, then it again.)
  useEffect(() => {
    const refs = { recorderRef, lock, transcribing, summarizing, uploadAbort, mounted };
    refs.mounted.current = true;
    return () => {
      refs.mounted.current = false;
      refs.uploadAbort.current?.abort();
      refs.recorderRef.current?.destroy();
      refs.lock.current?.release();
      refs.transcribing.current?.abort();
      refs.summarizing.current?.abort();
    };
  }, []);

  // The timer while recording.
  useEffect(() => {
    if (phase !== "recording") return;
    const timer = setInterval(() => setElapsed(recorderRef.current?.elapsedMs() ?? 0), 250);
    return () => clearInterval(timer);
  }, [phase]);

  // A new step: its heading gets focus (screen readers hear where they are; the page starts at the top).
  useEffect(() => {
    if (shownPhase.current === phase) return;
    shownPhase.current = phase;
    headingRef.current?.focus();
  }, [phase]);

  // The review form is kept in this browser too (1 s after typing stops), so a closed tab comes back to it. Only while
  // the take is still the one under review: Discard lets go of it first, so a write due meanwhile can't bring it back.
  useEffect(() => {
    if (phase !== "review" || !db || (save.stage !== "idle" && save.stage !== "refused")) return;
    const current = takeRef.current;
    if (!current) return;
    const timer = setTimeout(() => {
      if (takeRef.current === current) void db.putRecording(docOf(current, { draft: { ...draft, keepAudio } }));
    }, 1000);
    return () => clearTimeout(timer);
  }, [phase, db, draft, keepAudio, save.stage]);

  // ── helpers ────────────────────────────────────────────────────────────────────────────────────────────────────

  function setCurrentTake(next: Take | null) {
    takeRef.current = next;
    setTake(next);
  }

  /** Holds the lock on recording `id` (keeps it when it's already this one's). */
  function holdLock(id: string) {
    if (lock.current?.id === id) return;
    lock.current?.release();
    lock.current = { id, release: lockRecording(id) };
  }

  function releaseLock() {
    lock.current?.release();
    lock.current = null;
  }

  /** Back to the start screen (after a discard, "Not now", or a failed start), with the copies listed again. */
  function backToSetup(error: string | null = null) {
    const released = lock.current?.id ?? null;
    releaseLock();
    setCurrentTake(null);
    setSave({ stage: "idle" });
    setUploadKept(null);
    setRecoveryNote(null);
    setFinishDoc(null);
    setNotice(null);
    setSetupError(error);
    setPhase("setup");
    if (db) void loadRecoverable(db, released).then(setRecoverable);
  }

  /** Opens a saved recap — never once the recorder was left (that would pull the person off whatever they're on). */
  function openRecap(recapId: string, query = "") {
    if (!mounted.current) return;
    releaseLock();
    allowLeave();
    router.push(`${meetingRecapHref(recapId)}${query}`);
  }

  /** A new upload's controller (stopping any other); leaving the page aborts it. */
  function startUpload(): AbortController {
    uploadAbort.current?.abort();
    const controller = new AbortController();
    uploadAbort.current = controller;
    return controller;
  }

  function endUpload(controller: AbortController) {
    if (uploadAbort.current === controller) uploadAbort.current = null;
  }

  // ── setup ──────────────────────────────────────────────────────────────────────────────────────────────────────

  function chooseLive(on: boolean) {
    liveChosen.current = true;
    setLive(on);
  }

  function downloadModel() {
    void asrRef.current?.load().catch(() => {});
  }

  function chooseSmaller(smaller: boolean) {
    const asr = asrRef.current;
    if (!asr) return;
    asr.setSmaller(smaller);
    setModel((m) => ({ ...m, smaller, status: null, plan: null }));
    void (async () => {
      const plan = await asr.plan();
      const downloaded = (await downloadedAsrModels()).includes(plan.model);
      setModel((m) => ({ ...m, plan, downloaded }));
    })();
  }

  function turnOnSummary() {
    // Straight from the click: downloading Chrome's model needs it.
    const handle = prepareSummarizer("downloadable", (pct) => setSummary((s) => ({ ...s, pct })));
    setSummary((s) => ({ ...s, pct: 0, failed: false }));
    void handle.then((s) => {
      s?.destroy?.();
      setSummary({ availability: s ? "available" : "downloadable", pct: null, failed: !s });
    });
  }

  // ── recording ──────────────────────────────────────────────────────────────────────────────────────────────────

  function startRecording() {
    // First, while this click still counts as the person's: Chrome's on-device summary, when it's here.
    const availability = summary.availability;
    summarizerRef.current = availability === "available" || availability === "downloading" ? prepareSummarizer(availability) : null;
    const asr = asrRef.current;
    const rec = new MeetingRecorder({
      deviceId: micId || undefined,
      liveTranscript: live,
      asr: live ? asr : null,
      db: db ?? undefined,
      guardUnload: false, // useLeaveGuard asks instead
      onState: (state) => {
        setRecState(state);
        // The clock shows the right time the moment it pauses (or resumes), not up to a tick later.
        if (recorderRef.current === rec) setElapsed(rec.elapsedMs());
      },
      onSegment: (seg) => setLiveState((l) => ({ ...l, segments: [...l.segments, seg] })),
      onPartial: (text) => setLiveState((l) => (l.partial === text ? l : { ...l, partial: text })),
      onStatus: (status) => onRecorderStatus(rec, status),
      onLevel: setLevel,
      onError: (message) => {
        // A failed start is handled where start() rejects.
        if (recorderRef.current !== rec || rec.state === "failed") return;
        setNotice(message);
        void stopRecording();
      },
    });
    recorderRef.current = rec;
    // Held from the start, so another tab never mistakes this recording for a cut-off one.
    holdLock(rec.recordingId);
    stopping.current = false;
    startedAt.current = Date.now();
    setStarting(true);
    setSetupError(null);
    setNotice(null);
    setElapsed(0);
    setLevel(0);
    setMarks([]);
    setPersistent(null);
    setLiveState({ ...IDLE_LIVE, on: live, readyAtMs: live && asr?.ready ? 0 : null });
    rec.start().then(
      () => {
        if (recorderRef.current !== rec) return;
        setStarting(false);
        setPhase("recording");
      },
      (err: unknown) => {
        if (recorderRef.current !== rec) return;
        recorderRef.current = null;
        rec.destroy();
        releaseLock();
        void summarizerRef.current?.then((s) => s?.destroy?.());
        summarizerRef.current = null;
        setStarting(false);
        setSetupError(errorText(err, "Couldn't start the microphone."));
      },
    );
  }

  function onRecorderStatus(rec: MeetingRecorder, s: RecorderStatus) {
    if (recorderRef.current !== rec) return;
    if (s.type === "model") {
      if (s.status === "ready") {
        const at = rec.elapsedMs();
        setLiveState((l) => ({ ...l, readyAtMs: l.readyAtMs ?? at, model: null }));
      } else {
        setLiveState((l) => ({ ...l, model: { status: s.status, detail: s.detail } }));
      }
    } else if (s.type === "lagging") {
      setLiveState((l) => ({ ...l, droppedSec: l.droppedSec + s.droppedSec }));
    } else if (s.type === "live-gap") {
      setLiveState((l) => ({ ...l, missedSec: l.missedSec + s.missedSec }));
    } else if (s.type === "live-transcript-off") {
      setLiveState((l) => ({ ...l, offMessage: s.message, partial: "", model: null }));
    } else if (s.type === "storage") {
      setPersistent(s.persistent);
    } else if (s.type === "auto-stop") {
      setNotice("The recording reached 3 hours, the longest one can be, so it stopped by itself.");
      void stopRecording();
    }
  }

  function markMoment() {
    const at = recorderRef.current?.mark();
    if (at !== null && at !== undefined) setMarks((m) => [...m, at]);
  }

  async function stopRecording() {
    const rec = recorderRef.current;
    if (!rec || stopping.current) return;
    stopping.current = true;
    setProcessing({ step: "finishing" });
    setPhase("processing");
    let result: RecorderResult;
    try {
      result = await rec.stop();
    } catch {
      recorderRef.current = null;
      backToSetup("Nothing was recorded.");
      return;
    }
    recorderRef.current = null;
    const blob = result.blob.size ? result.blob : null;
    const kept = await keepability(blob);
    await carryOn({
      id: result.recordingId,
      blob,
      mime: result.mime,
      audioType: kept.audioType,
      audioNote: kept.note,
      durationMs: result.durationMs,
      startedAt: startedAt.current,
      segments: result.segments,
      marks: result.marks,
      liveTranscriptComplete: result.liveTranscriptComplete,
    });
  }

  // ── processing ─────────────────────────────────────────────────────────────────────────────────────────────────

  /** After Stop, a picked file's transcription, or a recovered copy: the next step for `next`. */
  async function carryOn(next: Take, saved?: RecorderDraft) {
    setCurrentTake(next);
    if (saved && (saved.title || saved.keyPoints || saved.transcript)) {
      enterReview(next, saved, null);
      return;
    }
    if (next.blob && (!next.segments.length || !next.liveTranscriptComplete)) {
      setProcessing({ step: "choose", reason: next.segments.length ? "partial" : "none" });
      setPhase("processing");
      return;
    }
    await writeKeyPoints(next, null);
  }

  async function transcribeTake() {
    const current = takeRef.current;
    const asr = asrRef.current;
    if (!current?.blob || !asr) return;
    const controller = new AbortController();
    transcribing.current = controller;
    setProcessing({ step: "transcribing", progress: null });
    setPhase("processing");
    let audioSec = 0;
    try {
      const segments = await transcribeBlob(current.blob, {
        asr,
        signal: controller.signal,
        onProgress: (p) => {
          if (p.phase === "transcribing") audioSec = p.audioSec;
          if (!controller.signal.aborted) setProcessing({ step: "transcribing", progress: p });
        },
      });
      if (controller.signal.aborted || takeRef.current !== current) return;
      const next: Take = {
        ...current,
        segments,
        liveTranscriptComplete: true,
        durationMs: current.durationMs || Math.round(audioSec * 1000),
      };
      setCurrentTake(next);
      if (db) void db.putRecording(docOf(next));
      await writeKeyPoints(
        next,
        segments.length ? null : "No speech was found in the recording, so there's no transcript. You can still type the key points.",
      );
    } catch (err) {
      if (controller.signal.aborted || takeRef.current !== current) return;
      setProcessing({
        step: "choose",
        reason: current.segments.length ? "partial" : "none",
        error: errorText(err, "Couldn't transcribe the recording."),
      });
    } finally {
      if (transcribing.current === controller) transcribing.current = null;
    }
  }

  function cancelTranscription() {
    transcribing.current?.abort();
    transcribing.current = null;
    setProcessing({ step: "choose", reason: takeRef.current?.segments.length ? "partial" : "none" });
  }

  /** Drafts the key points (Chrome's on-device summary too, when it's here), then the review. */
  async function writeKeyPoints(current: Take, note: string | null) {
    let handle = summarizerRef.current;
    summarizerRef.current = null;
    if (!current.segments.length) {
      void handle?.then((s) => s?.destroy?.());
      handle = null;
    } else if (!handle && summary.availability === "available") {
      handle = prepareSummarizer("available");
    }
    const controller = new AbortController();
    summarizing.current = controller;
    setProcessing({ step: "keypoints", summary: null, usingSummary: !!handle });
    setPhase("processing");
    let bullets: string[] | null = null;
    if (handle) {
      const skipped = new Promise<null>((resolve) => controller.signal.addEventListener("abort", () => resolve(null), { once: true }));
      bullets = await Promise.race([
        summarizeTranscript(handle, current.segments, {
          signal: controller.signal,
          onProgress: (done, total) => {
            if (!controller.signal.aborted) setProcessing({ step: "keypoints", summary: { done, total }, usingSummary: true });
          },
        }),
        skipped,
      ]);
    }
    if (summarizing.current === controller) summarizing.current = null;
    if (takeRef.current !== current) return;
    const day = todayInTimezone(timeZone, new Date(current.startedAt));
    enterReview(
      current,
      {
        title: defaultRecapTitle(day),
        meetingDate: day,
        categoryIds: [],
        keyPoints: draftKeyPoints(current.segments, { roster, marks: current.marks, bullets }),
        transcript: formatTranscript(current.segments),
      },
      note,
    );
  }

  // ── review and saving ──────────────────────────────────────────────────────────────────────────────────────────

  function enterReview(current: Take, values: RecorderDraft, note: string | null) {
    const known = new Set(categories.map((c) => c.id));
    setDraft({
      title: values.title ?? "",
      meetingDate: values.meetingDate || todayInTimezone(timeZone, new Date(current.startedAt)),
      categoryIds: (values.categoryIds ?? []).filter((id) => known.has(id)),
      keyPoints: values.keyPoints ?? "",
      transcript: values.transcript ?? "",
    });
    setKeepAudio(values.keepAudio ?? true);
    setKeepUntil(meetingAudioUntilLabel(new Date(Date.now() + MEETING_AUDIO_KEEP_MS).toISOString(), timeZone, "long"));
    setReviewNote(note);
    setSave({ stage: "idle" });
    setPhase("review");
  }

  async function saveRecap(formData: FormData) {
    const original = takeRef.current;
    if (!original) return;
    // The save's request id, kept with the copy (with the form as it is now) before it's sent: saving again — after an
    // answer that never came, or from the copy after a reload — returns the same recap instead of a second one.
    const current: Take = original.requestId ? original : { ...original, requestId: newMeetingRequestId() };
    if (current !== original) setCurrentTake(current);
    const keep = keepAudio && !!current.blob && !!current.audioType;
    if (current.durationMs > 0)
      formData.set("durationSec", String(Math.min(MEETING_DURATION_MAX_SEC, Math.round(current.durationMs / 1000))));
    if (keep && current.blob && current.audioType) {
      formData.set("audioType", current.audioType);
      formData.set("audioBytes", String(current.blob.size));
      formData.set("audioParts", String(meetingAudioPartCount(current.blob.size)));
    }
    formData.set("requestId", current.requestId!);
    setSave({ stage: "saving" });
    await db?.putRecording(docOf(current, { draft: { ...draft, keepAudio } }));
    let state: MeetingRecapCreateState;
    try {
      state = await createMeetingRecapAction(null, formData);
    } catch {
      if (mounted.current) setSave({ stage: "refused", state: { ok: false, message: OFFLINE } });
      return;
    }
    if (!state?.ok || !state.recapId) {
      if (mounted.current) setSave({ stage: "refused", state: state ?? { ok: false, message: "The recap wasn't saved. Try again." } });
      return;
    }
    const recapId = state.recapId;
    // An earlier try had saved it, and it kept its own text (edited since, or another admin's): the recap's page says
    // so, and the panel too while the recorder stays open (the form still shows this draft).
    const textKept = !!state.textKept;
    if (!keep || state.audioRefused || !current.blob) {
      // Left meanwhile, and refused (the copy stays, and saving it again — the same request id — says so again and
      // offers the download) or the recap kept its own text (the copy, with this draft, stays until the person has
      // seen that). Otherwise nothing is left to upload.
      if (!mounted.current && ((keep && state.audioRefused) || textKept)) return;
      await db?.deleteRecording(current.id);
      if (!mounted.current) return;
      if (state.audioRefused) {
        releaseLock();
        setSave({ stage: "audio-refused", recapId, message: state.audioRefused, textKept });
        return;
      }
      setSave({ stage: "done", recapId, textKept });
      openRecap(recapId, savedQuery(textKept));
      return;
    }
    // From here the recap exists: this browser's copy now waits to finish its upload, even if the tab closes.
    const uploadingDoc = docOf(current, { status: "uploading", recapId, draft: { ...draft, keepAudio: true }, ...(textKept ? { textKept } : {}) });
    const written = !!db && (await db.putRecording(uploadingDoc));
    if (!mounted.current) return; // left while saving: Finish uploading takes it from here
    setUploadKept(written && !!db?.persistent);
    // The same save again (its first answer was lost): some parts may be in already.
    await upload(current, recapId, !!state.duplicate, textKept);
  }

  async function upload(current: Take, recapId: string, resume: boolean, textKept: boolean) {
    if (!current.blob) return;
    const controller = startUpload();
    setSave({ stage: "uploading", recapId, progress: null, textKept });
    let last: UploadProgress | null = null;
    const outcome = await sendRecording(current.blob, {
      recapId,
      audioType: current.audioType,
      resume,
      signal: controller.signal,
      onProgress: (p) => {
        last = p;
        if (!controller.signal.aborted) setSave({ stage: "uploading", recapId, progress: p, textKept });
      },
    });
    endUpload(controller);
    const copy = copyAfterUpload(outcome.kind);
    // Left right as it finished, on a recap that kept its own text: the copy stays, so finishing it opens the recap
    // with that said.
    if (copy === "delete" && (mounted.current || !textKept)) await db?.deleteRecording(current.id);
    // The recap was deleted: an unsaved recording again (its next save is a new recap, with a new request id).
    const unsaved: Take = { ...current, requestId: undefined };
    if (copy === "unsaved") await db?.putRecording(docOf(unsaved, { draft: { ...draft, keepAudio } }));
    // Left meanwhile: nothing more to show, and nobody is taken anywhere. The copy finishes it later.
    if (controller.signal.aborted || !mounted.current) return;
    if (outcome.kind === "complete") {
      setSave({ stage: "done", recapId, textKept });
      openRecap(recapId, savedQuery(textKept));
    } else if (outcome.kind === "failed") {
      setSave({ stage: "upload-failed", recapId, message: outcome.message, progress: last, textKept });
    } else if (outcome.kind === "orphaned") {
      setCurrentTake(unsaved);
      setUploadKept(null);
      setSave({ stage: "refused", state: { ok: false, message: `${outcome.message} Save it again as a new recap.` } });
    } else {
      setSave({ stage: "audio-refused", recapId, message: outcome.message, kept: !!db?.persistent, textKept });
    }
  }

  /** "Open the recap" after the recording was refused or didn't finish uploading. */
  function openSavedRecap() {
    if (save.stage === "upload-failed" || save.stage === "audio-refused") openRecap(save.recapId, savedQuery(save.textKept));
  }

  function retryUpload() {
    const current = takeRef.current;
    if (current && save.stage === "upload-failed") void upload(current, save.recapId, true, !!save.textKept);
  }

  async function discardTake() {
    summarizing.current?.abort();
    transcribing.current?.abort();
    const current = takeRef.current;
    // Let go of it before deleting: a review autosave that's due can't write it back afterwards.
    takeRef.current = null;
    if (current) await db?.deleteRecording(current.id);
    backToSetup();
  }

  // ── a picked file ──────────────────────────────────────────────────────────────────────────────────────────────

  async function openFile(file: File) {
    const problem = checkRecordingFile(file, DECODE_MAX_BYTES);
    if (problem) {
      setSetupError(problem);
      return;
    }
    setSetupError(null);
    setPersistent(null); // a recording's storage status doesn't apply to a picked file
    summarizerRef.current = null;
    setProcessing({ step: "transcribing", progress: null });
    setPhase("processing");
    const kept = await keepability(file);
    const next: Take = {
      id: newMeetingRequestId(),
      blob: file,
      mime: kept.audioType ?? file.type,
      audioType: kept.audioType,
      audioNote: kept.note,
      durationMs: 0,
      startedAt: Date.now(),
      segments: [],
      marks: [],
      liveTranscriptComplete: false,
      fileName: file.name,
    };
    holdLock(next.id);
    setCurrentTake(next);
    // Kept like a recording, so a closed tab comes back to it (the file itself only when it can be uploaded).
    if (db && (await db.putRecording(docOf(next))) && kept.audioType) await db.putChunk(next.id, 0, file);
    await transcribeTake();
  }

  // ── this browser's copies ──────────────────────────────────────────────────────────────────────────────────────

  async function reviewCopy(doc: RecordingDoc) {
    if (!db) return;
    setRecoveryBusy(doc.id);
    const blob = doc.audioPurged ? null : await db.getAudio(doc.id, doc.mime);
    const kept = await keepability(blob);
    const next: Take = {
      id: doc.id,
      blob,
      mime: doc.mime,
      audioType: kept.audioType,
      audioNote: kept.note,
      durationMs: doc.durationMs,
      startedAt: doc.startedAt,
      segments: doc.segments,
      marks: doc.marks,
      liveTranscriptComplete: !!doc.liveTranscriptComplete,
      fileName: doc.fileName,
      requestId: (doc as RecorderDoc).requestId,
    };
    holdLock(doc.id);
    setPersistent(null); // it came from this browser's store: whether that still works says if it's kept
    // Not being recorded (or uploaded) anywhere anymore: a stopped recording from now on.
    await db.putRecording(docOf(next, { ...(doc.draft ? { draft: doc.draft } : {}), ...(doc.audioPurged ? { audioPurged: true } : {}) }));
    setRecoveryBusy(null);
    setNotice(null);
    setSetupError(null);
    await carryOn(next, doc.draft);
  }

  async function finishCopy(doc: RecordingDoc) {
    if (!db || !doc.recapId) return;
    const recapId = doc.recapId;
    holdLock(doc.id);
    setFinishDoc(doc);
    setFinish({ stage: "checking" });
    setPhase("finishing");
    const blob = await db.getAudio(doc.id, doc.mime);
    if (!blob) {
      // Nothing here to finish it with: what reached the portal goes too, so the recap doesn't say "still uploading".
      const abandoned = await abandonServerAudio(recapId);
      if (!mounted.current) return;
      if (!abandoned.ok) {
        setFinish({
          stage: "failed",
          message: `The recording isn't on this computer anymore, so it can't be finished. ${abandoned.message} Until the part on the portal is deleted, the recap says its recording is still uploading — try again in a moment.`,
          retry: true,
        });
        return;
      }
      await db.deleteRecording(doc.id);
      setFinish({
        stage: "over",
        message: "The recording isn't on this computer anymore, so it can't be uploaded. The recap stays, without it.",
        kept: false,
      });
      return;
    }
    const controller = startUpload();
    const outcome = await sendRecording(blob, {
      recapId,
      audioType: normalizeMeetingAudioType(doc.mime),
      resume: true,
      signal: controller.signal,
      onProgress: (progress) => {
        if (!controller.signal.aborted) setFinish({ stage: "uploading", progress });
      },
    });
    endUpload(controller);
    const copy = copyAfterUpload(outcome.kind);
    // A recap that kept its own text opens with that said (`?saved=first`): the copy stays until it can.
    const textKept = !!(doc as RecorderDoc).textKept;
    if (copy === "delete" && (mounted.current || !textKept)) await db.deleteRecording(doc.id);
    // The recap was deleted: back in the list as an unsaved recording, to save as a new recap.
    if (copy === "unsaved") await db.putRecording(asUnsaved(doc));
    // Left meanwhile: nothing more to show, and nobody is taken anywhere.
    if (controller.signal.aborted || !mounted.current) return;
    if (outcome.kind === "complete") {
      setFinish({ stage: "done" });
      openRecap(recapId, savedQuery(textKept, ""));
    } else if (outcome.kind === "failed") {
      setFinish({ stage: "failed", message: outcome.message, retry: true });
    } else if (outcome.kind === "orphaned") {
      setFinishDoc(asUnsaved(doc));
      setFinish({ stage: "orphaned", message: `${outcome.message} It can be saved again as a new recap.` });
    } else {
      setFinish({ stage: "over", message: outcome.message, kept: true });
    }
  }

  /** Discard on "Finish uploading": while the recap still waits for the rest, what reached the portal goes first. */
  async function discardFinishing(doc: RecordingDoc) {
    if (!db) return;
    if (finish.stage === "failed" && doc.recapId) {
      setFinish({ stage: "discarding" });
      const abandoned = await abandonServerAudio(doc.recapId);
      if (!mounted.current) return;
      if (!abandoned.ok) {
        setFinish({ stage: "failed", message: `${abandoned.message} ${NOT_DISCARDED}`, retry: true });
        return;
      }
    }
    await db.deleteRecording(doc.id);
    backToSetup();
  }

  /** Discard in the recovery list (for an interrupted upload, what reached the portal goes first). */
  async function discardCopy(doc: RecordingDoc) {
    if (!db) return;
    setRecoveryNote(null);
    if (doc.status === "uploading" && doc.recapId) {
      setRecoveryBusy(doc.id);
      const abandoned = await abandonServerAudio(doc.recapId);
      if (!mounted.current) return;
      setRecoveryBusy(null);
      if (!abandoned.ok) {
        setRecoveryNote(`${abandoned.message} ${NOT_DISCARDED}`);
        return;
      }
    }
    await db.deleteRecording(doc.id);
    if (lock.current?.id === doc.id) releaseLock();
    setRecoverable(await loadRecoverable(db));
  }

  // ── what's shown ───────────────────────────────────────────────────────────────────────────────────────────────

  const recovery = (
    <RecoveryList
      docs={recoverable}
      timeZone={timeZone}
      busyId={recoveryBusy}
      note={recoveryNote}
      onReview={(doc) => void reviewCopy(doc)}
      onFinish={(doc) => void finishCopy(doc)}
      onDiscard={(doc) => void discardCopy(doc)}
    />
  );

  return (
    <div className="space-y-5">
      <div>
        <h1
          ref={headingRef}
          tabIndex={-1}
          className="font-display text-2xl font-semibold uppercase tracking-wide text-ink-900 focus:outline-none sm:text-3xl"
        >
          {HEADINGS[phase]}
        </h1>
        {phase === "setup" && (
          <p className="mt-1 text-sm text-ink-500 sm:text-base">
            Record the meeting here: it&apos;s transcribed on this computer and the key points are drafted when you stop. Check them, then
            save for everyone.
          </p>
        )}
        {phase === "review" && (
          <p className="mt-1 text-sm text-ink-500 sm:text-base">Check the key points, name the meeting, pick its categories, and save.</p>
        )}
      </div>

      {notice && phase !== "setup" && <Alert tone="warning">{notice}</Alert>}

      {phase === "setup" && (
        <RecorderSetup
          recovery={recovery}
          mics={mics}
          micId={micId}
          onMicChange={setMicId}
          live={live}
          onLiveChange={chooseLive}
          model={model}
          onDownloadModel={downloadModel}
          onSmallerChange={chooseSmaller}
          summary={summary}
          onTurnOnSummary={turnOnSummary}
          starting={starting}
          error={setupError}
          onStart={startRecording}
          onFile={(file) => void openFile(file)}
        />
      )}

      {phase === "recording" && (
        <RecordingPanel
          state={
            recState === "paused" ? "paused" : recState === "stopping" ? "stopping" : recState === "recording" ? "recording" : "starting"
          }
          elapsedMs={elapsed}
          level={level}
          marks={marks}
          live={liveState}
          persistent={persistent}
          onPause={() => recorderRef.current?.pause()}
          onResume={() => recorderRef.current?.resume()}
          onMark={markMoment}
          onStop={() => void stopRecording()}
        />
      )}

      {phase === "processing" && (
        <ProcessingPanel
          step={processing}
          canTranscribe={!!take?.blob}
          onTranscribe={() => void transcribeTake()}
          onSkip={() => take && void writeKeyPoints(take, null)}
          onCancel={cancelTranscription}
          onSkipSummary={() => summarizing.current?.abort()}
        />
      )}

      {phase === "review" && take && (
        <ReviewPanel
          values={draft}
          onChange={(patch) => setDraft((d) => ({ ...d, ...patch }))}
          keepAudio={keepAudio}
          onKeepAudioChange={setKeepAudio}
          audio={{ blob: take.blob, audioType: take.audioType, note: take.audioNote, durationMs: take.durationMs }}
          keepUntil={keepUntil}
          note={reviewNote}
          categories={categories}
          today={today}
          save={save}
          onSave={(formData) => void saveRecap(formData)}
          uploadKept={uploadKept !== false}
          onRetryUpload={retryUpload}
          onOpenRecap={openSavedRecap}
          onDiscard={() => void discardTake()}
        />
      )}

      {phase === "finishing" && finishDoc && (
        <FinishUploadPanel
          title={finishDoc.draft?.title ?? ""}
          state={finish}
          onRetry={() => void finishCopy(finishDoc)}
          onBack={() => backToSetup()}
          onDiscard={() => void discardFinishing(finishDoc)}
          onReviewAsNew={() => void reviewCopy(asUnsaved(finishDoc))}
          onOpenRecap={() => finishDoc.recapId && openRecap(finishDoc.recapId, savedQuery((finishDoc as RecorderDoc).textKept, ""))}
        />
      )}
    </div>
  );
}
