"use client";

import { Maximize, Minimize, RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { getLiveCodeAction } from "@/app/(app)/attendance/actions";
import { cn } from "@/lib/cn";
import type { LiveCode } from "@/server/queries/attendance";
import { Button } from "../ui/button";

/**
 * A new code is fetched right after the current one runs out (the server says when, so a wrong clock here doesn't
 * matter), but never more often than every few seconds, and at least every 30 seconds.
 */
const MIN_WAIT_MS = 3_000;
const MAX_WAIT_MS = 30_000;
/** After a failed fetch, try again after this long. */
const RETRY_MS = 10_000;

/**
 * Refresh the page's server data every few seconds while it's visible (live count and roster). Each refresh
 * re-renders the whole page on the server, so not too often.
 */
export function LiveRefresh({ intervalMs = 10_000 }: { intervalMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, intervalMs);
    return () => clearInterval(timer);
  }, [router, intervalMs]);
  return null;
}

function spaced(code: string): string {
  return `${code.slice(0, 3)} ${code.slice(3)}`;
}

function QrImage({ code, className }: { code: Extract<LiveCode, { ok: true }>; className?: string }) {
  return (
    // A data: URL of our own server-made SVG (never user content), so no HTML is injected.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(code.svg)}`}
      alt="QR code for checking in"
      className={cn("aspect-square w-full bg-white [image-rendering:pixelated]", className)}
    />
  );
}

/**
 * The projector view: a big QR code that changes every 30 seconds, the 6-digit code under it, and the live
 * count. "Full screen" covers the app (and asks the browser for full screen), so the whole room can scan it:
 * the rest of the page is inert meanwhile, so focus stays in it. Esc or "Exit full screen" goes back.
 */
export function LiveCodePanel({
  sessionId,
  title,
  count,
  saidYes,
  latest = [],
}: {
  sessionId: string;
  /** e.g. "Regular · Thu, Sep 24". */
  title: string;
  count: number;
  saidYes: number;
  /** The last few people who checked in, newest first (so a stranger's name stands out on the projector). */
  latest?: string[];
}) {
  const router = useRouter();
  const [code, setCode] = useState<LiveCode | null>(null);
  const [full, setFull] = useState(false);
  const fullButtonRef = useRef<HTMLButtonElement>(null);
  const exitButtonRef = useRef<HTMLButtonElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const restoreFocus = useRef(false);

  // Load the code now, then again right after it runs out (while the page is visible).
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function load() {
      clearTimeout(timer);
      let wait = RETRY_MS;
      try {
        const next = await getLiveCodeAction(sessionId);
        if (!alive) return;
        setCode(next);
        if (!next.ok && next.closed) {
          router.refresh();
          return; // closed: nothing more to show
        }
        if (next.ok) wait = Math.min(MAX_WAIT_MS, Math.max(MIN_WAIT_MS, next.expiresInMs + 300));
      } catch {
        if (!alive) return;
        setCode((prev) => (prev?.ok ? prev : { ok: false, message: "Couldn't load the code. Trying again…" }));
      }
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (document.visibilityState === "visible") void load();
      }, wait);
    }
    // Deferred so the first load isn't a state update inside the effect itself.
    const first = setTimeout(load, 0);
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      clearTimeout(first);
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [sessionId, router]);

  const exitFull = useCallback(() => {
    setFull(false);
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
  }, []);

  function enterFull() {
    setFull(true);
    void document.documentElement.requestFullscreen?.().catch(() => {});
  }

  // Full screen: everything else on the page is inert (no Tab into it); Esc or leaving the browser's full
  // screen closes it; the page behind doesn't scroll.
  useEffect(() => {
    if (!full) return;
    const overlay = overlayRef.current;
    const others = Array.from(document.body.children).filter(
      (el): el is HTMLElement => el instanceof HTMLElement && el !== overlay && !el.inert,
    );
    for (const el of others) el.inert = true;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") exitFull();
    };
    const onFullscreenChange = () => {
      if (!document.fullscreenElement) exitFull();
    };
    const html = document.documentElement;
    const overflow = html.style.overflow;
    html.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => {
      for (const el of others) el.inert = false;
      html.style.overflow = overflow;
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("fullscreenchange", onFullscreenChange);
    };
  }, [full, exitFull]);

  // Focus goes to "Exit full screen" when it opens, and back to "Full screen" when it closes.
  useEffect(() => {
    if (full) {
      restoreFocus.current = true;
      exitButtonRef.current?.focus();
    } else if (restoreFocus.current) {
      restoreFocus.current = false;
      fullButtonRef.current?.focus();
    }
  }, [full]);

  const countLine = `${count} checked in${saidYes > 0 ? ` · ${saidYes} said they'd come` : ""}`;

  const body =
    code === null ? (
      <div className="flex aspect-square w-full items-center justify-center rounded-xl bg-ink-50 text-sm text-ink-500">
        <RefreshCw className="mr-2 size-4 animate-spin" aria-hidden />
        Making the code…
      </div>
    ) : code.ok ? null : (
      <div role="alert" className="flex aspect-square w-full items-center justify-center rounded-xl bg-ink-50 p-6 text-center text-sm text-ink-600">
        {code.message}
      </div>
    );

  return (
    <>
      <div className="space-y-4">
        <div className="mx-auto w-full max-w-md">{body ?? (code?.ok && <QrImage code={code} className="rounded-xl border border-ink-200" />)}</div>
        {code?.ok && (
          <div className="text-center">
            <p className="text-sm text-ink-500">Can&apos;t scan? Open Attendance and enter</p>
            <p className="font-mono text-4xl font-bold tracking-[0.2em] text-ink-900 sm:text-5xl" data-testid="attendance-code">
              {spaced(code.code)}
            </p>
            <p className="mt-1 text-xs text-ink-500">The code changes every 30 seconds.</p>
          </div>
        )}
        <div className="flex justify-center">
          <Button ref={fullButtonRef} variant="secondary" onClick={enterFull} disabled={!code?.ok}>
            <Maximize className="size-4" aria-hidden />
            Full screen
          </Button>
        </div>
      </div>

      {full &&
        createPortal(
          <div
            ref={overlayRef}
            role="dialog"
            aria-modal="true"
            aria-label={`Check in: ${title}`}
            className="fixed inset-0 z-[70] flex flex-col items-center justify-center gap-3 overflow-y-auto bg-white p-4 text-center sm:gap-4 sm:p-8"
          >
            <Button ref={exitButtonRef} variant="secondary" onClick={exitFull} className="absolute right-4 top-4">
              <Minimize className="size-4" aria-hidden />
              Exit full screen
            </Button>
            <p className="font-display text-2xl font-semibold uppercase tracking-wide text-ink-900 sm:text-4xl">Check in · {title}</p>
            <p className="text-base text-ink-600 sm:text-xl">Scan with your phone, or open Attendance → Enter code</p>
            <div className="w-[min(60vh,90vw)]">{body ?? (code?.ok && <QrImage code={code} />)}</div>
            {code?.ok && (
              <div>
                <p className="font-mono text-5xl font-bold tracking-[0.2em] text-ink-900 sm:text-7xl">{spaced(code.code)}</p>
                <p className="mt-1 text-sm text-ink-500 sm:text-base">Changes every 30 seconds</p>
              </div>
            )}
            <p className="text-lg font-medium text-brand-700 sm:text-2xl" role="status">
              {countLine}
            </p>
            {latest.length > 0 && (
              <p className="max-w-3xl text-base text-ink-600 wrap-anywhere sm:text-lg">Just checked in: {latest.join(", ")}</p>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
