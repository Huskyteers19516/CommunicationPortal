import { Lock, Pin } from "lucide-react";
import type { DiscussionCategory } from "@/generated/prisma/enums";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { DISCUSSION_CATEGORY_LABELS } from "@/lib/constants";

const TONES: Record<DiscussionCategory, BadgeTone> = {
  GENERAL: "brand",
  SOFTWARE: "blue",
  BUILD: "yellow",
  BUSINESS: "purple",
  IDEAS: "green",
  OFF_TOPIC: "gray",
};

/** "General", "Software", "Off-topic"… (Software/Build/Business in their subteam colors). */
export function DiscussionCategoryBadge({ category }: { category: DiscussionCategory }) {
  return <Badge tone={TONES[category]}>{DISCUSSION_CATEGORY_LABELS[category]}</Badge>;
}

/** Listed first for everyone. */
export function DiscussionPinnedBadge() {
  return (
    <Badge tone="gray">
      <Pin className="size-3" aria-hidden />
      Pinned
    </Badge>
  );
}

/** No new replies (or changes) until it's unlocked. */
export function DiscussionLockedBadge() {
  return (
    <Badge tone="red">
      <Lock className="size-3" aria-hidden />
      Locked
    </Badge>
  );
}

/** What's new, in words: "New discussion", "1 new reply", "3 new replies". */
export function discussionUnreadText(isNew: boolean, newReplies: number): string {
  if (isNew || newReplies === 0) return "New discussion";
  return newReplies === 1 ? "1 new reply" : `${newReplies.toLocaleString("en-US")} new replies`;
}

/**
 * Something new for me: "New" (a whole discussion I haven't opened) or "3 new" (replies since I last opened it).
 * Solid, so it stands out from the category colors. Only for the eyes: screen readers get discussionUnreadText
 * as part of the discussion's link, so they hear it with the title.
 */
export function DiscussionUnreadMarker({ isNew, newReplies }: { isNew: boolean; newReplies: number }) {
  const label = isNew || newReplies === 0 ? "New" : `${newReplies > 99 ? "99+" : newReplies} new`;
  return (
    <span aria-hidden className="inline-flex items-center whitespace-nowrap rounded-full bg-brand-600 px-2 py-0.5 text-xs font-semibold text-white">
      {label}
    </span>
  );
}
