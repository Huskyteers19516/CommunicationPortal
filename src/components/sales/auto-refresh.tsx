"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Keeps a screen current (the order queue on a tablet by the kitchen): refreshes while the tab is visible. */
export function AutoRefresh({ seconds }: { seconds: number }) {
  const router = useRouter();
  useEffect(() => {
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, seconds * 1000);
    return () => window.clearInterval(id);
  }, [router, seconds]);
  return null;
}
