"use client";

import { type ReactNode, useEffect, useRef } from "react";

/**
 * Wraps a sideways-scrolling FilterChips strip and scrolls it so the active chip is in view. On a phone the category
 * strip is wider than the screen, and a reload, a shared link, or going back starts it at the left, where the active
 * chip (e.g. Ideas) can be off-screen. Only the strip scrolls, never the page. `active` = the active chip's value, so
 * it runs again when that changes. Adds no box of its own (`contents`), so the layout is the strip's.
 */
export function KeepChipInView({ active, children }: { active: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const strip = ref.current?.querySelector<HTMLElement>("nav");
    const chip = strip?.querySelector<HTMLElement>('[aria-current="true"]');
    if (!strip || !chip) return;
    const style = getComputedStyle(strip);
    const box = strip.getBoundingClientRect();
    const left = box.left + (Number.parseFloat(style.paddingLeft) || 0);
    const right = box.right - (Number.parseFloat(style.paddingRight) || 0);
    const at = chip.getBoundingClientRect();
    if (at.right > right) strip.scrollLeft += at.right - right;
    else if (at.left < left) strip.scrollLeft -= left - at.left;
  }, [active]);
  return (
    <div ref={ref} className="contents">
      {children}
    </div>
  );
}
