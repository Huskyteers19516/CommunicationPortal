"use client";

import { useEffect } from "react";

/** Room kept above what's scrolled to (the phone's sticky top bar; matches the feed's `scroll-mt-24`). */
const TOP_OFFSET = 96;

/**
 * Moves focus to the element with `targetId` once, when the page opens (e.g. the update that was just posted),
 * so keyboard and screen-reader users land on it instead of on <body>. The element needs tabIndex={-1}.
 * It scrolls so the update shows with its context: its meeting day's heading when both fit on the screen,
 * else its subteam's column header, else the update itself.
 */
export function FocusHere({ targetId }: { targetId: string }) {
  useEffect(() => {
    const el = document.getElementById(targetId);
    if (!el) return;
    el.focus({ preventScroll: true });
    const bottom = el.getBoundingClientRect().bottom;
    const room = window.innerHeight - TOP_OFFSET;
    const context = [el.closest("section"), el.closest('[role="group"]')].find(
      (c): c is HTMLElement => c instanceof HTMLElement && bottom - c.getBoundingClientRect().top <= room,
    );
    (context ?? el).scrollIntoView({ block: "start" });
  }, [targetId]);
  return null;
}
