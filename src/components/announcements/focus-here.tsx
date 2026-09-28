"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/**
 * Moves focus to the element with `targetId` once, when the page opens (the announcement just posted or saved, or
 * the one opened from Today), so keyboard and screen-reader users land on it instead of on <body>. The element needs
 * tabIndex={-1} (and a scroll margin for the phone's sticky top bar).
 */
export function FocusHere({ targetId }: { targetId: string }) {
  useEffect(() => {
    const el = document.getElementById(targetId);
    if (!el) return;
    el.focus({ preventScroll: true });
    el.scrollIntoView({ block: "start" });
  }, [targetId]);
  return null;
}

/**
 * Once the page is shown, replaces its address with `href` — by default the same one without its #hash — without
 * scrolling (e.g. "?posted=…#announcement-…" → "?focus=…"): a reload doesn't say "Posted." again, and later
 * refreshes (Pin) don't re-apply the #hash, which kept the next page (e.g. Today) from opening at the top.
 */
export function TidyAddress({ href }: { href?: string }) {
  const router = useRouter();
  useEffect(() => {
    const target = href ?? `${location.pathname}${location.search}`;
    if (`${location.pathname}${location.search}${location.hash}` !== target) router.replace(target, { scroll: false });
  }, [href, router]);
  return null;
}
