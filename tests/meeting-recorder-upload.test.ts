// Meeting recorder: uploading a recording in parts (src/components/meetings/recorder/engine/upload.ts) — order,
// exact part sizes, resuming with the parts the server has, retries on network errors, stopping on a refusal — and
// cutting a long recording into pieces for transcription (src/lib/meeting-recorder/vad.ts pieceRanges). No database.
import { describe, expect, it } from "vitest";
import { partCount, type SendPartResult, uploadRecording, type UploadProgress } from "@/components/meetings/recorder/engine/upload";
import { MEETING_AUDIO_PART_BYTES } from "@/lib/meeting-recaps";
import { pieceRanges, SAMPLE_RATE, speechShare } from "@/lib/meeting-recorder/vad";

const PART = 1000; // small parts keep the tests fast

function recording(bytes: number): Blob {
  const data = new Uint8Array(bytes);
  data.set([0x1a, 0x45, 0xdf, 0xa3]); // WebM magic
  for (let i = 4; i < bytes; i++) data[i] = i % 251;
  return new Blob([data], { type: "audio/webm;codecs=opus" });
}

type Sent = { recapId: string; position: number; size: number; name: string; type: string; firstByte: number };

function server(opts: { failTimes?: Record<number, number>; refuseAt?: number; total?: number } = {}) {
  const sent: Sent[] = [];
  const failures = { ...opts.failTimes };
  const have = new Set<number>();
  const sendPart = async (fd: FormData): Promise<SendPartResult> => {
    const position = Number(fd.get("position"));
    if (failures[position]) {
      failures[position]--;
      throw new TypeError("Failed to fetch");
    }
    if (position === opts.refuseAt) return { ok: false, message: "The team's file storage is full." };
    const file = fd.get("file") as File;
    const bytes = new Uint8Array(await file.arrayBuffer());
    sent.push({ recapId: String(fd.get("recapId")), position, size: file.size, name: file.name, type: file.type, firstByte: bytes[0] });
    have.add(position);
    return { ok: true, complete: opts.total !== undefined && have.size === opts.total };
  };
  return { sent, sendPart, have };
}

describe("uploadRecording", () => {
  it("sends every part in order, all but the last exactly the part size", async () => {
    const blob = recording(3500);
    const { sent, sendPart } = server({ total: 4 });
    const progress: UploadProgress[] = [];
    const res = await uploadRecording(blob, { recapId: "recap1", audioType: "audio/webm", partBytes: PART, sendPart, onProgress: (p) => progress.push(p) });
    expect(res).toEqual({ ok: true, complete: true });
    expect(sent.map((s) => [s.position, s.size])).toEqual([
      [0, 1000],
      [1, 1000],
      [2, 1000],
      [3, 500],
    ]);
    expect(sent[0]).toMatchObject({ recapId: "recap1", name: "recording-1.webm", type: "audio/webm", firstByte: 0x1a });
    expect(progress[0]).toEqual({ partsDone: 0, partsTotal: 4, bytesDone: 0, bytesTotal: 3500 });
    expect(progress.at(-1)).toEqual({ partsDone: 4, partsTotal: 4, bytesDone: 3500, bytesTotal: 3500 });
  });

  it("finishes an interrupted upload by skipping the parts the server has", async () => {
    const { sent, sendPart } = server({ total: 2 }); // the server counts only this run's parts here
    const progress: UploadProgress[] = [];
    const res = await uploadRecording(recording(3500), {
      recapId: "r",
      audioType: "audio/webm",
      partBytes: PART,
      present: [0, 2, 9],
      sendPart,
      onProgress: (p) => progress.push(p),
    });
    expect(sent.map((s) => s.position)).toEqual([1, 3]);
    expect(progress[0]).toEqual({ partsDone: 2, partsTotal: 4, bytesDone: 2000, bytesTotal: 3500 });
    expect(res).toEqual({ ok: true, complete: true });
  });

  it("is complete straight away when the server has every part", async () => {
    const { sent, sendPart } = server();
    expect(await uploadRecording(recording(1500), { recapId: "r", audioType: "audio/webm", partBytes: PART, present: [0, 1], sendPart })).toEqual({
      ok: true,
      complete: true,
    });
    expect(sent).toEqual([]);
  });

  it("retries a part after network errors, with growing pauses", async () => {
    const { sent, sendPart } = server({ failTimes: { 1: 2 }, total: 3 });
    const res = await uploadRecording(recording(2500), { recapId: "r", audioType: "audio/webm", partBytes: PART, sendPart, backoffMs: 1 });
    expect(res).toEqual({ ok: true, complete: true });
    expect(sent.map((s) => s.position)).toEqual([0, 1, 2]);
  });

  it("gives up after 3 retries without calling it a refusal", async () => {
    const { sent, sendPart } = server({ failTimes: { 1: 4 } });
    const res = await uploadRecording(recording(2500), { recapId: "r", audioType: "audio/webm", partBytes: PART, sendPart, backoffMs: 1 });
    expect(res).toMatchObject({ ok: false, refused: false, partsDone: 1 });
    expect(sent.map((s) => s.position)).toEqual([0]);
  });

  it("stops at a refusal with the server's message", async () => {
    const { sent, sendPart } = server({ refuseAt: 1 });
    const res = await uploadRecording(recording(2500), { recapId: "r", audioType: "audio/webm", partBytes: PART, sendPart });
    expect(res).toEqual({ ok: false, message: "The team's file storage is full.", refused: true, partsDone: 1 });
    expect(sent.map((s) => s.position)).toEqual([0]);
  });

  it("stops when aborted", async () => {
    const controller = new AbortController();
    const { sent, sendPart } = server();
    const res = await uploadRecording(recording(2500), {
      recapId: "r",
      audioType: "audio/webm",
      partBytes: PART,
      signal: controller.signal,
      sendPart: async (fd) => {
        const r = await sendPart(fd);
        controller.abort();
        return r;
      },
    });
    expect(res).toMatchObject({ ok: false, refused: false, partsDone: 1 });
    expect(sent).toHaveLength(1);
  });

  it("names parts by the recording's type and counts parts like the server", async () => {
    const { sent, sendPart } = server();
    await uploadRecording(new Blob([new Uint8Array(10)], { type: "audio/mp4" }), { recapId: "r", audioType: "audio/x-m4a", partBytes: PART, sendPart });
    expect(sent[0]).toMatchObject({ name: "recording-1.m4a", type: "audio/mp4" });
    expect(partCount(MEETING_AUDIO_PART_BYTES * 2 + 1)).toBe(3);
    expect(partCount(MEETING_AUDIO_PART_BYTES)).toBe(1);
  });
});

describe("pieceRanges", () => {
  it("covers a long recording in ~4-minute pieces cut at the quietest moment nearby", () => {
    const seconds = 600;
    const pcm = new Float32Array(seconds * SAMPLE_RATE).fill(0.1);
    // A silent second at 245 s and at 492 s: the cuts should land inside them.
    pcm.fill(0, 245 * SAMPLE_RATE, 246 * SAMPLE_RATE);
    pcm.fill(0, 492 * SAMPLE_RATE, 493 * SAMPLE_RATE);
    const ranges = pieceRanges(pcm);
    expect(ranges).toHaveLength(3);
    expect(ranges[0][0]).toBe(0);
    expect(ranges.at(-1)?.[1]).toBe(pcm.length);
    for (let i = 1; i < ranges.length; i++) expect(ranges[i][0]).toBe(ranges[i - 1][1]);
    expect(ranges[0][1] / SAMPLE_RATE).toBeGreaterThanOrEqual(245);
    expect(ranges[0][1] / SAMPLE_RATE).toBeLessThanOrEqual(246);
    expect(ranges[1][1] / SAMPLE_RATE).toBeGreaterThanOrEqual(492);
    expect(ranges[1][1] / SAMPLE_RATE).toBeLessThanOrEqual(493);
  });

  it("keeps a short recording in one piece", () => {
    expect(pieceRanges(new Float32Array(30 * SAMPLE_RATE))).toEqual([[0, 30 * SAMPLE_RATE]]);
    expect(pieceRanges(new Float32Array(0))).toEqual([[0, 0]]);
  });

  it("measures speech over a span of 1-second blocks", () => {
    const blocks = [true, false, false, true, true];
    expect(speechShare(blocks, 0, 2)).toBe(0.5);
    expect(speechShare(blocks, 3.2, 3.4)).toBe(1); // at least one block
    expect(speechShare(blocks, 1, 99)).toBe(0.5);
    expect(speechShare([], 0, 1)).toBe(0);
  });
});
