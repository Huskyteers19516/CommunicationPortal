"use client";

import { ArrowDown } from "lucide-react";
import { createContext, type ReactNode, use, useEffect, useRef, useState } from "react";
import { markThreadReadAction } from "@/app/(app)/discussion/actions";

const NewFromContext = createContext<string | null>(null);

/**
 * Wraps a discussion's page (from its title down to the replies). Once the page is open and visible in the browser
 * it marks the discussion read (a Server Action after mount, so loading or prefetching the page never writes; a tab
 * opened in the background waits until it's looked at), up to the newest activity the page shows — again only when
 * a refresh shows newer activity.
 * The "New" divider's place is kept from the first render: the refresh after marking it read (or after posting a
 * reply) doesn't take it (or the "Jump to new replies" link) away while the page stays open.
 */
export function ThreadReadState({
  threadId,
  seen,
  newFromReplyId,
  children,
}: {
  threadId: string;
  /** The newest activity the page shows (ISO). */
  seen: string;
  /** The first new reply (from the server), or null. */
  newFromReplyId: string | null;
  children: ReactNode;
}) {
  const [newFrom] = useState(newFromReplyId);
  // What was last sent: once per discussion and activity shown (again only if a refresh shows newer activity).
  const sent = useRef<string | null>(null);
  useEffect(() => {
    const key = `${threadId} ${seen}`;
    if (sent.current === key) return;
    const send = () => {
      sent.current = key;
      // Best effort: if it fails, the discussion just stays unread.
      markThreadReadAction(threadId, seen).catch(() => {});
    };
    if (document.visibilityState === "visible") {
      send();
      return;
    }
    // Opened in a background tab: it isn't read until someone looks at it.
    const onChange = () => {
      if (document.visibilityState !== "visible") return;
      document.removeEventListener("visibilitychange", onChange);
      send();
    };
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, [threadId, seen]);
  return <NewFromContext value={newFrom}>{children}</NewFromContext>;
}

/** The first new reply gets the "New" divider above it. */
export function useIsFirstNewReply(replyId: string): boolean {
  return use(NewFromContext) === replyId;
}

/**
 * "Jump to new replies" under the title while the page has a "New" divider: a long first post and a few replies
 * can be screens away on a phone. It scrolls to the first new reply and moves focus there.
 */
export function JumpToNewReplies() {
  const newFrom = use(NewFromContext);
  if (!newFrom) return null;
  const target = `reply-${newFrom}`;
  return (
    <a
      href={`#${target}`}
      onClick={(e) => {
        const reply = document.getElementById(target);
        // Gone (deleted in the meantime): the link just goes to its place.
        if (!reply) return;
        e.preventDefault();
        reply.scrollIntoView({ block: "start" });
        reply.focus({ preventScroll: true });
      }}
      className="mt-1 inline-flex min-h-10 items-center gap-1.5 text-sm font-medium text-brand-700 hover:underline"
    >
      <ArrowDown className="size-4" aria-hidden />
      Jump to new replies
    </a>
  );
}

/** "── New ──" above the first reply written since I last opened the discussion. */
export function NewRepliesDivider() {
  return (
    <div role="separator" aria-label="New replies" className="mb-3 flex items-center gap-3 text-xs font-semibold uppercase tracking-wider text-brand-700">
      <span className="h-px flex-1 bg-brand-300" aria-hidden />
      <span aria-hidden>New</span>
      <span className="h-px flex-1 bg-brand-300" aria-hidden />
    </div>
  );
}
