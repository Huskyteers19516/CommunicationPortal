"use client";

import { type ReactNode, useEffect, useRef } from "react";

/**
 * On phones the "For" chips scroll sideways, so the chosen one (e.g. "Whole team") can start off-screen with no
 * chip in view looking selected. This scrolls that row — never the page — until the chip marked aria-current is
 * in view.
 */
export function ActiveChipInView({ active, children, className }: { active: string; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const chip = ref.current?.querySelector<HTMLElement>('[aria-current="true"]');
    const row = chip?.closest("nav");
    if (!chip || !row || row.scrollWidth <= row.clientWidth) return;
    const c = chip.getBoundingClientRect();
    const r = row.getBoundingClientRect();
    if (c.left >= r.left && c.right <= r.right) return;
    row.scrollLeft += c.left + c.width / 2 - (r.left + r.width / 2);
  }, [active]);
  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
}
