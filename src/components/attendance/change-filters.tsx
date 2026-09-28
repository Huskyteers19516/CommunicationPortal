"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, type ReactNode, useEffect, useRef } from "react";

/**
 * The change log's filter form. A plain GET form (works without JavaScript); with it, the address only gets the
 * filters that are set (no "?by=&action=…") and the page updates without jumping to the top.
 */
export function ChangeFilterForm({ action, children }: { action: string; children: ReactNode }) {
  const router = useRouter();
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const sp = new URLSearchParams();
    for (const [key, value] of new FormData(e.currentTarget)) {
      if (typeof value === "string" && value.trim() !== "") sp.set(key, value.trim());
    }
    const qs = sp.toString();
    router.push(qs ? `${action}?${qs}` : action, { scroll: false });
  }
  return (
    <form method="get" action={action} role="search" aria-label="Filter changes" onSubmit={onSubmit} className="space-y-2">
      {children}
    </form>
  );
}

/**
 * "17 changes match": a status line that takes focus when the filters change (not when the page first opens), so
 * keyboard and screen reader users hear the result instead of landing on <body>.
 */
export function ChangeCount({ query, children, className }: { query: string; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const seen = useRef(query);
  useEffect(() => {
    if (seen.current === query) return;
    seen.current = query;
    ref.current?.focus();
  }, [query]);
  return (
    <p ref={ref} tabIndex={-1} role="status" className={className}>
      {children}
    </p>
  );
}
