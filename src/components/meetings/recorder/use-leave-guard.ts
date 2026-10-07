"use client";

import { useCallback, useEffect, useRef } from "react";

/**
 * While `message` is set (recording, or a recording not saved yet), leaving the page asks first: the browser's own
 * "Leave site?" prompt on close, reload, or back, and `message` in a confirm for any link on the page (the header's
 * "Meeting recaps" included; links that open elsewhere or download are left alone). Returns `allowLeave()`, for the
 * page's own navigation once the work is saved (`window.location.assign`).
 */
export function useLeaveGuard(message: string | null): () => void {
  const allowed = useRef(false);

  useEffect(() => {
    if (!message) return;
    allowed.current = false;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (allowed.current) return;
      e.preventDefault();
      e.returnValue = "";
    };
    const onClick = (e: MouseEvent) => {
      if (allowed.current || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const link = e.target instanceof Element ? e.target.closest("a[href]") : null;
      if (!(link instanceof HTMLAnchorElement) || link.hasAttribute("download") || (link.target && link.target !== "_self")) return;
      const to = new URL(link.href, window.location.href);
      const here = new URL(window.location.href);
      if (to.origin === here.origin && to.pathname === here.pathname && to.search === here.search && to.hash) return; // same page
      if (window.confirm(message)) {
        allowed.current = true; // no second "Leave site?" from the browser
        return;
      }
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("click", onClick, true);
    };
  }, [message]);

  return useCallback(() => {
    allowed.current = true;
  }, []);
}
