// Meeting recorder: the speech model's worker proxy (src/components/meetings/recorder/engine/asr-client.ts) with a
// fake Worker — model choice, WebGPU → CPU fallback in a fresh worker (a network failure isn't the graphics chip's),
// idle and build timeouts, transfers, dispose — and the worker's own report of failed requests during a load.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AsrClient,
  AsrNetworkError,
  type AsrStatus,
  type AsrStatusDetail,
  chooseAsrSetup,
  isSafariBelow26,
} from "@/components/meetings/recorder/engine/asr-client";

type Msg = Record<string, unknown> & { type: string; id: number };
type Handler = (msg: Msg, w: FakeWorker) => void;

class FakeWorker {
  static all: FakeWorker[] = [];
  static handler: Handler = () => {};
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  received: { msg: Msg; transfer: Transferable[] }[] = [];
  terminated = false;
  constructor(
    readonly url: string,
    readonly opts: unknown,
  ) {
    FakeWorker.all.push(this);
  }
  postMessage(msg: Msg, transfer: Transferable[] = []) {
    this.received.push({ msg, transfer });
    queueMicrotask(() => FakeWorker.handler(msg, this));
  }
  reply(data: Record<string, unknown>) {
    if (!this.terminated) this.onmessage?.({ data });
  }
  terminate() {
    this.terminated = true;
  }
}

const probeReply = (gpu: { webgpu: boolean; fp16: boolean }): Handler => (msg, w) => {
  if (msg.type === "probe") w.reply({ type: "probe:ok", id: msg.id, ...gpu });
};

function client(opts: ConstructorParameters<typeof AsrClient>[0] = {}) {
  const events: [AsrStatus, AsrStatusDetail][] = [];
  const asr = new AsrClient({ ...opts, onStatus: (s, d) => events.push([s, d]) });
  return { asr, events };
}

beforeEach(() => {
  FakeWorker.all = [];
  vi.stubGlobal("Worker", FakeWorker);
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("chooseAsrSetup", () => {
  it("uses the accurate model only on WebGPU with 16-bit floats, unless a smaller download is wanted", () => {
    expect(chooseAsrSetup({ webgpu: true, fp16: true })).toEqual({ model: "small", device: "webgpu" });
    expect(chooseAsrSetup({ webgpu: true, fp16: false })).toEqual({ model: "base", device: "wasm" });
    expect(chooseAsrSetup({ webgpu: false, fp16: false })).toEqual({ model: "base", device: "wasm" });
    expect(chooseAsrSetup({ webgpu: true, fp16: true }, { smaller: true })).toEqual({ model: "base", device: "wasm" });
  });

  it("spots Safari before 26 (which needs onnxruntime's plain wasm build without WebGPU)", () => {
    vi.stubGlobal("navigator", { vendor: "Apple Computer, Inc.", userAgent: "Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Version/17.4 Safari/605.1.15" });
    expect(isSafariBelow26()).toBe(true);
    vi.stubGlobal("navigator", { vendor: "Apple Computer, Inc.", userAgent: "Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Version/26.0 Safari/605.1.15" });
    expect(isSafariBelow26()).toBe(false);
    vi.stubGlobal("navigator", { vendor: "Google Inc.", userAgent: "Mozilla/5.0 Chrome/141.0 Safari/537.36" });
    expect(isSafariBelow26()).toBe(false);
  });
});

describe("AsrClient", () => {
  it("probes once and loads the accurate model on a capable graphics chip, passing progress through", async () => {
    FakeWorker.handler = (msg, w) => {
      probeReply({ webgpu: true, fp16: true })(msg, w);
      if (msg.type === "load") {
        w.reply({ type: "status", status: "loading", detail: { model: msg.model } });
        w.reply({ type: "status", status: "downloading", detail: { model: msg.model, pct: 50, loadedMB: 143, totalMB: 286 } });
        w.reply({ type: "load:ok", id: msg.id, model: msg.model, device: msg.device });
      }
    };
    const { asr, events } = client();
    expect(await asr.probe()).toEqual({ webgpu: true, fp16: true });
    const [first, again] = await Promise.all([asr.load(), asr.load()]);
    expect(first).toEqual({ model: "small", device: "webgpu" });
    expect(again).toEqual(first);
    expect(asr.ready).toEqual(first);
    const w = FakeWorker.all[0];
    expect(FakeWorker.all).toHaveLength(1);
    expect(w.url).toBe("/asr/v1/asr-worker.js");
    expect(w.opts).toEqual({ type: "module" });
    expect(w.received.filter((r) => r.msg.type === "probe")).toHaveLength(1);
    expect(w.received.find((r) => r.msg.type === "load")?.msg).toMatchObject({ model: "small", device: "webgpu", ortVariant: "asyncify" });
    expect(events).toEqual([
      ["loading", { model: "small" }],
      ["downloading", { model: "small", pct: 50, loadedMB: 143, totalMB: 286 }],
      ["ready", { model: "small", device: "webgpu" }],
    ]);
  });

  it("falls back to the standard model on the CPU, in a fresh worker, when WebGPU fails", async () => {
    FakeWorker.handler = (msg, w) => {
      probeReply({ webgpu: true, fp16: true })(msg, w);
      if (msg.type === "load" && msg.device === "webgpu") w.reply({ type: "error", id: msg.id, message: "Failed to compile shader" });
      if (msg.type === "load" && msg.device === "wasm") w.reply({ type: "load:ok", id: msg.id, model: msg.model, device: msg.device });
    };
    const { asr, events } = client();
    expect(await asr.load()).toEqual({ model: "base", device: "wasm" });
    expect(FakeWorker.all).toHaveLength(2);
    expect(FakeWorker.all[0].terminated).toBe(true);
    expect(FakeWorker.all[1].received.map((r) => r.msg.type)).toEqual(["load"]);
    expect(events).toContainEqual(["fallback", { model: "base", device: "wasm", message: "Failed to compile shader", reason: "gpu" }]);
  });

  it("remembers a WebGPU build that timed out: a reload after a stuck transcription goes straight to the CPU", async () => {
    FakeWorker.handler = (msg, w) => {
      probeReply({ webgpu: true, fp16: true })(msg, w);
      if (msg.type === "load" && msg.device === "webgpu") {
        w.reply({ type: "status", status: "loading", detail: { model: "small" } });
        w.reply({ type: "status", status: "downloading", detail: { model: "small", pct: 50 } });
        w.reply({ type: "status", status: "downloading", detail: { model: "small", pct: 100 } });
        w.reply({ type: "status", status: "loading", detail: { model: "small" } }); // building… and nothing more
      }
      if (msg.type === "load" && msg.device === "wasm") w.reply({ type: "load:ok", id: msg.id, model: msg.model, device: msg.device });
      // transcriptions never finish
    };
    const { asr, events } = client();
    const loading = asr.load();
    await vi.advanceTimersByTimeAsync(61_000);
    expect(await loading).toEqual({ model: "base", device: "wasm" });
    expect(events.find(([s]) => s === "fallback")?.[1]).toMatchObject({ reason: "gpu" });
    expect(await asr.plan()).toEqual({ model: "base", device: "wasm" });

    const stuck = asr.transcribe(new Float32Array(16_000), { timeoutMs: 5000 }).catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(5_001);
    expect(String(await stuck)).toMatch(/longer than 5 seconds/);
    expect(await asr.load()).toEqual({ model: "base", device: "wasm" });
    expect(FakeWorker.all).toHaveLength(3);
    expect(FakeWorker.all[2].received.map((r) => [r.msg.type, r.msg.device])).toEqual([["load", "wasm"]]);
    expect(events.filter(([s]) => s === "fallback")).toHaveLength(1);
  });

  it("doesn't blame the graphics chip for a stalled download: the next load tries the accurate model again", async () => {
    let webgpuLoads = 0;
    FakeWorker.handler = (msg, w) => {
      probeReply({ webgpu: true, fp16: true })(msg, w);
      if (msg.type === "load" && msg.device === "webgpu") {
        if (webgpuLoads++ === 0) {
          w.reply({ type: "status", status: "loading", detail: { model: "small" } });
          w.reply({ type: "status", status: "downloading", detail: { model: "small", pct: 10 } }); // then the network drops
        } else w.reply({ type: "load:ok", id: msg.id, model: msg.model, device: msg.device });
      }
      if (msg.type === "load" && msg.device === "wasm") w.reply({ type: "load:ok", id: msg.id, model: msg.model, device: msg.device });
    };
    const { asr, events } = client();
    const loading = asr.load();
    await vi.advanceTimersByTimeAsync(61_000);
    expect(await loading).toEqual({ model: "base", device: "wasm" }); // the smaller download, for now
    expect(events.find(([s]) => s === "fallback")?.[1]).toMatchObject({ reason: "download", message: expect.stringMatching(/longer than 60 seconds/) });
    expect(await asr.plan()).toEqual({ model: "small", device: "webgpu" });

    const stuck = asr.transcribe(new Float32Array(16_000), { timeoutMs: 5000 }).catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(5_001);
    await stuck;
    expect(await asr.load()).toEqual({ model: "small", device: "webgpu" });
  });

  it("doesn't blame the graphics chip when a request fails before any download progress (offline, a blocked host)", async () => {
    let webgpuLoads = 0;
    FakeWorker.handler = (msg, w) => {
      probeReply({ webgpu: true, fp16: true })(msg, w);
      if (msg.type === "load" && msg.device === "webgpu") {
        if (webgpuLoads++ === 0) {
          w.reply({ type: "status", status: "loading", detail: { model: "small" } });
          w.reply({ type: "error", id: msg.id, message: "Failed to fetch", network: true }); // config.json never arrived
        } else w.reply({ type: "load:ok", id: msg.id, model: msg.model, device: msg.device });
      }
      if (msg.type === "load" && msg.device === "wasm") w.reply({ type: "load:ok", id: msg.id, model: msg.model, device: msg.device });
    };
    const { asr, events } = client();
    expect(await asr.load()).toEqual({ model: "base", device: "wasm" });
    expect(FakeWorker.all[0].terminated).toBe(true);
    expect(events).toContainEqual(["fallback", { model: "base", device: "wasm", message: "Failed to fetch", reason: "download" }]);
    expect(await asr.plan()).toEqual({ model: "small", device: "webgpu" });

    // Once the network is back, a reload (after a stuck transcription) tries the accurate model again.
    const stuck = asr.transcribe(new Float32Array(16_000), { timeoutMs: 5000 }).catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(5_001);
    await stuck;
    expect(await asr.load()).toEqual({ model: "small", device: "webgpu" });
    expect(events.filter(([s]) => s === "fallback")).toHaveLength(1);
  });

  it("doesn't blame the graphics chip when a request fails while building (onnxruntime's wasm from the CDN)", async () => {
    FakeWorker.handler = (msg, w) => {
      probeReply({ webgpu: true, fp16: true })(msg, w);
      if (msg.type === "load" && msg.device === "webgpu") {
        w.reply({ type: "status", status: "loading", detail: { model: "small" } });
        w.reply({ type: "status", status: "downloading", detail: { model: "small", pct: 100 } });
        w.reply({ type: "status", status: "loading", detail: { model: "small" } });
        w.reply({ type: "error", id: msg.id, message: "no available backend found", network: true });
      }
      if (msg.type === "load" && msg.device === "wasm") w.reply({ type: "load:ok", id: msg.id, model: msg.model, device: msg.device });
    };
    const { asr, events } = client();
    expect(await asr.load()).toEqual({ model: "base", device: "wasm" });
    expect(events.find(([s]) => s === "fallback")?.[1]).toMatchObject({ reason: "download", message: "no available backend found" });
    expect(await asr.plan()).toEqual({ model: "small", device: "webgpu" });
  });

  it("still blames the graphics chip for a failure before any download when no request failed (a cached model's build)", async () => {
    FakeWorker.handler = (msg, w) => {
      probeReply({ webgpu: true, fp16: true })(msg, w);
      if (msg.type === "load" && msg.device === "webgpu") {
        w.reply({ type: "status", status: "loading", detail: { model: "small" } });
        w.reply({ type: "error", id: msg.id, message: "Failed to compile shader", network: false });
      }
      if (msg.type === "load" && msg.device === "wasm") w.reply({ type: "load:ok", id: msg.id, model: msg.model, device: msg.device });
    };
    const { asr, events } = client();
    expect(await asr.load()).toEqual({ model: "base", device: "wasm" });
    expect(events.find(([s]) => s === "fallback")?.[1]).toMatchObject({ reason: "gpu" });
    expect(await asr.plan()).toEqual({ model: "base", device: "wasm" });
  });

  it("rejects with an AsrNetworkError when even the standard model can't be fetched", async () => {
    FakeWorker.handler = (msg, w) => {
      probeReply({ webgpu: false, fp16: false })(msg, w);
      if (msg.type === "load") w.reply({ type: "error", id: msg.id, message: "Failed to fetch", network: true });
    };
    const { asr, events } = client();
    const err = await asr.load().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AsrNetworkError);
    expect(String(err)).toMatch(/Failed to fetch/);
    expect(asr.state).toBe("idle");
    expect(events.at(-1)).toEqual(["error", { message: "Failed to fetch" }]);
  });

  it("falls back when the worker crashes while building on WebGPU", async () => {
    FakeWorker.handler = (msg, w) => {
      probeReply({ webgpu: true, fp16: true })(msg, w);
      if (msg.type === "load" && msg.device === "webgpu") {
        w.reply({ type: "status", status: "loading", detail: { model: "small" } });
        queueMicrotask(() => w.onerror?.({ message: "GPU device lost", preventDefault() {} }));
      }
      if (msg.type === "load" && msg.device === "wasm") w.reply({ type: "load:ok", id: msg.id, model: msg.model, device: msg.device });
    };
    const { asr, events } = client();
    expect(await asr.load()).toEqual({ model: "base", device: "wasm" });
    expect(FakeWorker.all[0].terminated).toBe(true);
    expect(events.find(([s]) => s === "fallback")?.[1]).toMatchObject({ reason: "gpu", message: "The speech model stopped working (GPU device lost)." });
    expect(await asr.plan()).toEqual({ model: "base", device: "wasm" });
  });

  it("doesn't count a WebGPU load stopped by Smaller download as a failure", async () => {
    FakeWorker.handler = (msg, w) => {
      probeReply({ webgpu: true, fp16: true })(msg, w);
      if (msg.type === "load" && msg.device === "wasm") w.reply({ type: "load:ok", id: msg.id, model: msg.model, device: msg.device });
      // the WebGPU load never finishes
    };
    const { asr, events } = client();
    const loading = asr.load().catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(1_000);
    asr.setSmaller(true);
    expect(String(await loading)).toMatch(/stopped/);
    expect(events.some(([s]) => s === "fallback")).toBe(false);
    expect(await asr.load()).toEqual({ model: "base", device: "wasm" });
  });

  it("gives WebGPU a minute to build after the download, then falls back", async () => {
    FakeWorker.handler = (msg, w) => {
      probeReply({ webgpu: true, fp16: true })(msg, w);
      if (msg.type === "load" && msg.device === "webgpu") w.reply({ type: "status", status: "loading", detail: { model: "small" } }); // …and nothing more
      if (msg.type === "load" && msg.device === "wasm") w.reply({ type: "load:ok", id: msg.id, model: msg.model, device: msg.device });
    };
    const { asr, events } = client();
    const loading = asr.load();
    await vi.advanceTimersByTimeAsync(59_000);
    expect(asr.state).toBe("loading");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await loading).toEqual({ model: "base", device: "wasm" });
    expect(events.find(([s]) => s === "fallback")?.[1].message).toMatch(/longer than 60 seconds/);
  });

  it("lets a slow download take as long as progress keeps coming, and fails a stalled one", async () => {
    let progressTimer: ReturnType<typeof setInterval> | undefined;
    FakeWorker.handler = (msg, w) => {
      probeReply({ webgpu: false, fp16: false })(msg, w);
      if (msg.type === "load") {
        let pct = 0;
        progressTimer = setInterval(() => {
          pct += 1;
          if (pct <= 10) w.reply({ type: "status", status: "downloading", detail: { model: "base", pct } }); // then it stalls
        }, 30_000);
      }
    };
    const { asr, events } = client();
    const loading = asr.load().catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(300_000); // 5 minutes of progress every 30 s: still going
    expect(asr.state).toBe("loading");
    await vi.advanceTimersByTimeAsync(61_000); // no progress for a minute
    const err = await loading;
    clearInterval(progressTimer);
    expect(err).toBeInstanceOf(Error);
    expect(asr.state).toBe("idle");
    expect(events.at(-1)?.[0]).toBe("error");
    expect(FakeWorker.all[0].terminated).toBe(true);
  });

  it("transfers the samples to the worker and returns the text and chunks", async () => {
    FakeWorker.handler = (msg, w) => {
      probeReply({ webgpu: false, fp16: false })(msg, w);
      if (msg.type === "load") w.reply({ type: "load:ok", id: msg.id, model: msg.model, device: msg.device });
      if (msg.type === "transcribe") {
        const samples = new Float32Array(msg.pcm as ArrayBuffer, msg.byteOffset as number, msg.length as number);
        w.reply({ type: "transcribe:ok", id: msg.id, text: `heard ${samples.length}`, chunks: [{ text: " heard", timestamp: [0, 1.5] }] });
      }
    };
    const { asr } = client({ smaller: true });
    await asr.load();
    const backing = new Float32Array(100);
    const pcm = backing.subarray(10, 60);
    const result = await asr.transcribe(pcm, { timestamps: true });
    expect(result).toEqual({ text: "heard 50", chunks: [{ text: " heard", timestamp: [0, 1.5] }] });
    const sent = FakeWorker.all[0].received.find((r) => r.msg.type === "transcribe");
    expect(sent?.transfer).toEqual([backing.buffer]);
    expect(sent?.msg).toMatchObject({ byteOffset: 40, length: 50, timestamps: true });
  });

  it("stops a worker that doesn't finish a transcription in time, so the next load starts fresh", async () => {
    FakeWorker.handler = (msg, w) => {
      probeReply({ webgpu: false, fp16: false })(msg, w);
      if (msg.type === "load") w.reply({ type: "load:ok", id: msg.id, model: msg.model, device: msg.device });
    };
    const { asr } = client();
    await asr.load();
    const pending = asr.transcribe(new Float32Array(16_000), { timeoutMs: 5000 }).catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(5_001);
    expect(String(await pending)).toMatch(/longer than 5 seconds/);
    expect(asr.state).toBe("idle");
    expect(FakeWorker.all[0].terminated).toBe(true);
    await expect(asr.transcribe(new Float32Array(10))).rejects.toThrow("isn't loaded");
    await asr.load();
    expect(FakeWorker.all).toHaveLength(2);
  });

  it("reports a crashed worker and refuses calls after dispose", async () => {
    FakeWorker.handler = (msg, w) => {
      probeReply({ webgpu: false, fp16: false })(msg, w);
      if (msg.type === "load") w.reply({ type: "load:ok", id: msg.id, model: msg.model, device: msg.device });
    };
    const { asr, events } = client();
    await asr.load();
    FakeWorker.all[0].onerror?.({ message: "out of memory", preventDefault() {} });
    expect(asr.state).toBe("idle");
    expect(events.at(-1)).toEqual(["error", { message: "The speech model stopped working (out of memory)." }]);
    asr.dispose();
    asr.dispose();
    expect(asr.state).toBe("disposed");
    await expect(asr.load()).rejects.toThrow("closed");
  });

  it("drops the loaded model when Smaller download changes", async () => {
    FakeWorker.handler = (msg, w) => {
      probeReply({ webgpu: true, fp16: true })(msg, w);
      if (msg.type === "load") w.reply({ type: "load:ok", id: msg.id, model: msg.model, device: msg.device });
    };
    const { asr } = client();
    expect(await asr.load()).toEqual({ model: "small", device: "webgpu" });
    asr.setSmaller(true);
    expect(asr.state).toBe("idle");
    expect(await asr.plan()).toEqual({ model: "base", device: "wasm" });
    expect(await asr.load()).toEqual({ model: "base", device: "wasm" });
  });

  it("says no graphics chip when the worker can't even be probed", async () => {
    FakeWorker.handler = () => {}; // never answers
    const { asr } = client();
    const probing = asr.probe();
    await vi.advanceTimersByTimeAsync(20_001);
    expect(await probing).toEqual({ webgpu: false, fp16: false });
  });
});

// The worker itself (public/asr/v1/asr-worker.js) with transformers mocked: does a failed load say whether a request
// failed along the way?
const transformers = vi.hoisted(() => ({
  pipeline: (() => Promise.resolve({ dispose: () => Promise.resolve() })) as (...args: unknown[]) => Promise<unknown>,
  env: { fetch: undefined as unknown, backends: { onnx: { wasm: {} } } } as Record<string, unknown> & { fetch: unknown },
}));
vi.mock("../public/asr/v1/transformers.min.js", () => transformers);

type FetchReply = { ok: boolean; status: number } | Error;

describe("asr-worker", () => {
  async function startWorker(replies: Record<string, FetchReply | (() => Promise<FetchReply>)>) {
    const fetched: string[] = [];
    transformers.env.fetch = async (url: string) => {
      fetched.push(url);
      const r = replies[url] ?? { ok: true, status: 200 };
      const reply = typeof r === "function" ? await r() : r;
      if (reply instanceof Error) throw reply;
      return reply;
    };
    const posted: Record<string, unknown>[] = [];
    const self = {
      postMessage: (m: Record<string, unknown>) => posted.push(m),
      navigator: {},
      crossOriginIsolated: false,
      onmessage: null as ((e: { data: unknown }) => void) | null,
    };
    vi.stubGlobal("self", self);
    vi.resetModules();
    const workerPath = "../public/asr/v1/asr-worker.js"; // not a literal: keeps tsc out of the bundled library
    await import(/* @vite-ignore */ workerPath);
    let id = 0;
    const load = async (model: "small" | "base" = "base") => {
      const msgId = ++id;
      self.onmessage?.({ data: { type: "load", id: msgId, model, device: "wasm", ortVariant: "asyncify" } });
      await vi.waitFor(() => {
        if (!posted.some((m) => m.id === msgId)) throw new Error("no answer yet");
      });
      return posted.find((m) => m.id === msgId);
    };
    return { load, fetched, posted };
  }

  /** A pipeline() that fetches these files (through env.fetch, like transformers), then fails with `buildError`. */
  function pipelineFetching(files: string[], buildError?: Error) {
    transformers.pipeline = async () => {
      const fetch = transformers.env.fetch as (url: string) => Promise<{ ok: boolean; status: number }>;
      for (const f of files) {
        const res = await fetch(f);
        if (!res.ok && res.status !== 404 && res.status !== 416) throw new Error(`Could not locate file: "${f}".`);
      }
      if (buildError) throw buildError;
      return { dispose: () => Promise.resolve() };
    };
  }

  it("flags a load that failed because a request failed (offline, DNS, a blocked host)", async () => {
    pipelineFetching(["config.json", "tokenizer.json"]);
    const { load, fetched } = await startWorker({ "config.json": new TypeError("Failed to fetch") });
    expect(await load()).toEqual({ type: "error", id: 1, message: "Failed to fetch", network: true });
    expect(fetched).toEqual(["config.json"]);
  });

  it("flags a server error, but not a missing optional file (404) or an empty file's size check (416)", async () => {
    pipelineFetching(["config.json", "generation_config.json", "added_tokens.json", "tokenizer.json"]);
    const { load } = await startWorker({
      "generation_config.json": { ok: false, status: 404 },
      "added_tokens.json": { ok: false, status: 416 },
      "tokenizer.json": { ok: false, status: 503 },
    });
    expect(await load()).toEqual({ type: "error", id: 1, message: 'Could not locate file: "tokenizer.json".', network: true });
  });

  it("doesn't flag a build failure when every request went through", async () => {
    pipelineFetching(["config.json", "generation_config.json"], new Error("Failed to compile shader"));
    const { load } = await startWorker({ "generation_config.json": { ok: false, status: 404 } });
    expect(await load()).toEqual({ type: "error", id: 1, message: "Failed to compile shader" });
  });

  it("flags a failed request even when transformers swallows it and fails later", async () => {
    transformers.pipeline = async () => {
      const fetch = transformers.env.fetch as (url: string) => Promise<unknown>;
      await fetch("ort-wasm-simd-threaded.asyncify.wasm").catch(() => null); // "Failed to pre-load WASM binary"
      throw new Error("no available backend found");
    };
    const { load } = await startWorker({ "ort-wasm-simd-threaded.asyncify.wasm": new TypeError("Failed to fetch") });
    expect(await load()).toEqual({ type: "error", id: 1, message: "no available backend found", network: true });
  });

  it("starts each load with a clean slate, even when an earlier load's request fails late", async () => {
    let failLate: (e: Error) => void = () => {};
    let call = 0;
    transformers.pipeline = async () => {
      const fetch = transformers.env.fetch as (url: string) => Promise<{ ok: boolean; status: number }>;
      if (call++ === 0) {
        void fetch("decoder_model_merged_quantized.onnx").catch(() => null); // still downloading when the load fails
        await fetch("config.json");
        throw new Error("unreachable");
      }
      failLate(new TypeError("Failed to fetch"));
      await Promise.resolve();
      throw new Error("Failed to compile shader");
    };
    const { load } = await startWorker({
      "decoder_model_merged_quantized.onnx": () => new Promise<FetchReply>((resolve) => (failLate = resolve)),
      "config.json": { ok: false, status: 500 },
    });
    expect(await load()).toMatchObject({ type: "error", id: 1, network: true });
    expect(await load()).toEqual({ type: "error", id: 2, message: "Failed to compile shader" });
  });

  it("answers a load that worked with load:ok", async () => {
    pipelineFetching(["config.json", "generation_config.json"]);
    const { load, posted } = await startWorker({ "generation_config.json": { ok: false, status: 404 } });
    expect(await load()).toEqual({ type: "load:ok", id: 1, model: "base", device: "wasm" });
    expect(posted.filter((m) => m.type === "status").map((m) => m.status)).toEqual(["loading"]);
  });
});
