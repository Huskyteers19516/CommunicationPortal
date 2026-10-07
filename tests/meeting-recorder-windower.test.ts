// Meeting recorder: the live transcript's windowing (src/lib/meeting-recorder/stream-windower.ts) with a fake
// model. The fake audio is a ramp that encodes time (sample value = seconds / 1000), and the fake model "hears"
// one word per second ("w0 w1 … w24" for the first window), so overlaps, jumps and times can be checked exactly.
import { describe, expect, it } from "vitest";
import { liveTranscriptCoverage, StreamWindower, type WindowerStats, type WindowerStatus } from "@/lib/meeting-recorder/stream-windower";
import { SAMPLE_RATE } from "@/lib/meeting-recorder/vad";

const FRAME = 1024; // what the microphone tap posts

/** Audio from `fromSec` to `toSec`, each sample holding its own time. */
function ramp(fromSec: number, toSec: number): Float32Array {
  const from = Math.round(fromSec * SAMPLE_RATE);
  const out = new Float32Array(Math.round(toSec * SAMPLE_RATE) - from);
  for (let i = 0; i < out.length; i++) out[i] = (from + i) / SAMPLE_RATE / 1000;
  return out;
}

/** The fake model: one word per whole second the window covers. */
function hear(pcm: Float32Array): string {
  const start = Math.round(pcm[0] * 1000 * SAMPLE_RATE);
  const words: string[] = [];
  for (let i = Math.ceil(start / SAMPLE_RATE) * SAMPLE_RATE - start; i < pcm.length; i += SAMPLE_RATE) {
    words.push(`w${Math.round((start + i) / SAMPLE_RATE)}`);
  }
  return words.length ? `${words.join(" ")}.` : "";
}

function pushFrames(w: StreamWindower, audio: Float32Array) {
  for (let i = 0; i < audio.length; i += FRAME) w.push(audio.subarray(i, Math.min(audio.length, i + FRAME)));
}

function setup(opts: Partial<ConstructorParameters<typeof StreamWindower>[0]> = {}) {
  const finals: { s: number; e: number; text: string }[] = [];
  const partials: string[] = [];
  const statuses: WindowerStatus[] = [];
  const calls: number[] = [];
  const w = new StreamWindower({
    transcribe: async (pcm) => {
      calls.push(Math.round(pcm[0] * 1000));
      return hear(pcm);
    },
    skipSilence: false,
    onFinal: (seg) => finals.push(seg),
    onPartial: (t) => partials.push(t),
    onStatus: (s) => statuses.push(s),
    ...opts,
  });
  return { w, finals, partials, statuses, calls };
}

const words = (finals: { text: string }[]) =>
  finals
    .map((f) => f.text.replace(/\.$/, ""))
    .join(" ")
    .split(" ")
    .filter(Boolean);
const range = (a: number, b: number) => Array.from({ length: b - a }, (_, i) => `w${a + i}`);

describe("StreamWindower", () => {
  it("buffers audio pushed before the model is ready and transcribes it once it is, timed from the start", async () => {
    const { w, finals, calls } = setup();
    pushFrames(w, ramp(0, 60));
    expect(calls).toEqual([]);
    expect(w.pendingSec).toBeCloseTo(60, 1);

    w.setReady();
    await w.flush();
    expect(calls).toEqual([0, 22, 44]);
    expect(finals).toEqual([
      { s: 0, e: 25_000, text: `${range(0, 25).join(" ")}.` },
      { s: 25_000, e: 47_000, text: `${range(25, 47).join(" ")}.` },
      { s: 47_000, e: 60_000, text: `${range(47, 60).join(" ")}.` },
    ]);
    expect(words(finals)).toEqual(range(0, 60)); // every word once: the overlaps were cut
    expect(w.droppedSec).toBe(0);
  });

  it("transcribes as audio arrives when ready, and reports the raw text as a partial", async () => {
    const { w, finals, partials } = setup({ ready: true });
    pushFrames(w, ramp(0, 30));
    await w.flush();
    expect(partials[0]).toBe(`${range(0, 25).join(" ")}.`);
    expect(finals.map((f) => [f.s, f.e])).toEqual([
      [0, 25_000],
      [25_000, 30_000],
    ]);
    expect(words(finals)).toEqual(range(0, 30));
  });

  it("transcribes a short recording once on flush, and skips a tail under 0.4 s", async () => {
    const short = setup({ ready: true });
    pushFrames(short.w, ramp(0, 7));
    await short.w.flush();
    expect(short.finals).toEqual([{ s: 0, e: 7_000, text: `${range(0, 7).join(" ")}.` }]);

    const tiny = setup({ ready: true });
    tiny.w.push(ramp(0, 0.3));
    await tiny.w.flush();
    expect(tiny.calls).toEqual([]);
  });

  it("does nothing on flush when the model never became ready", async () => {
    const { w, calls } = setup();
    pushFrames(w, ramp(0, 40));
    await w.flush();
    expect(calls).toEqual([]);
    expect(w.isReady).toBe(false);
    expect(w.totalSec).toBeCloseTo(40, 1);
  });

  it("jumps to the newest audio when transcription falls behind", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const { w, finals, statuses, calls } = setup({
      ready: true,
      transcribe: async (pcm) => {
        calls.push(Math.round(pcm[0] * 1000));
        if (calls.length === 1) await gate; // the first window takes "forever"
        return hear(pcm);
      },
    });
    pushFrames(w, ramp(0, 120));
    release();
    await w.flush();
    expect(calls[0]).toBe(0);
    expect(calls[1]).toBe(95); // 120 - 25: skipped straight to the newest full window
    expect(statuses).toContainEqual({ type: "lagging", droppedSec: 73, reason: "slow-inference" });
    expect(finals[1]).toEqual({ s: 95_000, e: 120_000, text: `${range(95, 120).join(" ")}.` });
    expect(w.droppedSec).toBeCloseTo(73, 1);
  });

  it("catches up on the backlog it had when the model became ready instead of jumping", async () => {
    const { w, statuses, finals } = setup();
    pushFrames(w, ramp(0, 200));
    w.setReady();
    await w.flush();
    expect(statuses.filter((s) => s.type === "lagging")).toEqual([]);
    expect(words(finals)).toEqual(range(0, 200));
  });

  it("drops the oldest audio when the buffer fills before the model is ready", async () => {
    const { w, statuses, finals } = setup({ backlogSec: 30 }); // buffer = max(3 windows, 30 s + a window) = 75 s
    pushFrames(w, ramp(0, 100));
    const lag = statuses.filter((s) => s.type === "lagging");
    expect(lag.length).toBeGreaterThan(0);
    expect(lag.every((s) => s.type === "lagging" && s.reason === "buffer-full")).toBe(true);
    expect(w.droppedSec).toBeCloseTo(25, 1);
    w.setReady();
    await w.flush();
    expect(finals[0].s).toBe(25_000); // times stay true to the recording
    expect(words(finals)[0]).toBe("w25");
  });

  it("keeps a single huge push from throwing", async () => {
    const { w, finals } = setup({ backlogSec: 30 });
    w.push(ramp(0, 200));
    w.setReady();
    await w.flush();
    expect(finals[0].s).toBe(125_000);
    expect(w.droppedSec).toBeCloseTo(125, 1);
  });

  it("skips mostly silent windows without calling the model", async () => {
    const { w, statuses, calls } = setup({ ready: true, skipSilence: true });
    pushFrames(w, new Float32Array(30 * SAMPLE_RATE));
    await w.flush();
    expect(calls).toEqual([]);
    expect(statuses).toContainEqual({ type: "silence", startMs: 0 });
  });

  it("removes silence hallucinations from mostly silent windows that still get transcribed", async () => {
    // 3 s of "speech" (a buzz in syllables) in a 25 s window: worth transcribing, but mostly silent.
    const audio = new Float32Array(25 * SAMPLE_RATE);
    for (let i = 0; i < 3 * SAMPLE_RATE; i++) {
      const t = i / SAMPLE_RATE;
      const phase = (t * 5) % 1;
      audio[i] = 0.2 * (phase < 0.6 ? Math.sin((Math.PI * phase) / 0.6) : 0) * (Math.sin(2 * Math.PI * 180 * t) + 0.5 * Math.sin(2 * Math.PI * 360 * t));
    }
    const { w, finals } = setup({ ready: true, skipSilence: true, transcribe: async () => "Robot check. Thank you." });
    pushFrames(w, audio);
    await w.flush();
    expect(finals.map((f) => f.text)).toEqual(["Robot check."]);
  });

  it("reports a failed window and carries on with the next", async () => {
    let n = 0;
    const { w, finals, statuses } = setup({
      ready: true,
      transcribe: async (pcm) => {
        if (n++ === 0) throw new Error("Worker crashed");
        return hear(pcm);
      },
    });
    pushFrames(w, ramp(0, 50));
    await w.flush();
    // The first 22 s were only in the failed window (the next one starts at 22 s).
    expect(statuses).toContainEqual({ type: "error", message: "Worker crashed", missedSec: 22 });
    expect(finals[0].s).toBe(22_000); // nothing to de-duplicate against: the whole window is kept
    expect(words(finals)[0]).toBe("w22");
    expect(w.failedSec).toBeCloseTo(22, 1);
    expect(w.droppedSec).toBe(0);
  });

  it("counts only what a failed middle window alone heard, and doesn't join the next window to an older one", async () => {
    // The first and third windows end and start with the same words: they must not be taken for an overlap.
    const replies = ["One two three, the robot is ready.", null, "The robot is ready to drive now.", "Tail words."];
    let n = 0;
    const { w, finals, statuses } = setup({
      ready: true,
      transcribe: async () => {
        const reply = replies[n++];
        if (reply === null) throw new Error("Allocation failed");
        return reply ?? "";
      },
    });
    pushFrames(w, ramp(0, 80)); // windows at 0, 22 (fails), 44 and the tail from 66 s
    await w.flush();
    expect(statuses).toContainEqual({ type: "error", message: "Allocation failed", missedSec: 19 }); // 25–44 s
    expect(w.failedSec).toBeCloseTo(19, 1);
    expect(finals[1]).toEqual({ s: 44_000, e: 69_000, text: "The robot is ready to drive now." });
  });

  it("counts a failed tail", async () => {
    let n = 0;
    const { w, statuses } = setup({
      ready: true,
      transcribe: async (pcm) => {
        if (n++ === 3) throw new Error("Device lost");
        return hear(pcm);
      },
    });
    pushFrames(w, ramp(0, 80));
    await w.flush();
    // The tail runs from 66 s; its first 3 s were in the window before it.
    expect(statuses).toContainEqual({ type: "error", message: "Device lost", missedSec: 11 });
    expect(w.failedSec).toBeCloseTo(11, 1);
  });

  it("transcribes the tail when the window before it failed, even when it's no longer than the overlap", async () => {
    let n = 0;
    const { w, finals } = setup({
      ready: true,
      transcribe: async (pcm) => {
        if (n++ === 1) throw new Error("Timed out");
        return hear(pcm);
      },
    });
    pushFrames(w, ramp(0, 47.2)); // windows at 0 and 22 (fails); the 3.2 s tail from 44 s
    await w.flush();
    expect(words(finals)).toEqual([...range(0, 25), ...range(44, 48)]);
    expect(w.failedSec).toBeCloseTo(19, 1);
  });

  it("doesn't count a failure that comes back after stop()", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const { w, statuses } = setup({
      ready: true,
      transcribe: async () => {
        await gate;
        throw new Error("Worker stopped");
      },
    });
    pushFrames(w, ramp(0, 26));
    w.stop();
    release();
    await new Promise((r) => setTimeout(r, 0));
    expect(w.failedSec).toBe(0);
    expect(statuses.filter((s) => s.type === "error")).toEqual([]);
  });

  it("ignores results that arrive after stop()", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const { w, finals } = setup({
      ready: true,
      transcribe: async (pcm) => {
        await gate;
        return hear(pcm);
      },
    });
    pushFrames(w, ramp(0, 26));
    w.stop();
    release();
    await new Promise((r) => setTimeout(r, 0));
    await w.flush();
    w.push(ramp(26, 60));
    expect(finals).toEqual([]);
  });

  it("refuses an overlap that isn't shorter than the window", () => {
    expect(() => new StreamWindower({ transcribe: async () => "", windowSec: 5, overlapSec: 5 })).toThrow();
  });
});

describe("liveTranscriptCoverage", () => {
  const clean: WindowerStats = { ready: true, totalSec: 600, pendingSec: 2, droppedSec: 0, failedSec: 0 };

  it("is complete when every window ran and the tap heard about as much as was recorded", () => {
    expect(liveTranscriptCoverage(clean, { recordedSec: 600.4, flushed: true })).toEqual({ complete: true, missedSec: 0 });
    // The tap starts a moment after the recording, and pauses drift by a few ms each.
    expect(liveTranscriptCoverage({ ...clean, totalSec: 594 }, { recordedSec: 600, flushed: true }).complete).toBe(true);
    expect(liveTranscriptCoverage({ ...clean, droppedSec: 0.5 }, { recordedSec: 600, flushed: true }).complete).toBe(true);
  });

  it("isn't when a window failed, audio was skipped, or the tap stopped delivering samples", () => {
    expect(liveTranscriptCoverage({ ...clean, failedSec: 19 }, { recordedSec: 600, flushed: true })).toEqual({ complete: false, missedSec: 19 });
    expect(liveTranscriptCoverage({ ...clean, droppedSec: 73 }, { recordedSec: 600, flushed: true })).toEqual({ complete: false, missedSec: 73 });
    expect(liveTranscriptCoverage({ ...clean, totalSec: 480 }, { recordedSec: 600, flushed: true })).toEqual({ complete: false, missedSec: 120 });
  });

  it("isn't when Stop couldn't finish the last windows or the model never got ready", () => {
    expect(liveTranscriptCoverage({ ...clean, pendingSec: 40 }, { recordedSec: 600, flushed: false })).toEqual({ complete: false, missedSec: 40 });
    expect(liveTranscriptCoverage({ ...clean, ready: false, pendingSec: 240, droppedSec: 360 }, { recordedSec: 600, flushed: true })).toEqual({
      complete: false,
      missedSec: 600,
    });
  });

  it("counts the whole recording when there was no live transcript, and what came after it was turned off", () => {
    expect(liveTranscriptCoverage(null, { recordedSec: 125.25, flushed: false })).toEqual({ complete: false, missedSec: 125.3 });
    // Turned off 5 minutes into a 10-minute meeting, with 10 s not yet transcribed.
    expect(liveTranscriptCoverage({ ...clean, totalSec: 300, pendingSec: 10 }, { recordedSec: 600, flushed: false })).toEqual({
      complete: false,
      missedSec: 310,
    });
  });

  it("works on the windower's own numbers", async () => {
    const ok = setup({ ready: true });
    pushFrames(ok.w, ramp(0, 60));
    await ok.w.flush();
    expect(liveTranscriptCoverage(ok.w.stats(), { recordedSec: 60.2, flushed: true }).complete).toBe(true);

    let n = 0;
    const failing = setup({
      ready: true,
      transcribe: async (pcm) => {
        if (n++ === 1) throw new Error("Timed out");
        return hear(pcm);
      },
    });
    pushFrames(failing.w, ramp(0, 60));
    await failing.w.flush();
    expect(failing.w.stats()).toMatchObject({ ready: true, droppedSec: 0 });
    expect(liveTranscriptCoverage(failing.w.stats(), { recordedSec: 60, flushed: true })).toEqual({ complete: false, missedSec: 19 });
  });
});
