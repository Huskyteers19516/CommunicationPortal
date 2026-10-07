// Uploads a recording to a saved recap in parts, one Server Action call each (uploadMeetingAudioPartAction): Vercel
// refuses requests over 4.5 MB, so parts are MEETING_AUDIO_PART_BYTES (3 MiB). One at a time, in order; a part
// the server already has (`present`, from getMeetingAudioUploadStateAction) is skipped, which is how an
// interrupted upload is finished later. Network failures are retried 3 times with growing pauses; a refusal from
// the server (storage full, recording expired, rate limit…) stops the upload with its message. Client-safe (no DOM).

import { MEETING_AUDIO_PART_BYTES, type MeetingAudioType, meetingAudioExtension, normalizeMeetingAudioType } from "@/lib/meeting-recaps";

/** What uploadMeetingAudioPartAction answers (ActionState plus `complete`). */
export type SendPartResult = { ok: boolean; message?: string; complete?: boolean; fieldErrors?: Record<string, string> } | null;

export type UploadProgress = {
  /** Parts the server has (including ones it had before), of `partsTotal`. */
  partsDone: number;
  partsTotal: number;
  bytesDone: number;
  bytesTotal: number;
};

export type UploadOptions = {
  recapId: string;
  /** The recap's declared audio type (what createMeetingRecapAction was told). */
  audioType: MeetingAudioType | string;
  /** Defaults to MEETING_AUDIO_PART_BYTES. */
  partBytes?: number;
  /** Positions the server already has. */
  present?: number[];
  /** Sends one part: `(fd) => uploadMeetingAudioPartAction(null, fd)`. FormData fields: recapId, position, file. */
  sendPart: (fd: FormData) => Promise<SendPartResult>;
  onProgress?: (p: UploadProgress) => void;
  signal?: AbortSignal;
  /** Retries per part after a thrown (network) error (default 3), the first pause (default 1 s, then ×3). */
  retries?: number;
  backoffMs?: number;
};

export type UploadResult =
  | { ok: true; complete: boolean }
  | { ok: false; message: string; refused: boolean; partsDone: number; fieldErrors?: Record<string, string> };

/** How many parts a recording of `bytes` is sent in. */
export function partCount(bytes: number, partBytes = MEETING_AUDIO_PART_BYTES): number {
  return Math.ceil(bytes / partBytes);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * Sends `blob` in order, skipping `present` parts. Resolves `{ ok: true, complete }` (complete = the server said it
 * has every part, or every part was already there) or `{ ok: false, message, refused }` — `refused` when the server
 * said no (don't retry), false for a network failure or abort (try again later; the parts sent so far are kept).
 */
export async function uploadRecording(blob: Blob, opts: UploadOptions): Promise<UploadResult> {
  const partBytes = opts.partBytes ?? MEETING_AUDIO_PART_BYTES;
  const total = partCount(blob.size, partBytes);
  const retries = opts.retries ?? 3;
  const backoff = opts.backoffMs ?? 1000;
  const have = new Set((opts.present ?? []).filter((p) => Number.isInteger(p) && p >= 0 && p < total));
  const type = normalizeMeetingAudioType(opts.audioType) ?? "audio/webm";
  const ext = meetingAudioExtension(type);
  const sizeOf = (i: number) => Math.min(partBytes, blob.size - i * partBytes);
  let bytesDone = [...have].reduce((n, i) => n + sizeOf(i), 0);
  const report = () => opts.onProgress?.({ partsDone: have.size, partsTotal: total, bytesDone, bytesTotal: blob.size });
  report();

  let complete = total > 0 && have.size === total;
  for (let i = 0; i < total; i++) {
    if (have.has(i)) continue;
    let attempt = 0;
    for (;;) {
      if (opts.signal?.aborted) return { ok: false, message: "The upload was stopped.", refused: false, partsDone: have.size };
      const fd = new FormData();
      fd.set("recapId", opts.recapId);
      fd.set("position", String(i));
      fd.set("file", new File([blob.slice(i * partBytes, i * partBytes + sizeOf(i), type)], `recording-${i + 1}.${ext}`, { type }));
      let res: SendPartResult;
      try {
        res = await opts.sendPart(fd);
      } catch {
        if (attempt >= retries) {
          return {
            ok: false,
            message: "The upload stopped: couldn't reach the portal. Check the internet connection, then finish the upload.",
            refused: false,
            partsDone: have.size,
          };
        }
        await sleep(backoff * 3 ** attempt, opts.signal);
        attempt++;
        continue;
      }
      if (!res?.ok) {
        return {
          ok: false,
          message: res?.message || "The portal didn't accept the recording.",
          refused: true,
          partsDone: have.size,
          ...(res?.fieldErrors ? { fieldErrors: res.fieldErrors } : {}),
        };
      }
      have.add(i);
      bytesDone += sizeOf(i);
      complete = !!res.complete;
      report();
      break;
    }
  }
  return { ok: true, complete };
}
