"use client";

import Link from "next/link";
import { cn } from "@/lib/cn";
import { CountBubble } from "./badge";
import { INDICATOR_MOTION, useOptimisticActive, useSlidingIndicator } from "./sliding-indicator";

export interface LinkTab {
  href: string;
  label: string;
  active: boolean;
  count?: number;
  /** "alert" = green bubble for things that need action (e.g. an inbox); default is a quiet gray count. */
  tone?: "alert" | "neutral";
}

/**
 * URL-driven tabs. Build hrefs with search params, e.g. `?tab=done`. The underline slides to a tab as soon as it's
 * clicked, and slides over from the old tab when the next page brings its own tab bar.
 */
export function LinkTabs({ tabs, className }: { tabs: LinkTab[]; className?: string }) {
  const { activeKey, onPick } = useOptimisticActive(tabs.find((t) => t.active)?.href ?? null);
  const { containerRef, indicatorRef } = useSlidingIndicator<HTMLElement, HTMLSpanElement>(
    activeKey,
    tabs.map((t) => t.label).join("|"),
  );
  return (
    <div className={cn("-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0", className)}>
      <nav ref={containerRef} className="group relative inline-flex min-w-full gap-1 border-b border-ink-200 sm:min-w-0" aria-label="Tabs">
        {tabs.map((t) => {
          const on = t.href === activeKey;
          return (
            <Link
              key={t.href}
              href={t.href}
              onClick={onPick(t.href)}
              data-indicator-key={t.href}
              aria-current={t.active ? "page" : undefined}
              className={cn(
                "-mb-px inline-flex items-center gap-2 whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-medium transition-colors",
                on
                  ? "border-brand-500 text-brand-700 group-data-[indicator=on]:border-transparent"
                  : "border-transparent text-ink-500 hover:border-ink-300 hover:text-ink-800",
              )}
            >
              {t.label}
              {t.tone === "alert" ? (
                <CountBubble count={t.count ?? 0} />
              ) : (
                !!t.count && (
                  <span className="inline-flex min-w-5 items-center justify-center rounded-full bg-ink-100 px-1.5 text-[11px] font-semibold leading-5 tabular-nums text-ink-600">
                    {t.count > 99 ? "99+" : t.count}
                  </span>
                )
              )}
            </Link>
          );
        })}
        {/* The underline: a 2px bar riding the active tab's bottom edge (the box is the tab, the bar is its bottom 2px). */}
        <span
          ref={indicatorRef}
          aria-hidden
          className={cn(
            "pointer-events-none absolute left-0 top-0 opacity-0 after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:rounded-full after:bg-brand-500",
            INDICATOR_MOTION,
          )}
        />
      </nav>
    </div>
  );
}
