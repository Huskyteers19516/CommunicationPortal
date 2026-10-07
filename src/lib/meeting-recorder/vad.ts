// Speech detection on 16 kHz mono samples, ported from VoiceCollector's audio.js detectSpeech (energy + zero
// crossings + envelope modulation). Client-safe, no DOM. The live transcript skips windows that are almost all
// silence: it saves battery and stops Whisper from inventing "Thank you." out of nothing.

export const SAMPLE_RATE = 16_000;

/** Windows where fewer than this share of 1-second blocks contain speech aren't transcribed. */
export const MIN_SPEECH_RATIO = 0.1;

export type SpeechOptions = {
  /** Sample rate; the zero-crossing limits below are written for 16 kHz and scaled to it. */
  rate?: number;
  /** Energy floor in dBFS (default -50; far-field speech is quiet). */
  rmsDbMin?: number;
  /** Zero-crossing rate band at 16 kHz (default 0.010–0.38): hum barely crosses, hiss crosses all the time. */
  zcrMin?: number;
  zcrMax?: number;
  /** Envelope modulation p90/p10 of 32 ms frames (default 1.6). */
  modMin?: number;
  /** Skip the modulation test. */
  modOff?: boolean;
};

/**
 * Whether a short window (0.5–2 s works best) sounds like speech. The test that does the real work is envelope
 * modulation: speech has gaps between syllables, so the energy of fixed 32 ms frames rises and falls (p90/p10
 * measured 13–30 for speech at any pace, length or reverb), while crowd murmur, fans and hiss stay flat
 * (1.05–1.27). Fixed-length frames matter — frames that grow with the window average the syllables away.
 */
export function detectSpeech(samples: Float32Array, opts: SpeechOptions = {}): boolean {
  const n = samples.length;
  if (n < 64) return false;

  const rate = opts.rate && opts.rate > 0 ? opts.rate : SAMPLE_RATE;
  const k = SAMPLE_RATE / rate;
  const rmsDbMin = opts.rmsDbMin ?? -50;
  const zcrMin = (opts.zcrMin ?? 0.01) * k;
  const zcrMax = (opts.zcrMax ?? 0.38) * k;
  const modMin = opts.modMin ?? 1.6;

  // 1) energy
  let sum = 0;
  for (let i = 0; i < n; i++) sum += samples[i] * samples[i];
  const rms = Math.sqrt(sum / n);
  const db = rms < 1e-7 ? -100 : 20 * Math.log10(rms);
  if (db < rmsDbMin) return false;

  // 2) zero crossings, with a dead band of rms × 0.08 so noise hugging zero doesn't count
  const dead = rms * 0.08;
  let zc = 0;
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const x = samples[i];
    const s = x > dead ? 1 : x < -dead ? -1 : 0;
    if (s !== 0) {
      if (prev !== 0 && s !== prev) zc++;
      prev = s;
    }
  }
  const zcr = zc / n;
  if (zcr < zcrMin || zcr > zcrMax) return false;

  // 3) envelope modulation: RMS of fixed 32 ms frames, p90 / p10
  if (!opts.modOff) {
    const step = Math.max(64, Math.round(rate * 0.032));
    const cnt = Math.floor(n / step);
    if (cnt >= 6) {
      const e = new Float64Array(cnt);
      for (let b = 0; b < cnt; b++) {
        let s2 = 0;
        const from = b * step;
        for (let i = from; i < from + step; i++) s2 += samples[i] * samples[i];
        e[b] = Math.sqrt(s2 / step);
      }
      e.sort();
      const q = (p: number) => e[Math.min(cnt - 1, Math.max(0, Math.round(p * (cnt - 1))))];
      const hi = q(0.9);
      const lo = q(0.1);
      if (hi > 1e-9 && hi / Math.max(lo, hi * 1e-4) < modMin) return false;
    }
  }
  return true;
}

/**
 * Speech per block: one boolean for each `blockSec` block of `samples` (a last partial block counts when it is at
 * least half a block long).
 */
export function speechBlocks(samples: Float32Array, rate = SAMPLE_RATE, blockSec = 1): boolean[] {
  const size = Math.max(64, Math.round(rate * blockSec));
  const out: boolean[] = [];
  for (let from = 0; from < samples.length; from += size) {
    const block = samples.subarray(from, Math.min(samples.length, from + size));
    if (block.length < size / 2 && out.length) break;
    out.push(detectSpeech(block, { rate }));
  }
  return out;
}

/** Share (0–1) of 1-second blocks that contain speech. Empty input → 0. */
export function speechRatio(samples: Float32Array, rate = SAMPLE_RATE): number {
  const blocks = speechBlocks(samples, rate);
  if (!blocks.length) return 0;
  return blocks.filter(Boolean).length / blocks.length;
}

/** Whether a window has enough speech to be worth transcribing (MIN_SPEECH_RATIO). */
export function hasEnoughSpeech(samples: Float32Array, rate = SAMPLE_RATE): boolean {
  return speechRatio(samples, rate) >= MIN_SPEECH_RATIO;
}

/** Share (0–1) of `blocks` (from speechBlocks, 1 s each) with speech between `fromSec` and `toSec` (at least one block). */
export function speechShare(blocks: boolean[], fromSec: number, toSec: number): number {
  if (!blocks.length) return 0;
  const a = Math.max(0, Math.min(blocks.length - 1, Math.floor(fromSec)));
  const b = Math.max(a + 1, Math.min(blocks.length, Math.ceil(toSec)));
  let n = 0;
  for (let i = a; i < b; i++) if (blocks[i]) n++;
  return n / (b - a);
}

/**
 * Where to cut a long recording into pieces of about `pieceSec` for transcription one at a time (progress, smaller
 * messages): at the quietest half second within `searchSec` of each target, so a cut rarely lands mid-word.
 * Returns [start, end) sample ranges covering everything.
 */
export function pieceRanges(samples: Float32Array, pieceSec = 240, searchSec = 15, rate = SAMPLE_RATE): [number, number][] {
  const piece = Math.round(pieceSec * rate);
  const search = Math.round(searchSec * rate);
  const win = Math.round(0.5 * rate);
  const step = Math.max(1, Math.round(0.1 * rate));
  const out: [number, number][] = [];
  let start = 0;
  while (samples.length - start > piece + search) {
    const target = start + piece;
    let best = target;
    let bestEnergy = Number.POSITIVE_INFINITY;
    for (let at = target - search; at + win <= target + search; at += step) {
      let e = 0;
      for (let i = at; i < at + win; i++) e += samples[i] * samples[i];
      if (e < bestEnergy) {
        bestEnergy = e;
        best = at + Math.round(win / 2);
      }
    }
    out.push([start, best]);
    start = best;
  }
  if (samples.length > start || !out.length) out.push([start, samples.length]);
  return out;
}
