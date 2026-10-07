// The page's side of the speech model: a proxy for the Web Worker in /asr/v1/asr-worker.js (protocol documented
// there), ported from VoiceCollector's whisper-client.js. Browser only.
//
// Every call has a timeout, so a stuck worker only stops transcription — the page and the recording carry on. Model
// choice: a graphics chip with WebGPU and 16-bit floats gets the accurate whisper-small.en (q4, ~286 MB); anything
// else, "Smaller download", or a WebGPU attempt that fails or stalls gets whisper-base.en on the CPU (q8, ~73 MB).
// The WebGPU attempt is timed from when the download finishes (some machines take minutes to compile shaders, and
// a slow download must not count against them); downloads only time out when no progress arrives for a minute.
// A WebGPU build that fails or times out is remembered: every later load (after a stuck transcription, say) goes
// straight to the standard model. A stalled download, or a load the worker says had a request fail (offline, a
// blocked host), isn't the graphics chip's fault, so it isn't remembered.
//
//   const asr = new AsrClient({ onStatus: (status, detail) => … });   // spawns nothing yet
//   await asr.probe();                       // { webgpu, fp16 } — cheap, cached
//   await asr.load();                        // download + build; idempotent; { model, device }
//   const { text, chunks } = await asr.transcribe(pcm, { timestamps: true });  // pcm's buffer is transferred
//   asr.dispose();

import type { AsrChunk } from "@/lib/meeting-recorder/transcript-text";

export type { AsrChunk };
export type AsrModel = "small" | "base";
export type AsrDevice = "webgpu" | "wasm";
/**
 * Status events: `downloading` (detail.pct / loadedMB / totalMB), `loading` (building the model — silent on WebGPU
 * while shaders compile), `ready` (detail.model / device), `fallback` (the accurate model didn't work out; switching
 * to the standard model on the CPU, detail.message says why and detail.reason what failed), `error` (detail.message;
 * load failed or the worker died).
 */
export type AsrStatus = "downloading" | "loading" | "ready" | "fallback" | "error";
/**
 * Why a `fallback`: `gpu` = building the model on the graphics chip failed or timed out; `download` = its download
 * stalled, or a request failed (offline, a blocked host, a server error).
 */
export type AsrFallbackReason = "gpu" | "download";
export type AsrStatusDetail = {
  model?: AsrModel;
  device?: AsrDevice;
  pct?: number;
  loadedMB?: number;
  totalMB?: number;
  message?: string;
  reason?: AsrFallbackReason;
};
export type AsrStatusListener = (status: AsrStatus, detail: AsrStatusDetail) => void;
export type AsrProbe = { webgpu: boolean; fp16: boolean; adapterInfo?: { vendor: string; architecture: string; description: string } };
export type AsrResult = { text: string; chunks: AsrChunk[] };
export type AsrState = "idle" | "loading" | "ready" | "disposed";

export const ASR_WORKER_URL = "/asr/v1/asr-worker.js";
/** transformers.js keeps downloaded models and wasm in this Cache Storage cache (set in the worker). */
export const ASR_CACHE_NAME = "huskyteers-asr";

/** What the setup screen says about each model. */
export const ASR_MODELS: Record<AsrModel, { label: string; sizeMB: number; note: string; id: string; revision: string; decoderFile: string }> = {
  small: {
    label: "Accurate model",
    sizeMB: 286,
    note: "uses the graphics chip",
    id: "onnx-community/whisper-small.en",
    revision: "482fb8ba081b6e906f92efe103622316b2a0cc69",
    decoderFile: "decoder_model_merged_q4.onnx",
  },
  base: {
    label: "Standard model",
    sizeMB: 73,
    note: "runs on any computer",
    id: "onnx-community/whisper-base.en",
    revision: "51eefc0af78b103839eda9e7e4f4186acc6517fe",
    decoderFile: "decoder_model_merged_quantized.onnx",
  },
};

const PROBE_MS = 20_000;
/** A download that sends no progress for this long has stalled. */
const DOWNLOAD_IDLE_MS = 60_000;
/** Building the model after the download: WebGPU gets this long to compile before falling back to the CPU… */
const WEBGPU_BUILD_MS = 60_000;
/** …and the CPU build this long. */
const WASM_BUILD_MS = 180_000;

/**
 * Safari before 26 without WebGPU can't run onnxruntime's "asyncify" wasm build (copied from transformers 4.3.0's
 * env.js). Decided here on the page: navigator.vendor isn't reliable inside a worker.
 */
export function isSafariBelow26(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  const isSafari =
    (navigator.vendor || "").indexOf("Apple") > -1 && !ua.match(/CriOS|FxiOS|EdgiOS|OPiOS|mercury|brave/i) && !ua.includes("Chrome") && !ua.includes("Android");
  if (!isSafari) return false;
  const m = ua.match(/Version\/(\d+)/);
  return m ? parseInt(m[1], 10) < 26 : false;
}

/** The model and device load() tries first. Never q8 weights on WebGPU (they hang its backend). */
export function chooseAsrSetup(probe: AsrProbe, opts: { smaller?: boolean } = {}): { model: AsrModel; device: AsrDevice } {
  return probe.webgpu && probe.fp16 && !opts.smaller ? { model: "small", device: "webgpu" } : { model: "base", device: "wasm" };
}

/** Which models this browser has already downloaded (best effort; [] when Cache Storage can't be read). */
export async function downloadedAsrModels(): Promise<AsrModel[]> {
  try {
    if (typeof caches === "undefined" || !(await caches.has(ASR_CACHE_NAME))) return [];
    const urls = (await (await caches.open(ASR_CACHE_NAME)).keys()).map((r) => r.url);
    return (Object.keys(ASR_MODELS) as AsrModel[]).filter((m) => {
      const { id, revision, decoderFile } = ASR_MODELS[m];
      return urls.some((u) => u.includes(`${id}/resolve/${revision}/`) && u.endsWith(`/${decoderFile}`));
    });
  } catch {
    return [];
  }
}

/** "Remove downloaded model": deletes the models and wasm this browser keeps. Resolves whether anything was removed. */
export async function deleteDownloadedAsrModels(): Promise<boolean> {
  try {
    return typeof caches !== "undefined" && (await caches.delete(ASR_CACHE_NAME));
  } catch {
    return false;
  }
}

/** Where a load is: `start` (before any download: a cached model builds silently from here), `download`, `build`. */
type LoadProgress = { phase: "start" | "download" | "build" };

type Pending = {
  resolve: (msg: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  /** A status from the worker while this call is waiting: the timeout to use from now on. */
  onStatus?: (status: string) => number | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
  timeoutMs: number;
  label: string;
};

export class AsrTimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} took longer than ${Math.round(ms / 1000)} seconds.`);
    this.name = "AsrTimeoutError";
  }
}

/** A load failed and the worker saw a request fail along the way (`network: true` on its error): not the graphics chip. */
export class AsrNetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AsrNetworkError";
  }
}

export class AsrClient {
  private readonly workerUrl: string;
  private readonly listeners = new Set<AsrStatusListener>();
  private worker: Worker | null = null;
  private seq = 0;
  private readonly pending = new Map<number, Pending>();
  private probed: Promise<AsrProbe> | null = null;
  private loading: Promise<{ model: AsrModel; device: AsrDevice }> | null = null;
  private smaller: boolean;
  private currentState: AsrState = "idle";
  private loaded: { model: AsrModel; device: AsrDevice } | null = null;
  /** Bumped by kill(): a load started before it must not carry on. */
  private generation = 0;
  /** The accurate model failed to build on this graphics chip: use the standard one from now on. */
  private webgpuFailed = false;

  constructor(opts: { smaller?: boolean; onStatus?: AsrStatusListener; workerUrl?: string } = {}) {
    this.workerUrl = opts.workerUrl ?? ASR_WORKER_URL;
    this.smaller = !!opts.smaller;
    if (opts.onStatus) this.listeners.add(opts.onStatus);
  }

  get state(): AsrState {
    return this.currentState;
  }

  /** The loaded model and device (null until ready). */
  get ready(): { model: AsrModel; device: AsrDevice } | null {
    return this.currentState === "ready" ? this.loaded : null;
  }

  /** Listen to status events; returns the unsubscribe function. */
  subscribe(listener: AsrStatusListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * "Smaller download": use the standard model even where the accurate one would run. A model already loading or
   * loaded is dropped, so the next load() picks again. Turning it off asks for the accurate model again, so the
   * graphics chip gets another try even after it failed.
   */
  setSmaller(smaller: boolean): void {
    if (this.smaller === smaller) return;
    this.smaller = smaller;
    if (!smaller) this.webgpuFailed = false;
    if (this.currentState === "loading" || this.currentState === "ready") this.kill();
  }

  private emit(status: AsrStatus, detail: AsrStatusDetail = {}) {
    for (const l of this.listeners) {
      try {
        l(status, detail);
      } catch {
        // a listener's bug mustn't break loading
      }
    }
  }

  private spawn(): Worker {
    if (this.currentState === "disposed") throw new Error("The speech model was closed.");
    if (this.worker) return this.worker;
    const w = new Worker(this.workerUrl, { type: "module" });
    w.onmessage = (e: MessageEvent<Record<string, unknown>>) => {
      const m = e.data || {};
      if (m.type === "status") {
        const status = String(m.status);
        const detail = (m.detail || {}) as AsrStatusDetail;
        for (const p of this.pending.values()) {
          const next = p.onStatus?.(status);
          if (next !== undefined) this.arm(p, next);
        }
        if (status === "downloading" || status === "loading") this.emit(status, detail);
        return;
      }
      const p = this.pending.get(Number(m.id));
      if (!p) return;
      this.pending.delete(Number(m.id));
      clearTimeout(p.timer);
      if (m.type === "error") {
        const message = String(m.message || "The speech model failed.");
        p.reject(m.network === true ? new AsrNetworkError(message) : new Error(message));
      } else p.resolve(m);
    };
    w.onerror = (e) => {
      e.preventDefault();
      const error = new Error(`The speech model stopped working${e.message ? ` (${e.message})` : ""}.`);
      if (this.currentState === "loading") {
        // The load in flight decides what's next (from WebGPU: the standard model in a fresh worker).
        this.terminate(error);
        return;
      }
      if (this.currentState === "ready") this.emit("error", { message: error.message });
      this.kill(error);
    };
    this.worker = w;
    return w;
  }

  private arm(p: Pending, ms: number) {
    clearTimeout(p.timer);
    p.timeoutMs = ms;
    p.timer = setTimeout(() => {
      for (const [id, q] of this.pending) {
        if (q === p) this.pending.delete(id);
      }
      p.reject(new AsrTimeoutError(p.label, ms));
    }, ms);
  }

  private call(
    msg: Record<string, unknown>,
    opts: { timeoutMs: number; label: string; transfer?: Transferable[]; onStatus?: (status: string) => number | undefined },
  ): Promise<Record<string, unknown>> {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      let w: Worker;
      try {
        w = this.spawn(); // throws when closed, or when the browser can't start module workers
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
        return;
      }
      const p: Pending = { resolve, reject, onStatus: opts.onStatus, timer: undefined, timeoutMs: opts.timeoutMs, label: opts.label };
      this.pending.set(id, p);
      this.arm(p, opts.timeoutMs);
      try {
        w.postMessage({ ...msg, id }, opts.transfer ?? []);
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(p.timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  /** Terminates the worker; waiting calls fail with `reason`. */
  private terminate(reason: Error) {
    const w = this.worker;
    this.worker = null;
    if (w) {
      try {
        w.terminate();
      } catch {
        // already gone
      }
    }
    const waiting = [...this.pending.values()];
    this.pending.clear();
    for (const p of waiting) {
      clearTimeout(p.timer);
      p.reject(reason);
    }
  }

  /** Stops everything (stuck worker, switching models): back to "idle", so load() starts over. */
  private kill(reason: Error = new Error("The speech model was stopped.")) {
    this.generation++;
    this.loaded = null;
    this.loading = null;
    if (this.currentState !== "disposed") this.currentState = "idle";
    this.terminate(reason);
  }

  /** What this browser's graphics chip can do (cached). Never rejects: { webgpu: false } when unknown. */
  probe(): Promise<AsrProbe> {
    if (!this.probed) {
      this.probed = this.call({ type: "probe" }, { timeoutMs: PROBE_MS, label: "Checking the graphics chip" })
        .then((m) => ({
          webgpu: !!m.webgpu,
          fp16: !!m.fp16,
          ...(m.adapterInfo ? { adapterInfo: m.adapterInfo as AsrProbe["adapterInfo"] } : {}),
        }))
        .catch(() => ({ webgpu: false, fp16: false }));
    }
    return this.probed;
  }

  /** The model and device load() will try first. */
  async plan(): Promise<{ model: AsrModel; device: AsrDevice }> {
    return chooseAsrSetup(await this.probe(), { smaller: this.smaller || this.webgpuFailed });
  }

  /**
   * Downloads (or reads from the browser's cache) and builds the model. Idempotent: concurrent and repeated calls
   * share one load. Falls back from WebGPU to the standard model on the CPU in a fresh worker. Rejects (status
   * `error`) when even that fails.
   */
  load(): Promise<{ model: AsrModel; device: AsrDevice }> {
    if (this.currentState === "disposed") return Promise.reject(new Error("The speech model was closed."));
    if (this.currentState === "ready" && this.loaded) return Promise.resolve(this.loaded);
    if (!this.loading) {
      this.currentState = "loading";
      const run = this.doLoad().then(
        (r) => {
          if (this.loading !== run) throw new Error("The speech model was stopped.");
          this.loaded = r;
          this.currentState = "ready";
          this.loading = null;
          this.emit("ready", r);
          return r;
        },
        (err: unknown) => {
          const error = err instanceof Error ? err : new Error(String(err));
          if (this.loading === run) {
            this.loading = null;
            this.kill(error);
            this.emit("error", { message: error.message });
          }
          throw error;
        },
      );
      this.loading = run;
    }
    return this.loading;
  }

  private async doLoad(): Promise<{ model: AsrModel; device: AsrDevice }> {
    const gen = this.generation;
    const probe = await this.probe();
    const first = chooseAsrSetup(probe, { smaller: this.smaller || this.webgpuFailed });
    const ortVariant = isSafariBelow26() && !probe.webgpu ? "plain" : "asyncify";
    if (first.device === "webgpu") {
      const progress: LoadProgress = { phase: "start" };
      try {
        return await this.loadOn(first.model, first.device, ortVariant, WEBGPU_BUILD_MS, progress);
      } catch (err) {
        if (gen !== this.generation) throw err; // stopped meanwhile (kill(), Smaller download, dispose)
        // Failing mid-download, or with a request that failed (even before the first byte: offline, a blocked host),
        // is the network's doing; anything else (the build, a cached model's silent build, a crash) is the graphics
        // chip's, and isn't worth another try in this tab.
        const reason: AsrFallbackReason = progress.phase === "download" || err instanceof AsrNetworkError ? "download" : "gpu";
        if (reason === "gpu") this.webgpuFailed = true;
        // A timeout doesn't stop the WebGPU build: throw the worker away and start clean on the CPU.
        const message = err instanceof Error ? err.message : String(err);
        this.terminate(new Error("Switching to the standard model."));
        this.emit("fallback", { model: "base", device: "wasm", message, reason });
      }
    }
    if (gen !== this.generation) throw new Error("The speech model was stopped.");
    return this.loadOn("base", "wasm", ortVariant, WASM_BUILD_MS, { phase: "start" });
  }

  /** Loads in the worker; `progress.phase` follows the worker's status (for telling a download stall from a failed build). */
  private async loadOn(model: AsrModel, device: AsrDevice, ortVariant: "asyncify" | "plain", buildMs: number, progress: LoadProgress) {
    const m = await this.call(
      { type: "load", model, device, ortVariant },
      {
        timeoutMs: DOWNLOAD_IDLE_MS,
        label: device === "webgpu" ? "Preparing the accurate model on the graphics chip" : "Loading the speech model",
        onStatus: (status) => {
          if (status === "downloading" && progress.phase !== "build") {
            progress.phase = "download";
            return DOWNLOAD_IDLE_MS;
          }
          if (status === "loading") {
            // "loading" comes once before any download and again when the download is complete.
            if (progress.phase === "download") progress.phase = "build";
            return buildMs;
          }
          return undefined;
        },
      },
    );
    return { model: (m.model as AsrModel) ?? model, device: (m.device as AsrDevice) ?? device };
  }

  /**
   * Transcribes 16 kHz mono samples. `pcm.buffer` is TRANSFERRED to the worker (don't use `pcm` afterwards; pass a
   * copy to keep it). `timestamps` adds per-chunk times (slower; the live transcript doesn't use them). Times out
   * after `timeoutMs` (default: 5 s per second of audio, at least a minute); a timed-out worker is stopped, so call
   * load() again before the next transcription.
   */
  async transcribe(pcm: Float32Array, opts: { timestamps?: boolean; timeoutMs?: number } = {}): Promise<AsrResult> {
    if (this.currentState !== "ready") throw new Error("The speech model isn't loaded.");
    const timeoutMs = opts.timeoutMs ?? Math.max(60_000, (pcm.length / 16_000) * 5000);
    const buffer = pcm.buffer as ArrayBuffer;
    try {
      const m = await this.call(
        { type: "transcribe", pcm: buffer, byteOffset: pcm.byteOffset, length: pcm.length, timestamps: !!opts.timestamps },
        { timeoutMs, label: "Transcribing", transfer: [buffer] },
      );
      return { text: String(m.text || ""), chunks: Array.isArray(m.chunks) ? (m.chunks as AsrChunk[]) : [] };
    } catch (err) {
      if (err instanceof AsrTimeoutError) this.kill(err);
      throw err;
    }
  }

  /** Stops the worker for good (frees the model's memory). Safe to call twice. */
  dispose(): void {
    if (this.currentState === "disposed") return;
    this.kill(new Error("The speech model was closed."));
    this.currentState = "disposed";
    this.listeners.clear();
  }
}
