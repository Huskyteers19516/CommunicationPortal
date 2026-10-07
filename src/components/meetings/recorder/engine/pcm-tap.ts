// Streams the microphone as 16 kHz mono samples (what Whisper takes) through the AudioWorklet in
// /asr/v1/pcm-tap-worklet.js, which resamples in the audio thread. Ported from VoiceCollector's audio.js PCMTap
// (worklet path only; every browser the recorder supports has AudioWorklet). Browser only.

export const PCM_TAP_WORKLET_URL = "/asr/v1/pcm-tap-worklet.js";

export type PcmTapOptions = {
  /** Called with every frame (1024 samples = 64 ms at 16 kHz; transferred from the audio thread, safe to keep). */
  onSamples: (samples: Float32Array) => void;
  frame?: number;
  targetRate?: number;
};

export class PcmTap {
  private readonly ctx: AudioContext;
  private readonly source: AudioNode;
  private readonly opts: PcmTapOptions;
  private node: AudioWorkletNode | null = null;
  private sink: GainNode | null = null;
  private on = false;

  constructor(ctx: AudioContext, source: AudioNode, opts: PcmTapOptions) {
    this.ctx = ctx;
    this.source = source;
    this.opts = opts;
  }

  /** Starts the tap. Resolves false when AudioWorklet isn't available or the module can't load. Safe to call twice. */
  async connect(): Promise<boolean> {
    if (this.on) return !!this.node;
    this.on = true;
    if (!this.ctx.audioWorklet || typeof AudioWorkletNode !== "function") return false;
    try {
      await this.ctx.audioWorklet.addModule(PCM_TAP_WORKLET_URL);
    } catch {
      return false;
    }
    if (!this.on) return false; // disconnected meanwhile
    const node = new AudioWorkletNode(this.ctx, "hk-pcm-tap", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1,
      channelCountMode: "explicit",
      channelInterpretation: "speakers",
      processorOptions: { outRate: this.opts.targetRate ?? 16_000, frame: this.opts.frame ?? 1024 },
    });
    node.port.onmessage = (e: MessageEvent<{ samples?: Float32Array }>) => {
      const s = e.data?.samples;
      if (s && this.on) {
        try {
          this.opts.onSamples(s);
        } catch {
          // a consumer's bug mustn't stop the tap
        }
      }
    };
    // Web Audio only runs nodes that lead to the speakers: route through a silent gain (0, so no feedback).
    const sink = this.ctx.createGain();
    sink.gain.value = 0;
    this.source.connect(node);
    node.connect(sink);
    sink.connect(this.ctx.destination);
    this.node = node;
    this.sink = sink;
    return true;
  }

  /** Stops posting samples (the worklet sends what it has first). */
  pause(): void {
    this.node?.port.postMessage({ cmd: "pause" });
  }

  resume(): void {
    this.node?.port.postMessage({ cmd: "resume" });
  }

  disconnect(): void {
    this.on = false;
    const node = this.node;
    if (node) {
      try {
        this.source.disconnect(node);
      } catch {
        // already disconnected
      }
      try {
        node.disconnect();
        node.port.postMessage({ cmd: "stop" });
        node.port.onmessage = null;
      } catch {
        // context closed
      }
    }
    try {
      this.sink?.disconnect();
    } catch {
      // context closed
    }
    this.node = null;
    this.sink = null;
  }
}
