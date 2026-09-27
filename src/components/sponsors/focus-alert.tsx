"use client";

import { type ComponentProps, useEffect, useRef } from "react";
import { Alert } from "@/components/ui/alert";

/**
 * An Alert that takes focus when it appears (e.g. "Removed Polymaker." after a redirect), so keyboard and
 * screen-reader users hear what happened instead of landing on <body>.
 */
export function FocusAlert(props: ComponentProps<typeof Alert>) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <div ref={ref} tabIndex={-1} className="rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40">
      <Alert {...props} />
    </div>
  );
}
