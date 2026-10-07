// Chrome's built-in Summarizer (Gemini Nano, on-device) for narrative key points, when this browser has it —
// desktop Chrome 138+ on capable hardware. Everything is feature-detected and every call has a timeout: these
// APIs can hang forever on some builds, and can "succeed" with garbage (VoiceCollector found an Electron build that
// answers "Model not available" plus the input echoed back). Nothing here is required: without it the key points
// are the extractive ones (src/lib/meeting-recorder/key-points.ts). Browser only.
//
//   const availability = await summarizerAvailability();        // on page load, no gesture needed
//   // In the Start click handler, FIRST (a model download needs the click's user activation; not awaited):
//   const handle = prepareSummarizer(availability, (pct) => …);
//   // After Stop:
//   const bullets = await summarizeTranscript(handle, segments);  // string[] | null; destroys the summarizer

import { chunkText, isUnusableSummary, parseSummaryBullets } from "@/lib/meeting-recorder/summary-text";

export type SummarizerAvailability = "unavailable" | "downloadable" | "downloading" | "available";

type SummarizerOptions = Record<string, unknown> & { monitor?: (m: EventTarget) => void };
type SummarizerInstance = {
  summarize(text: string, opts?: { context?: string; signal?: AbortSignal }): Promise<string>;
  measureInputUsage?: (text: string) => Promise<number>;
  inputQuota?: number;
  destroy?: () => void;
};
type SummarizerApi = {
  availability(opts?: SummarizerOptions): Promise<string>;
  create(opts?: SummarizerOptions): Promise<SummarizerInstance>;
};
export type SummarizerHandle = Promise<SummarizerInstance | null>;

const OPTIONS: SummarizerOptions = {
  type: "key-points",
  format: "markdown",
  length: "long", // 7 bullets per summary
  expectedInputLanguages: ["en"],
  outputLanguage: "en",
  sharedContext:
    "Speech-to-text transcript of an FTC robotics team meeting; may contain recognition errors and filler words. Focus on decisions, assignments, deadlines and status updates.",
};
const REDUCE_CONTEXT = "Key points from consecutive parts of one meeting; merge duplicates.";
/** Chunk size in characters when the summarizer can't measure its input. */
const FALLBACK_CHUNK_CHARS = 3500;

/** Resolves with `fallback` when `p` takes longer than `ms` or fails. */
export function withTimeout<T>(p: Promise<T> | T, ms: number, fallback: T): Promise<T> {
  return Promise.race([Promise.resolve(p).catch(() => fallback), new Promise<T>((r) => setTimeout(() => r(fallback), ms))]);
}

function api(): SummarizerApi | null {
  const s = (globalThis as { Summarizer?: SummarizerApi }).Summarizer;
  return s && typeof s.availability === "function" && typeof s.create === "function" ? s : null;
}

/** Whether this browser can summarize (and whether it must download the model first). Never hangs (3 s). */
export async function summarizerAvailability(): Promise<SummarizerAvailability> {
  const S = api();
  if (!S) return "unavailable";
  const av = await withTimeout(S.availability(OPTIONS), 3000, "unavailable");
  return av === "available" || av === "downloadable" || av === "downloading" ? av : "unavailable";
}

/**
 * Creates the summarizer, starting the model download when needed (progress 0–100 through `onProgress`). Call it as
 * the FIRST thing in a click handler and don't await it before other work: the download needs the click's user
 * activation and runs while the meeting is recorded. Resolves null when unavailable or after 20 s (model ready) /
 * 10 minutes (downloading).
 */
export function prepareSummarizer(availability: SummarizerAvailability, onProgress?: (pct: number) => void): SummarizerHandle {
  const S = api();
  if (!S || availability === "unavailable") return Promise.resolve(null);
  const monitor = (m: EventTarget) => {
    m.addEventListener("downloadprogress", (e) => {
      const loaded = Number((e as Event & { loaded?: number }).loaded ?? 0);
      try {
        onProgress?.(Math.round(loaded <= 1 ? loaded * 100 : loaded));
      } catch {
        // the page's problem, not the download's
      }
    });
  };
  const creating: Promise<SummarizerInstance | null> = S.create({ ...OPTIONS, monitor }).catch(() => null);
  const handle = withTimeout(creating, availability === "available" ? 20_000 : 600_000, null);
  // A create() that finishes after the timeout would keep the model in memory: destroy it then.
  void Promise.all([handle, creating]).then(([given, late]) => {
    if (!given && late) late.destroy?.();
  });
  return handle;
}

/** "Turn on" for the on-device summary: downloads the model (call from a click). Resolves whether it's ready. */
export async function enableSummarizer(onProgress?: (pct: number) => void): Promise<boolean> {
  const s = await prepareSummarizer(await summarizerAvailability(), onProgress);
  s?.destroy?.();
  return !!s;
}

async function fits(s: SummarizerInstance, text: string): Promise<boolean> {
  if (!s.inputQuota || !s.measureInputUsage) return text.length <= FALLBACK_CHUNK_CHARS;
  const used = await withTimeout(s.measureInputUsage(text), 10_000, Number.POSITIVE_INFINITY);
  return used <= s.inputQuota * 0.9;
}

/** Splits the transcript into pieces the summarizer accepts (by its measured quota when it can say). */
async function chunksFor(s: SummarizerInstance, text: string): Promise<string[]> {
  let size = FALLBACK_CHUNK_CHARS;
  if (s.inputQuota && s.measureInputUsage) {
    const sample = text.slice(0, 4000);
    const used = await withTimeout(s.measureInputUsage(sample), 10_000, 0);
    if (used > 0) size = Math.max(1000, Math.floor((s.inputQuota * 0.85 * sample.length) / used));
  }
  const out: string[] = [];
  const queue = chunkText(text, size);
  while (queue.length) {
    const c = queue.shift() as string;
    if (c.length > 500 && !(await fits(s, c))) queue.unshift(...chunkText(c, Math.ceil(c.length / 2)));
    else out.push(c);
  }
  return out;
}

/**
 * Narrative key points for a transcript: each piece is summarized (60 s each), and the pieces' bullets are merged
 * by one more summary when they fit (otherwise the first 10 are kept). Input is the segments' text without time
 * prefixes (they waste quota and leak into bullets). Resolves null when there's no summarizer, nothing usable came
 * back, the overall budget (default 4 minutes) ran out before any piece finished, or `signal` aborted. The
 * summarizer is destroyed afterwards.
 */
export async function summarizeTranscript(
  handle: SummarizerHandle | null,
  segments: { text: string }[],
  opts: { signal?: AbortSignal; budgetMs?: number; onProgress?: (done: number, total: number) => void } = {},
): Promise<string[] | null> {
  const s = handle ? await withTimeout(handle, 20_000, null) : null;
  if (!s) return null;
  const deadline = Date.now() + (opts.budgetMs ?? 240_000);
  try {
    const text = segments
      .map((seg) => seg.text.replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .join("\n");
    if (text.split(/\s+/).length < 40) return null; // too little to summarize
    const chunks = await chunksFor(s, text);
    let bullets: string[] = [];
    for (let i = 0; i < chunks.length; i++) {
      if (opts.signal?.aborted || Date.now() > deadline) break;
      const out = await withTimeout(s.summarize(chunks[i], { signal: opts.signal }), 60_000, "");
      if (!isUnusableSummary(out, chunks[i])) bullets.push(...parseSummaryBullets(out));
      opts.onProgress?.(i + 1, chunks.length);
    }
    if (chunks.length > 1 && bullets.length > 10 && !opts.signal?.aborted && Date.now() < deadline) {
      const joined = bullets.map((b) => `- ${b}`).join("\n");
      if (await fits(s, joined)) {
        const merged = await withTimeout(s.summarize(joined, { context: REDUCE_CONTEXT, signal: opts.signal }), 60_000, "");
        const again = isUnusableSummary(merged, joined) ? [] : parseSummaryBullets(merged);
        if (again.length) bullets = again;
      }
    }
    bullets = bullets.slice(0, 10);
    return bullets.length && !opts.signal?.aborted ? bullets : null;
  } catch {
    return null;
  } finally {
    try {
      s.destroy?.();
    } catch {
      // already destroyed
    }
  }
}
