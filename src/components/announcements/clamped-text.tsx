"use client";

import { useEffect, useId, useRef, useState } from "react";
import { RichText } from "@/components/ui/rich-text";
import { cn } from "@/lib/cn";

/**
 * A long announcement's text, folded to its first lines with "Show more" (only when it really doesn't fit — it's
 * measured, so a text that fits on a wide screen gets no button). The whole text is always on the page.
 */
export function ClampedText({ text, className }: { text: string; className?: string }) {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);

  useEffect(() => {
    // The folded text itself (RichText's element): cut off when its content is taller than what's shown.
    const el = ref.current?.firstElementChild;
    if (!(el instanceof HTMLElement) || expanded) return;
    // A ResizeObserver reports once as soon as it starts, then on every size change (rotating a phone…).
    const observer = new ResizeObserver(() => setOverflows(el.scrollHeight > el.clientHeight + 1));
    observer.observe(el);
    return () => observer.disconnect();
  }, [expanded, text]);

  return (
    <div>
      <div ref={ref} id={id}>
        <RichText text={text} className={cn(className, !expanded && "line-clamp-10")} />
      </div>
      {(overflows || expanded) && (
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={id}
          onClick={() => setExpanded((v) => !v)}
          className="-ml-2 mt-1 inline-flex h-10 items-center rounded-lg px-2 text-sm font-medium text-brand-700 transition-colors hover:bg-brand-50 hover:text-brand-800"
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}
