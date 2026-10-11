"use client";

import { useLayoutEffect, useRef, useState, type MouseEvent } from "react";

/** Slide + resize with a slight spring at the end; none for people who turned motion down. */
export const INDICATOR_MOTION =
  "transition-[transform,width,height] duration-[450ms] ease-[cubic-bezier(0.34,1.45,0.64,1)] motion-reduce:transition-none";

type Box = { x: number; y: number; w: number; h: number };

/** Last spot per `memoryKey`, so a tab bar that remounts on navigation (a new page) slides from where it was. */
const lastBox = new Map<string, Box>();

/**
 * A highlight that slides to the active item instead of jumping. Put `containerRef` on a `relative` element,
 * `indicatorRef` on an absolutely positioned child at top-left (`absolute left-0 top-0`), and
 * `data-indicator-key={key}` on each item. Until the indicator is placed (server render, first paint) the container
 * has no `data-indicator` attribute, so items should keep their own active styling behind
 * `group-data-[indicator=on]:…` overrides. Writes straight to the DOM: no re-render per frame. Give the indicator
 * `INDICATOR_MOTION` so it slides from the old item to the new one, size following, with a little overshoot.
 */
export function useSlidingIndicator<C extends HTMLElement, I extends HTMLElement>(activeKey: string | null, memoryKey?: string) {
  const containerRef = useRef<C>(null);
  const indicatorRef = useRef<I>(null);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const indicator = indicatorRef.current;
    if (!container || !indicator) return;
    const target =
      activeKey == null ? null : container.querySelector<HTMLElement>(`[data-indicator-key="${CSS.escape(activeKey)}"]`);

    const apply = (box: Box, animate: boolean) => {
      indicator.style.transitionDuration = animate ? "" : "0s";
      indicator.style.transform = `translate(${box.x}px, ${box.y}px)`;
      indicator.style.width = `${box.w}px`;
      indicator.style.height = `${box.h}px`;
      indicator.style.opacity = "1";
    };
    const measure = (): Box | null =>
      target ? { x: target.offsetLeft, y: target.offsetTop, w: target.offsetWidth, h: target.offsetHeight } : null;

    const box = measure();
    if (!box) {
      indicator.style.opacity = "0";
      container.removeAttribute("data-indicator");
      return;
    }
    const visible = indicator.style.opacity === "1";
    const from = !visible && memoryKey ? lastBox.get(memoryKey) : undefined;
    if (from) {
      apply(from, false);
      void indicator.offsetWidth; // commit the start position so the move below animates
    }
    apply(box, visible || !!from);
    container.setAttribute("data-indicator", "on");
    if (memoryKey) lastBox.set(memoryKey, box);

    // Follow layout changes (a submenu opening above, a count bubble appearing, window resize). Re-aiming mid-slide
    // keeps animating from wherever the highlight is now. A ResizeObserver reports once as soon as it starts.
    let placed = box;
    const observer = new ResizeObserver(() => {
      const next = measure();
      if (!next || (next.x === placed.x && next.y === placed.y && next.w === placed.w && next.h === placed.h)) return;
      placed = next;
      apply(next, true);
      if (memoryKey) lastBox.set(memoryKey, next);
    });
    observer.observe(container);
    observer.observe(target!);
    return () => observer.disconnect();
  }, [activeKey, memoryKey]);

  return { containerRef, indicatorRef };
}

/**
 * The key the indicator should sit on: the clicked item right away (the server may take a moment to render the next
 * page), falling back to `currentKey` once navigation lands. `onPick` goes on each link's onClick.
 */
export function useOptimisticActive(currentKey: string | null) {
  const [picked, setPicked] = useState<{ key: string; from: string | null } | null>(null);
  const activeKey = picked && picked.from === currentKey ? picked.key : currentKey;
  const onPick = (key: string) => (e: MouseEvent) => {
    // New tab / window: this page isn't going anywhere.
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    setPicked({ key, from: currentKey });
  };
  return { activeKey, onPick };
}
