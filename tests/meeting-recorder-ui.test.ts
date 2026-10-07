// Meeting recorder: the recorder page's and the edit page's pure helpers (src/lib/meeting-recorder/recorder-ui.ts) —
// default title, progress lines and what status lines announce, the recovery list, the model line, the live
// transcript's hint, which files and recordings can be kept, what an upload's end means for this browser's copy, the
// leave guard, and drafting key points from a transcript. No database.
import { describe, expect, it } from "vitest";
import { MEETING_AUDIO_MAX_BYTES } from "@/lib/meeting-recaps";
import type { MeetingAudioUploadState } from "@/lib/meeting-recaps";
import {
  appendKeyPoints,
  checkRecordingFile,
  copyAfterUpload,
  defaultRecapTitle,
  downloadProgressText,
  draftKeyPoints,
  keptRecording,
  liveTranscriptAnnouncement,
  liveTranscriptDefault,
  liveTranscriptHint,
  looksLikePhone,
  modelLine,
  modelStatusPhrase,
  modelStatusText,
  RECAP_GONE_MESSAGE,
  recorderLeaveMessage,
  recoveryTitle,
  resumeUpload,
  serverAudioToDelete,
  suggestKeyPoints,
  transcribePhaseText,
  transcribeProgressText,
  transcriptSegments,
  uploadFailedHint,
  uploadProgressText,
} from "@/lib/meeting-recorder/recorder-ui";
import { formatTranscript, parseKeyPointLines } from "@/lib/meeting-recorder/transcript-format";
import { FTC_MARKS, FTC_MEETING, FTC_ROSTER } from "./fixtures/ftc-meeting";

const TZ = "America/Los_Angeles";
const MB = 1024 * 1024;

const WEBM = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0]);
const M4A = new Uint8Array([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20]);
const ADTS = new Uint8Array([0xff, 0xf1, 0x50, 0x80, 0, 0, 0, 0]);

describe("defaultRecapTitle", () => {
  it("names a recap after its meeting's day until the admin does", () => {
    expect(defaultRecapTitle("2026-10-07")).toBe("Meeting — Wed, Oct 7");
  });
});

describe("uploadProgressText", () => {
  it("says how many parts and how many megabytes are up", () => {
    expect(uploadProgressText({ partsDone: 3, partsTotal: 5, bytesDone: 9 * MB, bytesTotal: 14 * MB })).toBe(
      "Uploading the recording… 3 of 5 (9.0 MB of 14 MB)",
    );
    expect(uploadProgressText({ partsDone: 0, partsTotal: 1, bytesDone: 0, bytesTotal: 12_000 })).toBe(
      "Uploading the recording… 0 of 1 (0 bytes of 12 KB)",
    );
  });
});

describe("recoveryTitle", () => {
  // 2026-10-07 01:42 UTC = Tue, Oct 6, 6:42 PM in Los Angeles.
  const startedAt = Date.UTC(2026, 9, 7, 1, 42);
  it("describes an unsaved recording by when it started, how long it is, and its lines", () => {
    expect(recoveryTitle({ status: "recording", startedAt, durationMs: 47 * 60_000 + 12_000, segments: new Array(312).fill(0) }, TZ)).toBe(
      "Unsaved recording from Tue, Oct 6, 6:42 PM · 47:12 · 312 lines",
    );
    expect(recoveryTitle({ status: "stopped", startedAt, durationMs: 500, segments: [] }, TZ)).toBe(
      "Unsaved recording from Tue, Oct 6, 6:42 PM",
    );
    expect(recoveryTitle({ status: "stopped", startedAt, durationMs: 65_000, segments: [{}], fileName: "team.m4a" }, TZ)).toBe(
      "Unsaved recap of “team.m4a” · 1:05 · 1 line",
    );
  });
  it("names the recap whose upload didn't finish", () => {
    expect(recoveryTitle({ status: "uploading", startedAt, durationMs: 0, segments: [], draft: { title: "Build sync" } }, TZ)).toBe(
      "“Build sync” didn't finish uploading its recording",
    );
    expect(recoveryTitle({ status: "uploading", startedAt, durationMs: 0, segments: [] }, TZ)).toBe(
      "“A recap” didn't finish uploading its recording",
    );
  });
});

describe("model lines", () => {
  it("shows the model, its download, and what it uses", () => {
    expect(modelLine({ label: "Accurate model", sizeMB: 286, note: "uses the graphics chip" })).toBe(
      "Accurate model · 286 MB · uses the graphics chip",
    );
  });
  it("puts the model's progress into words", () => {
    expect(modelStatusText("downloading", { pct: 41.6, loadedMB: 30.2, totalMB: 73.3 })).toBe(
      "Downloading the speech model… 42% (30 of 73 MB)",
    );
    expect(modelStatusText("downloading", { pct: 5 })).toBe("Downloading the speech model… 5%");
    expect(modelStatusText("loading")).toBe("Starting the speech model…");
    expect(modelStatusText("fallback", { message: "timed out" })).toMatch(/graphics chip.*standard model is starting/);
    expect(modelStatusText("fallback", { message: "stalled", reason: "download" })).toBe(
      "The download stalled, so the smaller standard model is starting instead…",
    );
    expect(modelStatusText("error", { message: "no network" })).toBe("The speech model couldn't start (no network).");
    expect(modelStatusText("ready")).toBeNull();
  });
  it("puts a whole-file transcription's progress into words", () => {
    expect(transcribeProgressText({ phase: "decoding" })).toBe("Reading the recording…");
    expect(transcribeProgressText({ phase: "model", status: "loading", detail: {} })).toBe("Starting the speech model…");
    expect(transcribeProgressText({ phase: "transcribing", pct: 33.4 })).toBe("Transcribing… 33%");
  });
  it("announces steps, never the percent (status lines; the numbers are shown beside them)", () => {
    expect(downloadProgressText({ pct: 41.6, loadedMB: 30.2, totalMB: 73.3 })).toBe("42% (30 of 73 MB)");
    expect(modelStatusPhrase("downloading", { pct: 41.6, loadedMB: 30.2, totalMB: 73.3 })).toBe("Downloading the speech model…");
    expect(modelStatusPhrase("loading")).toBe("Starting the speech model…");
    expect(modelStatusPhrase("error", { message: "no network" })).toBe("The speech model couldn't start (no network).");
    expect(modelStatusPhrase("ready")).toBeNull();
    expect(transcribePhaseText({ phase: "decoding" })).toBe("Reading the recording…");
    expect(transcribePhaseText({ phase: "model", status: "downloading", detail: { pct: 12 } })).toBe("Downloading the speech model…");
    expect(transcribePhaseText({ phase: "transcribing", pct: 33.4 })).toBe("Transcribing…");
  });
});

describe("the live transcript", () => {
  it("starts on, except on a phone or tablet without WebGPU", () => {
    expect(liveTranscriptDefault({ phone: false, webgpu: false })).toBe(true);
    expect(liveTranscriptDefault({ phone: true, webgpu: true })).toBe(true);
    expect(liveTranscriptDefault({ phone: true, webgpu: false })).toBe(false);
  });
  it("tells phones and tablets from computers", () => {
    expect(looksLikePhone("Mozilla/5.0 (Linux; Android 14; Pixel 7) Mobile Safari/537.36", true)).toBe(true);
    expect(looksLikePhone("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)", true)).toBe(true);
    // iPadOS asks for the desktop site but has a touch screen.
    expect(looksLikePhone("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15", true)).toBe(true);
    expect(looksLikePhone("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/141.0", false)).toBe(false);
    expect(looksLikePhone("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/141.0", false)).toBe(false);
  });
  it("counts down to the first text once the model is ready, then says the audio is safe", () => {
    expect(liveTranscriptHint({ elapsedMs: 5000, readyAtMs: null, lines: 0 })).toBeNull();
    expect(liveTranscriptHint({ elapsedMs: 7000, readyAtMs: 0, lines: 0 })).toBe("First text in about 18 s…");
    expect(liveTranscriptHint({ elapsedMs: 31_000, readyAtMs: 0, lines: 0 })).toBe("First text any moment now…");
    expect(liveTranscriptHint({ elapsedMs: 91_000, readyAtMs: 0, lines: 0 })).toMatch(
      /^No text yet after 90 seconds — keep going, the audio is safe/,
    );
    // A model that got ready late catches up on the buffered audio: give it a moment first.
    expect(liveTranscriptHint({ elapsedMs: 100_000, readyAtMs: 95_000, lines: 0 })).toBe("First text any moment now…");
    expect(liveTranscriptHint({ elapsedMs: 130_000, readyAtMs: 95_000, lines: 0 })).toMatch(/^No text yet/);
    expect(liveTranscriptHint({ elapsedMs: 200_000, readyAtMs: 0, lines: 3 })).toBeNull();
  });
  it("announces milestones only: the model's step, then “any moment now” and the 90-second line — never a countdown or a percent", () => {
    const say = (over: Partial<Parameters<typeof liveTranscriptAnnouncement>[0]>) =>
      liveTranscriptAnnouncement({ model: null, elapsedMs: 0, readyAtMs: 0, lines: 0, ...over });
    for (let ms = 0; ms < 25_000; ms += 1000) expect(say({ elapsedMs: ms }), String(ms)).toBeNull();
    for (const pct of [0, 1, 42, 99]) {
      expect(say({ model: { status: "downloading", detail: { pct, loadedMB: pct, totalMB: 286 } }, readyAtMs: null })).toBe(
        "Downloading the speech model…",
      );
    }
    expect(say({ model: { status: "loading", detail: {} }, readyAtMs: null })).toBe("Starting the speech model…");
    expect(say({ elapsedMs: 31_000 })).toBe("First text any moment now…");
    expect(say({ elapsedMs: 91_000 })).toMatch(/^No text yet after 90 seconds/);
    expect(say({ elapsedMs: 100_000, readyAtMs: 95_000 })).toBe("First text any moment now…");
    expect(say({ elapsedMs: 40_000, lines: 2 })).toBeNull();
    expect(say({ readyAtMs: null })).toBeNull();
  });
});

describe("checkRecordingFile", () => {
  const max = 200 * MB;
  it("takes audio and video files and the usual extensions", () => {
    expect(checkRecordingFile({ name: "meeting.m4a", type: "audio/x-m4a", size: 5 * MB }, max)).toBeNull();
    expect(checkRecordingFile({ name: "call.mp4", type: "video/mp4", size: 5 * MB }, max)).toBeNull();
    expect(checkRecordingFile({ name: "voice.opus", type: "", size: 5 * MB }, max)).toBeNull();
  });
  it("turns away other files, empty ones, and ones too big to transcribe", () => {
    expect(checkRecordingFile({ name: "notes.pdf", type: "application/pdf", size: MB }, max)).toMatch(
      /^That doesn't look like a recording/,
    );
    expect(checkRecordingFile({ name: "empty.mp3", type: "audio/mpeg", size: 0 }, max)).toBe("That file is empty.");
    expect(checkRecordingFile({ name: "long.wav", type: "audio/wav", size: 300 * MB }, max)).toBe(
      "That file is 300 MB. Recordings up to 200 MB can be transcribed here.",
    );
  });
});

describe("keptRecording", () => {
  it("keeps what the server accepts, by the first bytes", () => {
    expect(keptRecording(WEBM, 12_000)).toEqual({ audioType: "audio/webm", note: null });
    expect(keptRecording(M4A, 5 * MB)).toEqual({ audioType: "audio/mp4", note: null });
  });
  it("says why a recording can't be kept", () => {
    expect(keptRecording(ADTS, MB).audioType).toBeNull();
    expect(keptRecording(ADTS, MB).note).toMatch(/^This kind of file can't be kept/);
    expect(keptRecording(WEBM, MEETING_AUDIO_MAX_BYTES + 1)).toEqual({
      audioType: null,
      note: "This recording is 100 MB, and recordings up to 100 MB can be kept, so the recap is saved without it.",
    });
    expect(keptRecording(WEBM, 0).audioType).toBeNull();
  });
});

describe("drafting key points", () => {
  it("drafts timed key points from the recorder's segments, with marks and the summary's bullets", () => {
    const text = draftKeyPoints(FTC_MEETING, { roster: FTC_ROSTER, marks: FTC_MARKS });
    const points = parseKeyPointLines(text);
    expect(points.length).toBeGreaterThanOrEqual(5);
    expect(points.every((p) => p.atMs !== null)).toBe(true);
    expect(text).toMatch(/Decision: .*four-bar intake/);
    expect(text).toMatch(/To do \(Alice, by Friday\)/);

    const withSummary = draftKeyPoints(FTC_MEETING, {
      roster: FTC_ROSTER,
      bullets: ["The team will bring the robot to the scrimmage at Troy High School on October 31."],
    });
    expect(withSummary).toMatch(/scrimmage at Troy High School on October 31/);
  });

  it("keeps a decision and an owned to-do said right after it (a short recording, one time window)", () => {
    const text = draftKeyPoints(
      [
        { s: 0, text: "OK team, we decided to build the four-bar intake for the scrimmage." },
        { s: 4000, text: "Alice will order the motors by Friday." },
      ],
      { roster: FTC_ROSTER },
    );
    expect(text).toBe(
      "[0:00] Decision: we decided to build the four-bar intake for the scrimmage.\n[0:04] To do (Alice, by Friday): order the motors.",
    );
  });

  it("reads a saved transcript's lines as segments (an untimed line takes the time before it)", () => {
    expect(transcriptSegments("[0:05] Okay.\nStill the intro.\n[1:10] Intake time.")).toEqual({
      segments: [
        { s: 5000, text: "Okay." },
        { s: 5000, text: "Still the intro." },
        { s: 70_000, text: "Intake time." },
      ],
      timed: true,
    });
    expect(transcriptSegments("First.\nSecond.").timed).toBe(false);
    expect(transcriptSegments("").segments).toEqual([]);
  });

  it("suggests key points from the transcript box: timed when it is, plain when it isn't", () => {
    const timed = suggestKeyPoints(formatTranscript(FTC_MEETING), { roster: FTC_ROSTER });
    expect(parseKeyPointLines(timed).every((p) => p.atMs !== null)).toBe(true);
    expect(timed).toMatch(/To do \(Alice, by Friday\)/);

    const plain = suggestKeyPoints(FTC_MEETING.map((s) => s.text).join("\n"), { roster: FTC_ROSTER });
    expect(plain).not.toMatch(/^\[/m);
    expect(plain).toMatch(/Decision: .*four-bar intake/);
    expect(suggestKeyPoints("   \n")).toBe("");
  });

  it("adds suggestions under typed key points without repeating one", () => {
    expect(
      appendKeyPoints("[1:00] Decision: four-bar intake.\n", "[1:00] Decision: four-bar intake.\n[3:44] To do (Alice): order motors."),
    ).toBe("[1:00] Decision: four-bar intake.\n[3:44] To do (Alice): order motors.");
    expect(appendKeyPoints("", "[3:44] To do: order motors.")).toBe("[3:44] To do: order motors.");
    expect(appendKeyPoints("- We met.", "[0:10] we met.")).toBe("- We met.");
  });
});

describe("uploading to a saved recap, and this browser's copy", () => {
  const state = (over: Partial<MeetingAudioUploadState> = {}): MeetingAudioUploadState => ({
    audioType: "audio/webm",
    audioParts: 3,
    audioBytes: 7 * MB,
    present: [0],
    expired: false,
    complete: false,
    ...over,
  });

  it("finishing an interrupted upload: only a deleted recap is “orphaned”; any other failure keeps the copy to try again", () => {
    expect(resumeUpload({ ok: false, gone: true }, 7 * MB)).toEqual({ kind: "orphaned", message: RECAP_GONE_MESSAGE });
    for (const message of ["Please sign in to continue.", "Only people with admin access can record and change meeting recaps.", "Something went wrong. Please try again."]) {
      expect(resumeUpload({ ok: false, gone: false, message }, 7 * MB)).toEqual({
        kind: "failed",
        message: `Couldn't check the upload with the portal. ${message}`,
      });
    }
    expect(resumeUpload({ ok: true, state: state({ complete: true, present: [0, 1, 2] }) }, 7 * MB)).toEqual({ kind: "complete" });
    expect(resumeUpload({ ok: true, state: state({ audioParts: 0, audioType: null, audioBytes: 0, present: [] }) }, 7 * MB)).toMatchObject({
      kind: "over",
      message: expect.stringMatching(/saved without its recording/),
    });
    expect(resumeUpload({ ok: true, state: state({ expired: true }) }, 7 * MB)).toMatchObject({ kind: "over", message: expect.stringMatching(/3 days are up/) });
    expect(resumeUpload({ ok: true, state: state() }, 7 * MB + 1)).toMatchObject({ kind: "failed" });
    expect(resumeUpload({ ok: true, state: state({ present: [0, 2] }) }, 7 * MB)).toEqual({ kind: "resume", present: [0, 2], audioType: "audio/webm" });
  });

  it("the copy goes only once the portal has the whole recording; after “orphaned” it's an unsaved recording again", () => {
    expect(copyAfterUpload("complete")).toBe("delete");
    expect(copyAfterUpload("failed")).toBe("keep");
    expect(copyAfterUpload("over")).toBe("keep");
    expect(copyAfterUpload("orphaned")).toBe("unsaved");
  });

  it("discarding a copy deletes what reached the portal only while it's still uploading there", () => {
    expect(serverAudioToDelete(state())).toBe(true);
    expect(serverAudioToDelete(state({ present: [] }))).toBe(true);
    expect(serverAudioToDelete(state({ complete: true, present: [0, 1, 2] }))).toBe(false); // the recording is all there: it stays
    expect(serverAudioToDelete(state({ expired: true }))).toBe(false);
    expect(serverAudioToDelete(state({ audioParts: 0, audioType: null, audioBytes: 0, present: [] }))).toBe(false);
  });

  it("a failed upload says the copy stays only when this browser could keep it", () => {
    expect(uploadFailedHint(true)).toMatch(/^The recording stays on this computer/);
    expect(uploadFailedHint(false)).toMatch(/^This browser can't keep the recording after this tab closes/);
    expect(uploadFailedHint(false)).toMatch(/download the recording/);
  });
});

describe("leaving the recorder", () => {
  const leave = (over: Partial<Parameters<typeof recorderLeaveMessage>[0]>) =>
    recorderLeaveMessage({ phase: "setup", saveStage: "idle", finishStage: "checking", keptHere: true, uploadKept: null, hasAudio: true, ...over });

  it("asks while recording, processing, or reviewing what isn't saved, saying whether this browser keeps it", () => {
    expect(leave({})).toBeNull();
    expect(leave({ phase: "recording" })).toMatch(/^Leave the recorder\? The recording stops\. What was recorded so far stays on this computer/);
    expect(leave({ phase: "recording", keptHere: false })).toMatch(/can't keep it, so it will be lost/);
    expect(leave({ phase: "processing" })).toMatch(/^Leave without saving\? The recording stays on this computer/);
    for (const saveStage of ["idle", "saving", "refused"] as const) {
      expect(leave({ phase: "review", saveStage })).toMatch(/^Leave without saving\?/);
      expect(leave({ phase: "review", saveStage, keptHere: false })).toMatch(/can't keep the recording, so it will be lost/);
    }
  });

  it("asks while an upload runs (it stops), saying whether it can be finished later", () => {
    expect(leave({ phase: "review", saveStage: "uploading", uploadKept: true })).toMatch(/The upload stops; open Record a meeting on this computer again/);
    expect(leave({ phase: "review", saveStage: "uploading", uploadKept: false })).toMatch(/can't be uploaded later/);
    expect(leave({ phase: "finishing", finishStage: "uploading" })).toMatch(/^Leave while the recording uploads\?/);
    expect(leave({ phase: "finishing", finishStage: "failed" })).toBeNull();
  });

  it("asks while a saved recap's recording is only in this tab; not once it's on the portal or kept here", () => {
    expect(leave({ phase: "review", saveStage: "upload-failed", uploadKept: true })).toBeNull();
    expect(leave({ phase: "review", saveStage: "upload-failed", uploadKept: false })).toMatch(/^Leave without the recording\? This browser can't keep it/);
    expect(leave({ phase: "review", saveStage: "audio-refused" })).toMatch(/download it first/);
    expect(leave({ phase: "review", saveStage: "audio-refused", hasAudio: false })).toBeNull();
    expect(leave({ phase: "review", saveStage: "done" })).toBeNull();
  });
});
