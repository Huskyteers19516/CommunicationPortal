// The editor's "preview" message for the website frame: the full current content, built from the saved values the
// page passed (src/server/queries/site-content.ts). Pictures go as absolute addresses on this portal (the public
// route serves them as soon as a spot shows them) — never blob: or data: URLs, which the website refuses.
import { publicSiteImagePath, type PublicSiteImage, type SitePreviewMessage } from "@/lib/public-site-content";
import type { SiteContentEntry } from "@/server/queries/site-content";

export function buildPreviewMessage(entries: readonly SiteContentEntry[], portalOrigin: string): SitePreviewMessage {
  const message: SitePreviewMessage = { source: "hk-portal", type: "preview", texts: {}, links: {}, images: {} };
  for (const e of entries) {
    if (e.kind === "text") message.texts[e.key] = e.value;
    else if (e.kind === "link") message.links[e.key] = e.value;
    else if (e.image) {
      const image: PublicSiteImage = { src: `${portalOrigin}${publicSiteImagePath(e.image.id)}`, alt: e.image.alt };
      if (e.image.width && e.image.height) {
        image.width = e.image.width;
        image.height = e.image.height;
      }
      message.images[e.key] = image;
    }
  }
  return message;
}

/** The address a signed-in admin sees any Website Coding picture at (also earlier ones, kept for Undo). */
export function adminSiteImageUrl(id: string): string {
  return `/admin/website/images/${encodeURIComponent(id)}`;
}
