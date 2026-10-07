// Fetching a saved recap's recording in the browser: its parts one after another (GET /meetings/audio/[id], each
// ≤ 3 MiB so every response stays under Vercel's limit), joined into one file. Used by the player and the edit page's
// "Transcribe the recording again". No React.
import { meetingAudioPartHref, type MeetingAudioType } from "@/lib/meeting-recaps";

/** A saved recording ("ready" MeetingAudioState): its parts by position, its type, and its whole size. */
export interface RecordingParts {
  partIds: string[];
  audioType: MeetingAudioType;
  audioBytes: number;
}

export const RECORDING_LOAD_FAILED = "Couldn't load the recording. Check your connection and try again.";
export const RECORDING_GONE = "The recording was just deleted (recordings are kept for 3 days).";
export const RECORDING_SIGNED_OUT = "You've been signed out. Sign in again to listen.";

/** The messages fetchRecording fails with. */
export const RECORDING_MESSAGES: ReadonlySet<string> = new Set([RECORDING_LOAD_FAILED, RECORDING_GONE, RECORDING_SIGNED_OUT]);

/**
 * Fetches a recording's parts in order, one at a time, and joins them into one Blob of its type. `onProgress` gets
 * the bytes so far after each part. Fails with RECORDING_GONE when a part is a 404 (deleted or past its 3 days
 * meanwhile; the parts after it aren't asked for), RECORDING_SIGNED_OUT when the route sent the browser to the sign-in
 * page, and RECORDING_LOAD_FAILED for any other refusal or when the sizes don't add up. An abort rejects with the
 * fetch's own AbortError.
 */
export async function fetchRecording(source: RecordingParts, signal: AbortSignal, onProgress: (bytes: number) => void): Promise<Blob> {
  const parts: Blob[] = [];
  let bytes = 0;
  for (const id of source.partIds) {
    const res = await fetch(meetingAudioPartHref(id), { signal, cache: "no-store", credentials: "same-origin" });
    // Signed out meanwhile: the route sends the browser to the sign-in page instead.
    if (res.redirected) throw new Error(RECORDING_SIGNED_OUT);
    if (res.status === 404) throw new Error(RECORDING_GONE);
    if (!res.ok) throw new Error(RECORDING_LOAD_FAILED);
    const part = await res.blob();
    parts.push(part);
    bytes += part.size;
    onProgress(bytes);
  }
  if (bytes !== source.audioBytes) throw new Error(RECORDING_LOAD_FAILED);
  return new Blob(parts, { type: source.audioType });
}
