// Huskyteers Portal — on-device speech recognition for Meeting recaps (Whisper, English-only models).
//
// A static ES module worker, no build step: new Worker("/asr/v1/asr-worker.js", { type: "module" }). The model runs
// here, never on the page: building an ONNX session can block its thread for a long time (q8 weights on WebGPU
// even hang it for good), and on the main thread that froze the page — and the recording. The page's proxy
// (src/components/meetings/recorder/engine/asr-client.ts) puts a timeout on every call and kills this worker
// when it stops answering. All cleaning of the text happens on the page (src/lib/meeting-recorder/*).
//
// Library: @huggingface/transformers 4.3.0 (./transformers.min.js, unmodified, Apache-2.0). Model weights come
// from huggingface.co at pinned revisions and onnxruntime-web's wasm from jsDelivr; the browser caches both.
//
// Messages (page → worker, every one but probe answered with the same id; failures → { type: "error", id, message },
// plus network: true when a failed load also had a request fail — offline, DNS, a blocked host, a server error):
//   { type: "probe", id }                              → { type: "probe:ok", id, webgpu, fp16, adapterInfo? }
//   { type: "load", id, model: "small" | "base",
//     device: "webgpu" | "wasm", ortVariant: "asyncify" | "plain" }
//                                                      → { type: "status", status: "loading", detail: { model } }
//                                                        { type: "status", status: "downloading", detail: { model, pct, loadedMB, totalMB } }
//                                                        { type: "load:ok", id, model, device }
//   { type: "transcribe", id, pcm: ArrayBuffer (transferred, 16 kHz mono Float32),
//     byteOffset?, length?, timestamps: boolean }      → { type: "transcribe:ok", id, text, chunks: [{ text, timestamp: [s, e | null] }] }
//   { type: "dispose", id }                            → { type: "dispose:ok", id }

const MODELS = {
  // ~286 MB at q4/q4: WebGPU with shader-f16 only.
  small: { id: "onnx-community/whisper-small.en", revision: "482fb8ba081b6e906f92efe103622316b2a0cc69" },
  // ~73 MB at q8/q8 on the CPU (wasm).
  base: { id: "onnx-community/whisper-base.en", revision: "51eefc0af78b103839eda9e7e4f4186acc6517fe" },
};
// Sizes of the ONNX files each precision downloads (bytes, at the pinned revisions), for an honest progress bar:
// transformers' own total also counts files it only sizes up (the fp32 encoder), so it never reaches 100%.
const ONNX_SIZES = {
  "whisper-small.en": { encoder_model_q4: 66182104, decoder_model_merged_q4: 233146255 },
  "whisper-base.en": {
    encoder_model_quantized: 23201320,
    decoder_model_merged_quantized: 53692803,
    encoder_model_fp16: 41332612,
    decoder_model_merged_fp16: 104721330,
  },
};
const DTYPE_SUFFIX = { fp32: "", fp16: "_fp16", q8: "_quantized", q4: "_q4", q4f16: "_q4f16", int8: "_int8", uint8: "_uint8", bnb4: "_bnb4" };
// The onnxruntime-web build transformers 4.3.0 was made with.
const ORT_CDN = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.0-dev.20260914-8d85527a0/dist/";

let runtime = null; // Promise<{ pipeline, env }>
let gpuProbe = null; // Promise<{ webgpu, fp16, adapterInfo? }>
let pipe = null;
let loaded = null; // { model, device }
let queue = Promise.resolve(); // load / transcribe / dispose run one at a time (an ONNX session can't run concurrently)
let fetchWatch = null; // { failed } for the load in progress: did any of its requests fail?
let fetchWatched = false;

const post = (msg, transfer) => self.postMessage(msg, transfer || []);
const status = (s, detail) => post({ type: "status", status: s, detail });

function probeGpu() {
  if (!gpuProbe) {
    gpuProbe = (async () => {
      try {
        if (!self.navigator || !navigator.gpu) return { webgpu: false, fp16: false };
        const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
        if (!adapter) return { webgpu: false, fp16: false };
        const info = adapter.info || {};
        return {
          webgpu: true,
          fp16: !!(adapter.features && adapter.features.has("shader-f16")),
          adapterInfo: { vendor: String(info.vendor || ""), architecture: String(info.architecture || ""), description: String(info.description || "") },
        };
      } catch {
        return { webgpu: false, fp16: false };
      }
    })();
  }
  return gpuProbe;
}

// Precision per ONNX FILE NAME (encoder_model / decoder_model_merged) — a wrong key silently downloads fp32.
// Never q8 on WebGPU: int8 weights hang onnxruntime's WebGPU backend while the session is built.
function dtypeFor(model, device, fp16) {
  if (device === "webgpu") {
    if (model === "small") return { encoder_model: "q4", decoder_model_merged: "q4" };
    if (!fp16) throw new Error("The standard model needs a graphics chip with 16-bit float support on WebGPU.");
    return { encoder_model: "fp16", decoder_model_merged: "fp16" };
  }
  return { encoder_model: "q8", decoder_model_merged: "q8" };
}

function getRuntime(ortVariant) {
  if (!runtime) {
    runtime = (async () => {
      const { pipeline, env } = await import("./transformers.min.js");
      // MUST be false: otherwise transformers first asks this site for /models/…, which the portal answers with
      // its sign-in page (status 200), and loading breaks.
      env.allowLocalModels = false;
      env.allowRemoteModels = true;
      env.remoteHost = "https://huggingface.co/";
      env.remotePathTemplate = "{model}/resolve/{revision}/";
      env.useBrowserCache = true;
      env.useWasmCache = true; // needs wasmPaths as an object
      env.cacheKey = "huskyteers-asr";
      // Set explicitly, always, as an { mjs, wasm } object: transformers fills in its own CDN paths on import, and
      // only the object form turns on the wasm cache. The "plain" build is for Safari before 26 without WebGPU
      // (decided on the page: navigator.vendor isn't reliable in a worker).
      const sfx = ortVariant === "plain" ? "" : ".asyncify";
      env.backends.onnx.wasm.wasmPaths = { mjs: `${ORT_CDN}ort-wasm-simd-threaded${sfx}.mjs`, wasm: `${ORT_CDN}ort-wasm-simd-threaded${sfx}.wasm` };
      // Threads need cross-origin isolation, which the portal doesn't have (one thread is fine; WebGPU doesn't care).
      env.backends.onnx.wasm.numThreads = self.crossOriginIsolated
        ? Math.min(4, Math.max(1, Math.floor((navigator.hardwareConcurrency || 4) / 2)))
        : 1;
      watchFetch(env);
      return { pipeline, env };
    })();
    runtime.catch(() => {
      runtime = null;
    });
  }
  return runtime;
}

// Every request transformers makes (model files, their metadata, onnxruntime's wasm) goes through env.fetch. A request
// that fails outright, or comes back with a server error, marks the load in progress, so the page can tell a network
// problem from a graphics chip that can't build the model. 404 (an optional file the model doesn't have) and 416 (a
// size check on an empty file) are normal answers.
function watchFetch(env) {
  const base = env.fetch;
  if (fetchWatched || typeof base !== "function") return;
  fetchWatched = true;
  env.fetch = (...args) => {
    const watch = fetchWatch;
    return base(...args).then(
      (res) => {
        if (watch && res && !res.ok && res.status !== 404 && res.status !== 416) watch.failed = true;
        return res;
      },
      (err) => {
        if (watch) watch.failed = true;
        throw err;
      },
    );
  };
}

async function load(m) {
  const watch = { failed: false };
  fetchWatch = watch;
  try {
    return await loadModel(m);
  } catch (err) {
    if (!watch.failed) throw err;
    const error = new Error(String((err && err.message) || err || "Unknown error"));
    error.network = true;
    throw error;
  } finally {
    if (fetchWatch === watch) fetchWatch = null;
  }
}

async function loadModel({ model, device, ortVariant }) {
  if (!MODELS[model]) throw new Error(`Unknown model "${model}".`);
  if (device !== "webgpu" && device !== "wasm") throw new Error(`Unknown device "${device}".`);
  if (pipe && loaded && loaded.model === model && loaded.device === device) return loaded;
  await dispose();

  let pipeline;
  try {
    ({ pipeline } = await getRuntime(ortVariant));
  } catch (err) {
    // Fetching ./transformers.min.js failed (offline, say): not the graphics chip's doing either.
    if (fetchWatch) fetchWatch.failed = true;
    throw err;
  }
  let fp16 = false;
  if (device === "webgpu") {
    const gpu = await probeGpu();
    if (!gpu.webgpu) throw new Error("WebGPU isn't available in this browser.");
    fp16 = gpu.fp16;
  }

  // Download progress over the files this load really uses: the two ONNX files of the chosen precision (their
  // known sizes count before they start) plus the small config and tokenizer files. Report every 1% — and every 5 s
  // while bytes keep coming, so a slow download (1% of the accurate model is 3 MB) doesn't look stalled to the page,
  // which gives up after a minute without news — and "loading" once all are in (building the session — shader
  // compiling on WebGPU — sends nothing).
  const dtype = dtypeFor(model, device, fp16);
  const repo = MODELS[model].id.split("/")[1];
  const wanted = new Map(
    Object.entries(dtype).map(([file, precision]) => {
      const name = `${file}${DTYPE_SUFFIX[precision] ?? ""}`;
      return [`${name}.onnx`, (ONNX_SIZES[repo] && ONNX_SIZES[repo][name]) || 0];
    }),
  );
  let lastPct = -1;
  let lastBytes = 0;
  let lastPostAt = 0;
  let finished = false;
  const progress_callback = (info) => {
    if (!info || info.status !== "progress_total") return;
    let doneBytes = info.loaded || 0;
    let totalBytes = info.total || 0;
    if (info.files && typeof info.files === "object") {
      doneBytes = 0;
      totalBytes = 0;
      const seen = new Set();
      for (const [path, f] of Object.entries(info.files)) {
        const name = path.split("/").pop();
        if (name.endsWith(".onnx") && !wanted.has(name)) continue; // sized up, never downloaded
        seen.add(name);
        doneBytes += (f && f.loaded) || 0;
        totalBytes += (f && f.total) || 0;
      }
      for (const [name, size] of wanted) if (!seen.has(name)) totalBytes += size;
    }
    const pct = totalBytes > 0 ? Math.max(0, Math.min(100, (doneBytes / totalBytes) * 100)) : 0;
    const now = Date.now();
    if (!finished && (Math.abs(pct - lastPct) >= 1 || lastPct < 0 || (doneBytes > lastBytes && now - lastPostAt >= 5000))) {
      lastPct = pct;
      lastBytes = doneBytes;
      lastPostAt = now;
      status("downloading", {
        model,
        pct: Math.floor(pct),
        loadedMB: +(doneBytes / 1048576).toFixed(1),
        totalMB: +(totalBytes / 1048576).toFixed(1),
      });
    }
    if (!finished && pct >= 99.9) {
      finished = true;
      status("loading", { model });
    }
  };

  // A cached model sends no download events: say something before the silent part.
  status("loading", { model });
  const next = await pipeline("automatic-speech-recognition", MODELS[model].id, {
    device,
    dtype,
    revision: MODELS[model].revision,
    progress_callback,
  });
  pipe = next;
  loaded = { model, device };
  return loaded;
}

async function transcribe({ pcm, byteOffset, length, timestamps }) {
  if (!pipe) throw new Error("The speech model isn't loaded.");
  if (!(pcm instanceof ArrayBuffer)) throw new Error("Expected audio samples.");
  const samples = new Float32Array(pcm, byteOffset || 0, length ?? undefined);
  if (samples.length === 0) return { text: "", chunks: [] };
  // Whisper takes 30 s at a time; the pipeline windows longer audio itself. Never pass language/task to an
  // English-only (.en) model — transformers throws.
  const out = await pipe(samples, { return_timestamps: !!timestamps, chunk_length_s: 30, stride_length_s: 5 });
  const result = Array.isArray(out) ? out[0] : out;
  const chunks = Array.isArray(result && result.chunks)
    ? result.chunks.map((c) => ({
        text: String(c.text || ""),
        timestamp: [Number(c.timestamp && c.timestamp[0]) || 0, c.timestamp && c.timestamp[1] != null ? Number(c.timestamp[1]) : null],
      }))
    : [];
  return { text: String((result && result.text) || "").trim(), chunks };
}

async function dispose() {
  const old = pipe;
  pipe = null;
  loaded = null;
  if (old) {
    try {
      await old.dispose();
    } catch {
      // already gone
    }
  }
}

function serial(task) {
  const run = queue.then(task, task);
  queue = run.catch(() => {});
  return run;
}

self.onmessage = (e) => {
  const m = e.data || {};
  const fail = (err) =>
    post({
      type: "error",
      id: m.id,
      message: String((err && err.message) || err || "Unknown error").slice(0, 400),
      ...(err && err.network ? { network: true } : {}),
    });
  switch (m.type) {
    case "probe":
      probeGpu().then((r) => post({ type: "probe:ok", id: m.id, ...r }), fail);
      break;
    case "load":
      serial(() => load(m)).then((r) => post({ type: "load:ok", id: m.id, model: r.model, device: r.device }), fail);
      break;
    case "transcribe":
      serial(() => transcribe(m)).then((r) => post({ type: "transcribe:ok", id: m.id, text: r.text, chunks: r.chunks }), fail);
      break;
    case "dispose":
      serial(dispose).then(() => post({ type: "dispose:ok", id: m.id }), fail);
      break;
    default:
      fail(new Error(`Unknown message "${m.type}".`));
  }
};
