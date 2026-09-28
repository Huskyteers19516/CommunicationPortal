"use client";

import { Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from "react";
import { markAnnouncementsSeenAction } from "@/app/(app)/announcements/actions";
import { isNewAnnouncement } from "@/lib/announcements";

// "New" markers and seen tracking for /announcements.
// The Announcements layout reads when the person last opened the list (or when they joined) and holds it here for
// the whole visit — the layout stays mounted while they switch filters, pages, or post — so the "New" markers stay
// put after the list marks everything as seen (which refreshes the page and the menu badge).

const SeenSinceContext = createContext<string | null>(null);

/** Holds the first `since` it gets (ISO; null = unknown): later refreshes of the layout don't move it. */
export function AnnouncementsSeenProvider({ since, children }: { since: string | null; children: ReactNode }) {
  const [held] = useState(since);
  return <SeenSinceContext.Provider value={held}>{children}</SeenSinceContext.Provider>;
}

/**
 * "New" for an announcement posted since the person's previous visit that's for them (not their own) — the same
 * ones the menu badge and Today count. Renders nothing otherwise.
 */
export function NewMarker({ createdAt, mine, forYou }: { createdAt: string; mine: boolean; forYou: boolean }) {
  const since = useContext(SeenSinceContext);
  if (!isNewAnnouncement({ createdAt, mine, forYou }, since)) return null;
  return (
    <>
      {/* The colored edge on the card's left (the card is `relative`). */}
      <span className="absolute inset-y-0 left-0 w-1 rounded-l-xl bg-brand-500" aria-hidden />
      <span className="inline-flex items-center gap-1 rounded-full bg-brand-600 px-2 py-0.5 text-xs font-semibold text-white">
        <Sparkles className="size-3" aria-hidden />
        New
      </span>
    </>
  );
}

/**
 * Marks everything posted up to `upTo` (when the list was loaded) as seen, once, after the list is on screen —
 * so prefetching or rendering the page never does, and a tab opened in the background waits until it's looked at.
 * When that cleared something, the page refreshes (the menu badge and Today change). It's a plain refresh: it keeps
 * the scroll position and, unlike a refresh from the action itself, doesn't re-apply the address's #hash (which
 * kept the next page, e.g. Today, from opening at the top).
 */
export function MarkAnnouncementsSeen({ upTo }: { upTo: string }) {
  const router = useRouter();
  const first = useRef(upTo);
  const sent = useRef(false);
  useEffect(() => {
    const send = () => {
      if (sent.current || document.visibilityState !== "visible") return;
      sent.current = true;
      document.removeEventListener("visibilitychange", send);
      markAnnouncementsSeenAction(first.current).then(
        (cleared) => {
          if (cleared > 0) router.refresh();
        },
        () => {
          // Offline or signed out: the next visit tries again.
          sent.current = false;
        },
      );
    };
    send();
    if (!sent.current) document.addEventListener("visibilitychange", send);
    return () => document.removeEventListener("visibilitychange", send);
  }, [router]);
  return null;
}
