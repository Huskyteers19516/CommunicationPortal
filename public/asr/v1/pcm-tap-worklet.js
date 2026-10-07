// Huskyteers Portal — the microphone tap for Meeting recaps' live transcript.
//
// A static AudioWorklet module (no build step): audioContext.audioWorklet.addModule("/asr/v1/pcm-tap-worklet.js"),
// then new AudioWorkletNode(ctx, "hk-pcm-tap", { processorOptions: { outRate, frame } }). It resamples the
// microphone from the context's rate (usually 48 or 44.1 kHz) to 16 kHz mono inside the audio thread and posts
// { samples: Float32Array } (transferred) every `frame` output samples (1024 = 64 ms). Port messages:
// { cmd: "pause" } (posts what it has, then drops input until resumed), { cmd: "resume" }, { cmd: "stop" } (the
// node ends). Ported from VoiceCollector's audio.js (vc-pcm-tap).

// Polyphase filter bank: P phases of a Blackman-windowed sinc low-pass with its cutoff at 0.45 × the output rate
// (7.2 kHz for 48 → 16 kHz), so energy above the new Nyquist is filtered out before decimating instead of folding
// back onto the voice (what plain sample-dropping does to hiss).
function buildBank(ratio, HW, P) {
  const N = HW * 2;
  const fc = ratio > 1 ? 0.45 / ratio : 0.45; // relative to the input rate
  const bank = [];
  for (let p = 0; p < P; p++) {
    const frac = p / P;
    const h = new Float32Array(N);
    let sum = 0;
    for (let k = 0; k < N; k++) {
      const d = k - HW + 1 - frac; // distance from the tap to the output position, in input samples
      const x = 2 * fc * d;
      const s = Math.abs(x) < 1e-8 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
      const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * k) / (N - 1)) + 0.08 * Math.cos((4 * Math.PI * k) / (N - 1));
      const v = 2 * fc * s * w;
      h[k] = v;
      sum += v;
    }
    if (sum) for (let k = 0; k < N; k++) h[k] /= sum; // unity DC gain: no volume drift
    bank.push(h);
  }
  return bank;
}

class HkPcmTapProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.outRate = o.outRate || 16000;
    this.frame = o.frame || 1024; // posting less often saves battery
    this.HW = o.HW || 16; // taps per side (32 in all)
    this.P = o.P || 32; // phases: fractional positions to 1/32 of an input sample
    this.N = this.HW * 2;
    this.TAIL = this.HW * 2;
    this.ratio = sampleRate / this.outRate;
    this.bank = buildBank(this.ratio, this.HW, this.P);
    this.buf = null;
    this.out = new Float32Array(this.frame);
    this.reset();
    this.dead = false;
    this.paused = false;
    this.port.onmessage = (e) => {
      const cmd = e.data && e.data.cmd;
      if (cmd === "stop") this.dead = true;
      else if (cmd === "pause") {
        this.post();
        this.paused = true;
      } else if (cmd === "resume" && this.paused) {
        this.reset(); // don't filter across the gap
        this.paused = false;
      }
    };
  }

  reset() {
    this.tail = new Float32Array(this.TAIL);
    this.pos = this.TAIL; // next output sample's fractional position in buf
    this.m = 0;
  }

  post() {
    if (!this.m) return;
    const copy = this.out.slice(0, this.m); // this.out is reused
    this.port.postMessage({ samples: copy }, [copy.buffer]);
    this.m = 0;
  }

  process(inputs) {
    if (this.dead) return false; // only stop ends the node
    const ch = inputs[0] && inputs[0][0];
    if (this.paused || !ch || !ch.length) return true; // stay alive through silence and pauses

    const n = ch.length;
    const { TAIL, N, HW, P } = this;
    if (!this.buf || this.buf.length !== TAIL + n) this.buf = new Float32Array(TAIL + n);
    const buf = this.buf;
    buf.set(this.tail, 0);
    buf.set(ch, TAIL);
    const total = TAIL + n;
    let pos = this.pos;

    while (Math.floor(pos) + HW < total) {
      const i0 = Math.floor(pos);
      let p = ((pos - i0) * P) | 0;
      if (p >= P) p = P - 1;
      const h = this.bank[p];
      const base = i0 - HW + 1;
      let acc = 0;
      for (let k = 0; k < N; k++) acc += h[k] * buf[base + k];
      this.out[this.m++] = acc;
      if (this.m >= this.frame) this.post();
      pos += this.ratio;
    }

    this.tail.set(buf.subarray(total - TAIL, total));
    this.pos = pos - n; // the next block's buf[0] is this block's buf[total - TAIL]
    return true;
  }
}

registerProcessor("hk-pcm-tap", HkPcmTapProcessor);
