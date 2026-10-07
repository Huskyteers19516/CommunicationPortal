"use client";

// Admin → Website Coding: the team website in a browser-like frame (the "simulator") next to a panel listing the
// editable spots of the page shown. The website runs in edit mode inside the frame (`?hk-edit=1`) and talks to this
// page with postMessage (protocol: src/lib/public-site-content.ts; the website's side: SiteContent.astro there):
//   website → portal: "ready" (a page loaded, with its spots — may come again after its scripts finish), "select"
//   portal → website: "preview" (the full current content, so a save shows at once), "highlight" (scroll to a spot)
// Every message is checked: it must come from the website's origin (WEBSITE_EDITOR_URL) and from this frame's own
// window, and is sent only to that origin. Nothing from the website is ever shown as HTML.
import { ExternalLink, Monitor, RotateCw, Smartphone } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Select } from "@/components/ui/field";
import { cn } from "@/lib/cn";
import { parseSiteMessage, SITE_EDITOR_PAGES, type SiteSlot } from "@/lib/public-site-content";
import type { SiteContentEditRow, SiteContentEntry } from "@/server/queries/site-content";
import { buildPreviewMessage } from "./preview";
import { RecentChanges } from "./recent-changes";
import { SlotPanel } from "./slot-panel";

/** How long to wait for the website to say it's ready before explaining what might be wrong. */
const READY_TIMEOUT_MS = 8000;

interface ShownPage {
  path: string;
  title: string;
  slots: SiteSlot[];
}

export function WebsiteEditor({
  siteUrl,
  entries,
  edits,
  timeZone,
}: {
  /** WEBSITE_EDITOR_URL (no trailing "/"). */
  siteUrl: string;
  entries: SiteContentEntry[];
  edits: SiteContentEditRow[];
  timeZone: string;
}) {
  const siteOrigin = useMemo(() => new URL(siteUrl).origin, [siteUrl]);
  const siteHost = useMemo(() => new URL(siteUrl).host, [siteUrl]);
  /** The page the frame was pointed at (the menu, or a reload). Links clicked inside it don't change this. */
  const [framePath, setFramePath] = useState("/");
  const [frameLoad, setFrameLoad] = useState(0);
  const [shown, setShown] = useState<ShownPage | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [mobile, setMobile] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const readyRef = useRef(false);
  const entriesRef = useRef(entries);
  const panelRef = useRef<HTMLDivElement>(null);

  const send = useCallback(
    (message: object) => {
      try {
        iframeRef.current?.contentWindow?.postMessage(message, siteOrigin);
      } catch {
        // The frame is between pages: the next "ready" gets the content again.
      }
    },
    [siteOrigin],
  );

  const sendPreview = useCallback(() => {
    send(buildPreviewMessage(entriesRef.current, window.location.origin));
  }, [send]);

  // Saved values changed (a save here, Undo, or someone else's change on refresh): show them in the frame at once.
  useEffect(() => {
    entriesRef.current = entries;
    if (readyRef.current) sendPreview();
  }, [entries, sendPreview]);

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (event.origin !== siteOrigin) return;
      const frame = iframeRef.current?.contentWindow;
      if (!frame || event.source !== frame) return;
      const message = parseSiteMessage(event.data);
      if (!message) return;
      if (message.type === "ready") {
        // May arrive more than once per page (again once the page's interactive parts are up): replace, re-send.
        readyRef.current = true;
        setTimedOut(false);
        setShown({ path: message.path, title: message.title, slots: message.slots });
        sendPreview();
      } else {
        setSelectedKey(message.key);
        // On phones the panel is below the frame: bring the editor into view.
        if (window.matchMedia("(max-width: 1023px)").matches) panelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [siteOrigin, sendPreview]);

  // Each time the frame is pointed somewhere: explain if the website never answers.
  useEffect(() => {
    readyRef.current = false;
    const timer = window.setTimeout(() => {
      if (!readyRef.current) setTimedOut(true);
    }, READY_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [framePath, frameLoad]);

  function openPage(path: string) {
    setTimedOut(false);
    setShown(null);
    setSelectedKey(null);
    setFramePath(path);
    setFrameLoad((n) => n + 1);
  }

  function selectSlot(key: string) {
    setSelectedKey(key);
    send({ source: "hk-portal", type: "highlight", key });
  }

  const currentPath = shown?.path ?? framePath;
  const frameSrc = `${siteUrl}${framePath}?hk-edit=1`;
  const openUrl = `${siteUrl}${currentPath}`;
  const menuValue = SITE_EDITOR_PAGES.some((p) => p.path === currentPath) ? currentPath : "";

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_24rem]">
      <div className="min-w-0 space-y-4">
        <Card className="overflow-hidden">
          {/* A browser's toolbar: the page menu, the address, reload, and the width. */}
          <div className="flex flex-wrap items-center gap-2 border-b border-ink-200 bg-ink-50 px-3 py-2">
            <div className="hidden items-center gap-1.5 pr-1 sm:flex" aria-hidden>
              <span className="size-3 rounded-full bg-red-300" />
              <span className="size-3 rounded-full bg-amber-300" />
              <span className="size-3 rounded-full bg-emerald-300" />
            </div>
            <label htmlFor="site-page" className="sr-only">
              Page
            </label>
            <Select id="site-page" value={menuValue} onChange={(e) => e.target.value && openPage(e.target.value)} className="w-auto max-w-[12rem]">
              {menuValue === "" && <option value="">Other page</option>}
              {SITE_EDITOR_PAGES.map((p) => (
                <option key={p.path} value={p.path}>
                  {p.label}
                </option>
              ))}
            </Select>
            <div
              className="flex h-10 min-w-0 flex-1 basis-40 items-center rounded-lg border border-ink-200 bg-white px-3 text-sm text-ink-600"
              aria-label="Address of the page shown"
            >
              <span className="truncate">
                <span className="text-ink-400">{siteHost}</span>
                {currentPath}
              </span>
            </div>
            <Button variant="ghost" size="icon" onClick={() => openPage(currentPath)} aria-label="Reload the page">
              <RotateCw className="size-4" aria-hidden />
            </Button>
            <div className="flex rounded-lg border border-ink-200 bg-white p-0.5" role="group" aria-label="Width">
              <button
                type="button"
                onClick={() => setMobile(false)}
                aria-pressed={!mobile}
                className={cn("flex size-9 items-center justify-center rounded-md", !mobile ? "bg-brand-50 text-brand-700" : "text-ink-500 hover:bg-ink-50")}
                aria-label="Computer width"
              >
                <Monitor className="size-4" aria-hidden />
              </button>
              <button
                type="button"
                onClick={() => setMobile(true)}
                aria-pressed={mobile}
                className={cn("flex size-9 items-center justify-center rounded-md", mobile ? "bg-brand-50 text-brand-700" : "text-ink-500 hover:bg-ink-50")}
                aria-label="Phone width"
              >
                <Smartphone className="size-4" aria-hidden />
              </button>
            </div>
          </div>
          {timedOut && (
            <div className="border-b border-ink-200 p-3">
              <Alert tone="warning" title="The website isn't answering the editor">
                <p>
                  Either this version of the team website doesn&apos;t have editing support yet (it needs to be deployed with
                  Website Coding), or the editor is pointed at the wrong address ({siteUrl} — set by WEBSITE_EDITOR_URL).
                  You can still check the page itself:
                </p>
                <a
                  href={openUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-1 inline-flex min-h-10 items-center gap-1.5 font-medium underline underline-offset-2"
                >
                  Open the website <ExternalLink className="size-4" aria-hidden />
                </a>
              </Alert>
            </div>
          )}
          <div className="bg-ink-100 p-0 sm:p-3">
            <div className={cn("mx-auto overflow-hidden bg-white shadow-sm transition-[width]", mobile ? "w-[390px] max-w-full sm:rounded-2xl sm:border-8 sm:border-ink-800" : "w-full")}>
              <iframe
                key={frameLoad}
                ref={iframeRef}
                src={frameSrc}
                title="The team website, in edit mode"
                className="block h-[70dvh] min-h-[28rem] w-full"
                // Its own origin (needed for its scripts and its requests to this portal), no way to navigate this page.
                sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
              />
            </div>
          </div>
        </Card>
        <p className="text-sm text-ink-500">
          Click any outlined text, link, or picture in the website above to change it. Alt/Option-click follows a link instead.{" "}
          <a href={openUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-medium text-brand-700 underline-offset-2 hover:underline">
            Open this page on the website <ExternalLink className="size-3.5" aria-hidden />
          </a>
        </p>
        <RecentChanges edits={edits} timeZone={timeZone} />
      </div>

      <div ref={panelRef} className="min-w-0 scroll-mt-20">
        <SlotPanel
          page={shown}
          entries={entries}
          selectedKey={selectedKey}
          onSelect={selectSlot}
          siteUrl={siteUrl}
        />
      </div>
    </div>
  );
}
