// Which recordings kept in this browser (recorder-db.ts) another tab has open: the tab that records, reviews, or
// uploads one holds a Web Lock named after it, so the recorder page in a second tab doesn't offer to save the same
// meeting twice — and a "recording" nobody holds was cut off (a closed or crashed tab lets go of its locks by
// itself), so it can be offered right away. Browser only.

const PREFIX = "huskyteers-recorder:";

/** Holds the lock for recording `id` until the returned function is called (or the tab goes). */
export function lockRecording(id: string): () => void {
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  if (!locks?.request) return () => {};
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  locks.request(`${PREFIX}${id}`, { ifAvailable: true }, (lock) => (lock ? held : undefined)).catch(() => {});
  return release;
}

/**
 * The ids of recordings a tab holds right now, or null when this browser can't say (no Web Locks: then only the
 * recording doc's heartbeat tells a live recording from a cut-off one, see findRecoverable).
 */
export async function recordingsOpenElsewhere(): Promise<Set<string> | null> {
  try {
    if (typeof navigator === "undefined" || !navigator.locks?.query) return null;
    const { held = [] } = await navigator.locks.query();
    return new Set(
      held
        .map((l) => l.name ?? "")
        .filter((name) => name.startsWith(PREFIX))
        .map((name) => name.slice(PREFIX.length)),
    );
  } catch {
    return null;
  }
}
