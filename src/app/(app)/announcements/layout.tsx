import { AnnouncementsSeenProvider } from "@/components/announcements/seen";
import { requireActiveUser } from "@/server/auth/session";
import { getAnnouncementsSeenSince } from "@/server/queries/announcements";

/**
 * Remembers, for the whole visit to Announcements, when the person had last opened it (or when they joined): the
 * list marks everything as seen as soon as it's on screen, but its "New" markers go by this, so they stay while
 * the person switches filters or pages, posts, or edits. A layout stays mounted across those navigations (and
 * only reads here; the list's MarkAnnouncementsSeen writes, after it's shown).
 */
export default async function AnnouncementsLayout({ children }: LayoutProps<"/announcements">) {
  const actor = await requireActiveUser();
  const since = await getAnnouncementsSeenSince(actor);
  return <AnnouncementsSeenProvider since={since?.toISOString() ?? null}>{children}</AnnouncementsSeenProvider>;
}
