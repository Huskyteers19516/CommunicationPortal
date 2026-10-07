// WebM from MediaRecorder has no duration in its header: <audio> reports `duration = Infinity`, seeking does
// nothing and there's no progress bar. Setting `currentTime` to a huge value makes the browser scan the whole file
// and fire `durationchange` with the real length; then it's rewound to 0. Ported verbatim from VoiceCollector's
// player.js. Browser only.

/**
 * Makes `el` (with its `src` already set) know its real duration. Resolves with it in seconds, or 0 when it can't
 * be found within `timeoutMs` or the browser can't read the file (`error`; the recording still plays from the start,
 * or the player shows its own error).
 */
export function fixDuration(el: HTMLMediaElement, timeoutMs = 8000): Promise<number> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (d: number) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      el.removeEventListener("durationchange", onDur);
      el.removeEventListener("loadedmetadata", onMeta);
      el.removeEventListener("error", onError);
      try {
        el.currentTime = 0;
      } catch {
        // not seekable yet
      }
      resolve(Number.isFinite(d) && d > 0 ? d : 0);
    };
    const onDur = () => {
      const d = el.duration;
      if (Number.isFinite(d) && d > 0) finish(d);
    };
    const onMeta = () => {
      const d = el.duration;
      if (Number.isFinite(d) && d > 0) {
        finish(d);
        return;
      }
      // Infinity: force the browser to scan to the end.
      try {
        el.currentTime = 1e101;
      } catch {
        finish(0);
      }
    };
    const onError = () => finish(0);
    const timer = setTimeout(() => finish(el.duration), timeoutMs);
    el.addEventListener("durationchange", onDur);
    el.addEventListener("loadedmetadata", onMeta);
    el.addEventListener("error", onError);
    if (el.readyState >= 1) onMeta();
  });
}
