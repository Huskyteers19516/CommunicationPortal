"use client";

import { ChevronDown } from "lucide-react";
import { type KeyboardEvent, type MouseEvent, type ReactNode, type SyntheticEvent, useEffect, useRef, useState } from "react";

/**
 * "Jump to a page" on phones: a fold-out list of every notebook's pages over the entries. Like the Export menu,
 * Escape or a tap outside closes it (Escape puts focus back on it), and so does picking a page.
 */
export function JumpMenu({ label, children }: { label: string; children: ReactNode }) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const summaryRef = useRef<HTMLElement>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      const details = detailsRef.current;
      if (details && !details.contains(e.target as Node)) details.open = false;
    };
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [open]);

  function onToggle(e: SyntheticEvent<HTMLDetailsElement>) {
    // The notebooks inside fold up too; only this menu's own toggle counts.
    if (e.target === e.currentTarget) setOpen(e.currentTarget.open);
  }

  function onKeyDown(e: KeyboardEvent<HTMLDetailsElement>) {
    const details = detailsRef.current;
    if (e.key === "Escape" && details?.open) {
      e.preventDefault();
      details.open = false;
      summaryRef.current?.focus();
    }
  }

  function onClick(e: MouseEvent<HTMLDetailsElement>) {
    const details = detailsRef.current;
    if (details && (e.target as HTMLElement).closest("a")) details.open = false;
  }

  return (
    <details ref={detailsRef} className="group/jump ml-auto" onToggle={onToggle} onKeyDown={onKeyDown} onClick={onClick}>
      <summary
        ref={summaryRef}
        className="flex h-10 cursor-pointer list-none items-center gap-1 rounded-lg px-2 text-sm font-medium text-brand-700 hover:bg-brand-50 [&::-webkit-details-marker]:hidden"
      >
        {label}
        <ChevronDown className="size-4 transition-transform group-open/jump:rotate-180" aria-hidden />
      </summary>
      <div className="absolute inset-x-0 top-full z-20 mt-1 max-h-[70vh] overflow-y-auto rounded-xl border border-ink-200 bg-white p-2 shadow-lg">
        {children}
      </div>
    </details>
  );
}
