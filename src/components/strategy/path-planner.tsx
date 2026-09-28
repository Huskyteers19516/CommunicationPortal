"use client";

import { ChevronDown, ExternalLink, Maximize, Monitor, Route } from "lucide-react";
import { type ReactNode, useId, useRef, useState, useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import { Button, buttonClasses } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { cn } from "@/lib/cn";
import { PEDRO_VISUALIZER_URL } from "@/lib/constants";

/**
 * Where the planner fits in the page: next to the sidebar, its frame is then about 1,080 px wide or more (it needs
 * about twice its height), so it opens right away (85rem = 1,360 px). Keep in step with the `min-[85rem]:` classes
 * below; they're in rem so Tailwind orders them after its `md:` ones (an arbitrary px breakpoint comes first).
 */
const ROOMY = "(min-width: 85rem)";

function subscribeRoomy(onChange: () => void) {
  const query = window.matchMedia(ROOMY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

const noSubscription = () => () => {};

/**
 * What the planner (the team's own Svelte app on GitHub Pages) needs inside the frame: its scripts and its own
 * storage (saved paths, settings), downloads (Save As, code and GIF export), alert/confirm (its messages), and new
 * tabs for its help links (opened without the sandbox). Nothing more: it can't navigate this page.
 */
export const PLANNER_SANDBOX =
  "allow-scripts allow-same-origin allow-downloads allow-popups allow-popups-to-escape-sandbox allow-forms allow-modals";

/**
 * The frame's size. Phones and tablets (when unfolded): tall. Big screens: twice as wide as it is tall (what the
 * planner needs to fit without scrolling sideways), at most 75% of the screen's height.
 */
const FRAME_SIZE =
  "h-[70dvh] min-h-96 md:h-[75vh] md:min-h-[32rem] min-[85rem]:aspect-[2/1] min-[85rem]:h-auto min-[85rem]:min-h-0 min-[85rem]:max-h-[75vh]";

/**
 * On big screens the planner is wider than the page's column: it takes the whole width next to the sidebar (less
 * 1 rem on each side, up to 90 rem), centered on the column, so the planner fits in it.
 */
const BREAKOUT =
  "min-[85rem]:w-[min(100vw_-_18rem,90rem)] min-[85rem]:ml-[calc((100%_-_min(100vw_-_18rem,90rem))/2)]";

const hintLink = "font-medium text-brand-700 underline underline-offset-2 hover:text-brand-800";

/**
 * The Pedro Pathing visualizer (BIOBUZZ edition) in a frame, with "Open in a new tab" always there (it works even
 * when the frame can't load) and Full screen where the browser can do it.
 * - `open` "wide" (the Strategy page): shown right away on big screens (wider than the page's column); on
 *   tablets, small laptops, and phones it's folded away behind "Show it here" (it needs a mouse and a big screen).
 * - `open` "asked" (a team's page: "Open the planner"): folded away everywhere until asked for.
 * The frame is only created once it's wanted, and then kept: hiding it again, or resizing the window, doesn't
 * throw away a path being drawn. `skipTo` adds a "skip the planner" link for keyboard users (only while it shows).
 */
export function PathPlanner({
  id = "planner",
  title = "Path planner",
  description = "Pedro Pathing visualizer, BIOBUZZ edition. Draw and time autonomous paths.",
  hint,
  open = "wide",
  showLabel,
  skipTo,
}: {
  id?: string;
  title?: string;
  description?: string;
  /** How to share a path (the planner's Save menu → Save As downloads a .pp file). "Not loading? …" is added. */
  hint: ReactNode;
  open?: "wide" | "asked";
  /** The unfold button's words when `open` is "asked" (default "Show the planner"). */
  showLabel?: string;
  /** Where the skip link jumps to ("#strategies") and what it says. */
  skipTo?: { href: string; label: string };
}) {
  const roomy = useSyncExternalStore(
    subscribeRoomy,
    () => window.matchMedia(ROOMY).matches,
    () => false,
  );
  // iPhones can't show a frame full screen: no button there.
  const canFullscreen = useSyncExternalStore(
    noSubscription,
    () => !!document.fullscreenEnabled,
    () => false,
  );
  const [shown, setShown] = useState(false);
  const [created, setCreated] = useState(false);
  const auto = open === "wide" && roomy;
  // Once wanted, the frame stays (adjusting state while rendering, not in an effect).
  if ((auto || shown) && !created) setCreated(true);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const uid = useId();
  const boxId = `${uid}-frame`;
  const titleId = `${uid}-title`;
  const hintId = `${uid}-hint`;
  const visible = shown || auto;

  function fullScreen() {
    // Folded away: unfold it first (right away, so the frame exists), then ask for full screen.
    if (!visible) flushSync(() => setShown(true));
    void frameRef.current?.requestFullscreen?.().catch(() => {});
  }

  const toggle = (
    <Button
      variant={open === "asked" && !shown ? "primary" : "secondary"}
      aria-expanded={shown}
      aria-controls={boxId}
      className="w-full sm:w-auto"
      onClick={() => setShown((s) => !s)}
    >
      {open === "asked" && !shown && <Route className="size-4" aria-hidden />}
      {shown ? "Hide it" : open === "asked" ? (showLabel ?? "Show the planner") : "Show it here"}
      {open === "asked" && <ChevronDown className={cn("size-4 transition-transform", shown && "rotate-180")} aria-hidden />}
    </Button>
  );

  return (
    <section id={id} aria-labelledby={titleId} className={cn("scroll-mt-4", BREAKOUT)}>
      <Card className="overflow-hidden">
        <CardHeader
          title={<span id={titleId}>{title}</span>}
          description={description}
          actions={
            <>
              {canFullscreen && (
                <Button variant="secondary" className="max-md:hidden" onClick={fullScreen}>
                  <Maximize className="size-4" aria-hidden />
                  Full screen
                </Button>
              )}
              <a href={PEDRO_VISUALIZER_URL} target="_blank" rel="noopener noreferrer" className={buttonClasses("secondary", "md")}>
                <ExternalLink className="size-4" aria-hidden />
                Open in a new tab
              </a>
            </>
          }
        />

        {/* The note, and the button that unfolds the planner here (below big screens, or everywhere when asked for). */}
        <div
          className={cn(
            "flex flex-col gap-3 px-4 py-3 sm:flex-row sm:flex-wrap sm:items-center sm:px-5",
            open === "wide" && "min-[85rem]:hidden",
          )}
        >
          <p className="flex min-w-0 items-center gap-2 text-sm text-ink-600 sm:flex-1 min-[85rem]:hidden">
            <Monitor className="size-4 shrink-0 text-brand-700" aria-hidden />
            <span className="md:hidden">Works best on a computer.</span>
            <span className="max-md:hidden">Works best in full screen or a new tab.</span>
          </p>
          {toggle}
        </div>

        {created && visible && skipTo && (
          <a
            href={skipTo.href}
            className="sr-only rounded-md text-sm font-medium text-brand-700 underline underline-offset-2 focus:not-sr-only focus:mx-4 focus:my-2 focus:inline-flex focus:min-h-10 focus:items-center focus:px-2 sm:focus:mx-5"
          >
            {skipTo.label}
          </a>
        )}

        <div
          id={boxId}
          className={cn(
            "border-t border-ink-100 bg-ink-50",
            shown ? "block" : open === "wide" ? "hidden min-[85rem]:block" : "hidden",
          )}
        >
          {created ? (
            <iframe
              ref={frameRef}
              src={PEDRO_VISUALIZER_URL}
              title="Pedro Pathing visualizer (BIOBUZZ)"
              loading="lazy"
              allowFullScreen
              allow="fullscreen; clipboard-write"
              sandbox={PLANNER_SANDBOX}
              aria-describedby={hintId}
              className={cn("block w-full border-0 bg-white", FRAME_SIZE)}
            />
          ) : (
            // Until the page is ready (big screens) — the same size, so nothing jumps.
            <div className={cn("w-full", FRAME_SIZE)} />
          )}
        </div>

        <p id={hintId} className="border-t border-ink-100 px-4 py-3 text-xs text-ink-500 sm:px-5">
          {hint} Not loading?{" "}
          <a href={PEDRO_VISUALIZER_URL} target="_blank" rel="noopener noreferrer" className={hintLink}>
            Open it in a new tab
          </a>
          .
        </p>
      </Card>
    </section>
  );
}
