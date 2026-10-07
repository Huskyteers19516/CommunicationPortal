// Decoding a whole recording to 16 kHz mono samples for Whisper (an uploaded file, or the recording after Stop),
// ported from VoiceCollector's audio.js blobToPCM16k. Browser only.
//
// Memory is the limit: an hour at 16 kHz is 230 MB of samples. Decoding into a 16 kHz context lets the browser
// resample while it decodes (VoiceCollector decoded at 44.1 kHz first — three times the memory). The resampler
// below is only a fallback for a browser that hands back another rate anyway.

export const DECODE_MAX_BYTES = 200 * 1024 * 1024;
export const DECODE_MAX_SECONDS = 3 * 3600;
const RATE = 16_000;

/** Polyphase Blackman-windowed sinc bank (cutoff 0.45 × the output rate), as in /asr/v1/pcm-tap-worklet.js. */
function buildBank(ratio: number, HW: number, P: number): Float32Array[] {
  const N = HW * 2;
  const fc = ratio > 1 ? 0.45 / ratio : 0.45;
  const bank: Float32Array[] = [];
  for (let p = 0; p < P; p++) {
    const frac = p / P;
    const h = new Float32Array(N);
    let sum = 0;
    for (let k = 0; k < N; k++) {
      const d = k - HW + 1 - frac;
      const x = 2 * fc * d;
      const s = Math.abs(x) < 1e-8 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
      const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * k) / (N - 1)) + 0.08 * Math.cos((4 * Math.PI * k) / (N - 1));
      h[k] = 2 * fc * s * w;
      sum += h[k];
    }
    if (sum) for (let k = 0; k < N; k++) h[k] /= sum;
    bank.push(h);
  }
  return bank;
}

/** A streaming resampler: push blocks in order, get the resampled blocks back (no clicks at block edges). */
function makeResampler(inRate: number, outRate: number): (input: Float32Array) => Float32Array {
  const HW = 16;
  const P = 32;
  const N = HW * 2;
  const TAIL = HW * 2;
  const ratio = inRate / outRate;
  const bank = buildBank(ratio, HW, P);
  const tail = new Float32Array(TAIL);
  let pos = TAIL;
  let buf: Float32Array | null = null;
  return (input) => {
    const n = input.length;
    if (!n) return new Float32Array(0);
    if (!buf || buf.length !== TAIL + n) buf = new Float32Array(TAIL + n);
    buf.set(tail, 0);
    buf.set(input, TAIL);
    const total = TAIL + n;
    const cap = Math.max(0, Math.ceil((total - HW - pos) / ratio)) + 2;
    const out = new Float32Array(cap);
    let m = 0;
    while (Math.floor(pos) + HW < total && m < cap) {
      const i0 = Math.floor(pos);
      let p = ((pos - i0) * P) | 0;
      if (p >= P) p = P - 1;
      const h = bank[p];
      const base = i0 - HW + 1;
      let acc = 0;
      for (let k = 0; k < N; k++) acc += h[k] * buf[base + k];
      out[m++] = acc;
      pos += ratio;
    }
    tail.set(buf.subarray(total - TAIL, total));
    pos -= n;
    return m === cap ? out : out.subarray(0, m);
  };
}

function decodeAudio(ctx: BaseAudioContext, data: ArrayBuffer): Promise<AudioBuffer> {
  return new Promise((resolve, reject) => {
    try {
      const p = ctx.decodeAudioData(data, resolve, reject); // old Safari only has the callbacks
      if (p && typeof p.then === "function") p.then(resolve, reject);
    } catch (e) {
      reject(e);
    }
  });
}

/**
 * A recording (any format the browser can play) → 16 kHz mono samples. Throws an Error with a message for people
 * when the file is over 200 MB or 3 hours, or can't be decoded.
 */
export async function blobToPcm16k(blob: Blob): Promise<Float32Array> {
  if (!blob.size) return new Float32Array(0);
  if (blob.size > DECODE_MAX_BYTES) throw new Error("This file is too big to transcribe in the browser (the limit is 200 MB).");
  if (typeof OfflineAudioContext === "undefined") throw new Error("This browser can't decode audio. Try Chrome, Edge or Safari.");

  const ctx = new OfflineAudioContext(1, 1, RATE);
  let decoded: AudioBuffer;
  try {
    decoded = await decodeAudio(ctx, await blob.arrayBuffer());
  } catch {
    // Long recordings usually fail here (not enough memory) rather than at the length check below.
    throw new Error(
      "Couldn't read this recording. It may be too long for this computer's memory, or in a format the browser can't play (MP3, M4A, WAV and WebM work).",
    );
  }
  if (decoded.duration > DECODE_MAX_SECONDS) {
    throw new Error(`This recording is ${Math.round(decoded.duration / 60)} minutes long. Recordings up to 3 hours can be transcribed.`);
  }

  const channels = decoded.numberOfChannels;
  const inRate = decoded.sampleRate;
  const total = decoded.length;
  // A copy: the AudioBuffer's own memory can't be handed to the worker.
  if (channels === 1 && inRate === RATE) return new Float32Array(decoded.getChannelData(0));

  const data: Float32Array[] = [];
  for (let c = 0; c < channels; c++) data.push(decoded.getChannelData(c));
  const resample = inRate === RATE ? null : makeResampler(inRate, RATE);
  // Down-mix and resample in 30 s blocks into one preallocated output (+64 for the filter's rounding).
  const BLOCK = Math.max(4096, Math.floor(inRate * 30));
  const mono = new Float32Array(BLOCK);
  const out = new Float32Array(Math.ceil((total * RATE) / inRate) + 64);
  let w = 0;
  for (let off = 0; off < total; off += BLOCK) {
    const len = Math.min(BLOCK, total - off);
    if (channels === 1) mono.set(data[0].subarray(off, off + len));
    else {
      for (let i = 0; i < len; i++) {
        let s = 0;
        for (let c = 0; c < channels; c++) s += data[c][off + i];
        mono[i] = s / channels;
      }
    }
    const block = len === BLOCK ? mono : mono.subarray(0, len);
    const piece = resample ? resample(block) : block;
    const take = Math.min(piece.length, out.length - w);
    out.set(take === piece.length ? piece : piece.subarray(0, take), w);
    w += take;
  }
  return w === out.length ? out : out.subarray(0, w);
}
