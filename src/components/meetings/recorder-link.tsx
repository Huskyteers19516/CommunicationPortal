import type { ReactNode } from "react";

/** The recorder's page. */
export const MEETING_RECORDER_HREF = "/meetings/record";

/**
 * A link to the recorder (/meetings/record) that always loads the page afresh — a plain <a>, not next/link: the
 * recorder lives outside the app's frame (its own route group) and starts its microphone and speech-to-text engine
 * from a clean page.
 */
export function RecorderLink({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <a href={MEETING_RECORDER_HREF} className={className}>
      {children}
    </a>
  );
}
