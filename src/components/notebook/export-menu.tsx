"use client";

import { ChevronDown, Download, FileText, Printer } from "lucide-react";
import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { exportMenuSide } from "@/lib/notebook";
import { buttonClasses, type ButtonVariant } from "../ui/button";

/**
 * "Export" with two choices: a Word file (downloads) and a print view (to print or save as PDF). A small menu:
 * Escape or a tap outside closes it, and focus goes back to the button. It opens toward whichever side has room,
 * so it never runs off a phone's screen.
 */
export function ExportMenu({
  wordHref,
  printHref,
  label,
  variant = "secondary",
  align = "start",
}: {
  wordHref: string;
  printHref: string;
  /** What's exported, for screen readers: "Hardware Notebook". */
  label: string;
  variant?: ButtonVariant;
  /** Which edge of the button the menu lines up with when there's room for it (otherwise the other one). */
  align?: "start" | "end";
}) {
  const [open, setOpen] = useState(false);
  const [side, setSide] = useState<"start" | "end">(align);
  const menuId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [open]);

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape" && open) {
      e.preventDefault();
      setOpen(false);
      buttonRef.current?.focus();
    }
  }

  const item =
    "flex min-h-11 items-center gap-2.5 rounded-md px-3 text-sm font-medium text-ink-800 hover:bg-ink-50 focus-visible:bg-ink-50 focus-visible:outline-none";

  return (
    <div ref={rootRef} className="relative" onKeyDown={onKeyDown}>
      <button
        ref={buttonRef}
        type="button"
        className={buttonClasses(variant, "md")}
        aria-expanded={open}
        aria-controls={menuId}
        aria-label={`Export ${label}`}
        onClick={() => {
          if (!open) {
            const rect = rootRef.current?.getBoundingClientRect();
            if (rect) setSide(exportMenuSide(rect, document.documentElement.clientWidth, align));
          }
          setOpen((v) => !v);
        }}
      >
        <Download className="size-4" aria-hidden />
        Export
        <ChevronDown className={cn("size-4 transition-transform", open && "rotate-180")} aria-hidden />
      </button>
      {open && (
        <div
          id={menuId}
          data-side={side}
          className={cn(
            "absolute top-full z-30 mt-1 w-60 max-w-[calc(100vw-2rem)] rounded-lg border border-ink-200 bg-white p-1 shadow-lg",
            side === "end" ? "right-0" : "left-0",
          )}
        >
          <a href={wordHref} className={item} onClick={() => setOpen(false)}>
            <FileText className="size-4 shrink-0 text-brand-700" aria-hidden />
            Word (.docx)
          </a>
          <a href={printHref} className={item} onClick={() => setOpen(false)}>
            <Printer className="size-4 shrink-0 text-brand-700" aria-hidden />
            Print / Save as PDF
          </a>
        </div>
      )}
    </div>
  );
}
