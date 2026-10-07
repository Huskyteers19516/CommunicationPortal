// Keeps the screen on while a meeting is recorded (a sleeping laptop stops the microphone). The browser drops the
// lock whenever the tab is hidden, so it's requested again when the tab comes back. Only a native app could stop
// the computer itself from sleeping. Browser only; does nothing where the Screen Wake Lock API is missing.

export type ScreenWakeLock = {
  /** Whether this browser can keep the screen on. */
  readonly supported: boolean;
  /** Keep the screen on until release() (re-requested whenever the tab becomes visible again). */
  acquire(): Promise<void>;
  release(): void;
};

export function createScreenWakeLock(): ScreenWakeLock {
  const supported = typeof navigator !== "undefined" && "wakeLock" in navigator;
  let wanted = false;
  let sentinel: WakeLockSentinel | null = null;

  async function request() {
    if (!supported || !wanted || sentinel || document.visibilityState !== "visible") return;
    try {
      const s = await navigator.wakeLock.request("screen");
      if (!wanted) {
        void s.release().catch(() => {});
        return;
      }
      sentinel = s;
      s.addEventListener("release", () => {
        if (sentinel === s) sentinel = null;
      });
    } catch {
      // refused (battery saver, not visible): try again on the next visibility change
    }
  }

  function onVisibility() {
    if (document.visibilityState === "visible") void request();
  }

  return {
    supported,
    async acquire() {
      if (wanted) return;
      wanted = true;
      document.addEventListener("visibilitychange", onVisibility);
      await request();
    },
    release() {
      wanted = false;
      document.removeEventListener("visibilitychange", onVisibility);
      const s = sentinel;
      sentinel = null;
      if (s) void s.release().catch(() => {});
    },
  };
}
