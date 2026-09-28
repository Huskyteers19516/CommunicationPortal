"use client";

import { type ReactNode, useEffect, useRef } from "react";
import { cn } from "@/lib/cn";

/**
 * Who's coming's day tiles. On phones they're one row that scrolls sideways (inside itself, never the page), so the
 * picked day's tile (`aria-current`) is scrolled into view, e.g. when it's opened from an extra meeting's page for a
 * day far down the list. From `sm` up it's a grid and nothing moves.
 */
export function DayTileList({ selected, className, children }: { selected: string | null; className?: string; children: ReactNode }) {
  const ref = useRef<HTMLUListElement>(null);
  useEffect(() => {
    const list = ref.current;
    const tile = list?.querySelector<HTMLElement>('[aria-current="page"]')?.closest("li");
    if (!list || !tile || list.scrollWidth <= list.clientWidth) return;
    // offsetLeft is measured from the list (it's `relative`); leave the list's own padding before the tile.
    const start = tile.offsetLeft;
    const end = start + tile.offsetWidth;
    if (start >= list.scrollLeft && end <= list.scrollLeft + list.clientWidth) return;
    list.scrollLeft = Math.max(0, start - parseFloat(getComputedStyle(list).paddingLeft || "0"));
  }, [selected]);
  return (
    <ul ref={ref} className={cn("relative", className)}>
      {children}
    </ul>
  );
}
