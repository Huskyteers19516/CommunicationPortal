"use client";

import { useEffect, useRef } from "react";

/**
 * After Newer / Older, focus moves to `targetId` (the list's count line, which says the page) instead of falling to
 * <body> when the pressed button goes away — so screen readers say where they are, and Tab continues from the top of
 * the list. Only when the person paged (focus was on Newer / Older, or lost): picking a filter chip keeps focus on
 * the chips.
 */
export function FocusOnPageChange({ page, targetId }: { page: number; targetId: string }) {
  const last = useRef(page);
  useEffect(() => {
    if (last.current === page) return;
    last.current = page;
    const active = document.activeElement;
    if (active && active !== document.body && !active.closest('nav[aria-label="Pages"]')) return;
    document.getElementById(targetId)?.focus();
  }, [page, targetId]);
  return null;
}
