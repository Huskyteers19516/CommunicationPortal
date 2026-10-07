// The microphone for the meeting recorder, ported from VoiceCollector's mic.js (without its far-field enhancement
// chain: the RAW signal is recorded and transcribed). Browser only.

/** MediaRecorder's bitrate: 24 kbps Opus is about 10.8 MB an hour (3 MiB upload parts ≈ 17 minutes each). */
export const RECORDING_BITS_PER_SECOND = 24_000;
/** A MediaRecorder chunk every 5 s: each is saved to IndexedDB as it comes, so a crash loses at most that. */
export const RECORDING_TIMESLICE_MS = 5000;

/** The best recording format this browser supports: WebM/Opus, plain WebM, MP4 (Safari), Ogg/Opus, or "" (default). */
export function pickMime(): string {
  if (typeof MediaRecorder === "undefined") return "";
  for (const m of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"]) {
    try {
      if (MediaRecorder.isTypeSupported(m)) return m;
    } catch {
      // keep looking
    }
  }
  return "";
}

/** The microphones (names only appear once the site may use the microphone). */
export async function listMics(): Promise<MediaDeviceInfo[]> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === "audioinput");
  } catch {
    return [];
  }
}

export type OpenMic = {
  stream: MediaStream;
  ctx: AudioContext;
  /** The raw microphone in the audio graph (the 16 kHz tap listens here). */
  source: MediaStreamAudioSourceNode;
  /** Current input level 0–1 (RMS of the raw signal, scaled up for a meter). Poll it ~8 times a second. */
  level(): number;
  /** Stops the microphone and closes the audio context. Safe to call twice. */
  close(): void;
};

const MESSAGES = {
  insecure: "The microphone only works on a secure (https) page.",
  unsupported: "This browser can't record audio. Try Chrome, Edge or Safari on a computer.",
  denied: "Microphone access is blocked. Allow the microphone for this site in your browser's settings, then try again.",
  noMic: "No microphone found. Plug one in or pick another, then try again.",
  busy: "The microphone is busy in another app (a video call?). Close that app and try again.",
  other: "Couldn't start the microphone. Check it's connected and try again.",
};

/** A friendly message for getUserMedia's error. */
export function micErrorMessage(error: unknown): string {
  const name = error instanceof DOMException || error instanceof Error ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") return MESSAGES.denied;
  if (name === "NotFoundError" || name === "DevicesNotFoundError" || name === "OverconstrainedError") return MESSAGES.noMic;
  if (name === "NotReadableError" || name === "TrackStartError" || name === "AbortError") return MESSAGES.busy;
  if (name === "InsecureContextError") return MESSAGES.insecure;
  return MESSAGES.other;
}

/**
 * Opens the microphone. Call it from the click that starts recording: the AudioContext is created before the first
 * await, while the click still counts as a user gesture (browsers keep a context made later suspended). Raw signal
 * for meetings: no echo cancellation or noise suppression (they eat distant voices), automatic gain on, mono.
 * Throws an Error with a friendly message (micErrorMessage) when it can't.
 */
export async function openMic({ deviceId }: { deviceId?: string } = {}): Promise<OpenMic> {
  if (typeof window === "undefined" || !window.isSecureContext) throw Object.assign(new Error(MESSAGES.insecure), { name: "InsecureContextError" });
  if (!navigator.mediaDevices?.getUserMedia || typeof AudioContext === "undefined") throw new Error(MESSAGES.unsupported);

  const ctx = new AudioContext();
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: true,
        channelCount: 1,
        ...(deviceId ? { deviceId: { ideal: deviceId } } : {}),
      },
    });
  } catch (e) {
    void ctx.close().catch(() => {});
    throw Object.assign(new Error(micErrorMessage(e)), { cause: e });
  }
  if (ctx.state === "suspended") await ctx.resume().catch(() => {});

  const source = ctx.createMediaStreamSource(stream);
  // The meter measures the raw signal, so it shows how loud the room really is.
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  const buf = new Uint8Array(analyser.fftSize);
  source.connect(analyser);
  let closed = false;

  return {
    stream,
    ctx,
    source,
    level() {
      if (closed) return 0;
      analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = (buf[i] - 128) / 128;
        sum += v * v;
      }
      return Math.min(1, Math.sqrt(sum / buf.length) * 4.2);
    },
    close() {
      if (closed) return;
      closed = true;
      stream.getTracks().forEach((t) => t.stop());
      void ctx.close().catch(() => {});
    },
  };
}

/**
 * A MediaRecorder for the kept recording (24 kbps, the picked format). Falls back to the browser's defaults when it
 * refuses those options. Use `recorder.mimeType` for what it actually produces.
 */
export function createRecorder(stream: MediaStream, mime = pickMime()): MediaRecorder {
  try {
    return new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: RECORDING_BITS_PER_SECOND } : { audioBitsPerSecond: RECORDING_BITS_PER_SECOND });
  } catch {
    return new MediaRecorder(stream);
  }
}
