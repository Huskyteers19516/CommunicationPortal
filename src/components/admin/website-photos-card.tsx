import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Avatar } from "@/components/ui/avatar";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { timeAgo } from "@/lib/dates";
import { WEBSITE_PHOTO_RECENT_DAYS, type WebsitePhotoHold } from "@/lib/user-photos";
import type { WebsitePhotoReview, WebsitePhotoReviewItem } from "@/server/queries/user-photos";

function holdLine(hold: WebsitePhotoHold): string {
  switch (hold.reason) {
    case "renamed":
      return `Changed their name${hold.from ? ` (was “${hold.from}”)` : ""}: check it, then allow it`;
    case "removed":
      return `Photo removed${hold.byName ? ` by ${hold.byName}` : ""}: a new one waits to be allowed`;
    case "kept-off":
      return `Kept off${hold.byName ? ` by ${hold.byName}` : ""}`;
  }
}

function Row({ item, detail }: { item: WebsitePhotoReviewItem; detail: string }) {
  const body = (
    <>
      <Avatar name={item.name} size="sm" photoId={item.photoId} />
      <span className="min-w-0 flex-1 leading-tight">
        <span className="block truncate text-sm font-medium text-ink-900">{item.name}</span>
        <span className="block text-xs text-ink-500">{detail}</span>
      </span>
    </>
  );
  return (
    <li>
      {item.canManage ? (
        <Link
          href={`/admin/users/${item.userId}`}
          className="-mx-2 flex min-h-11 items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-ink-50 focus-visible:outline-2 focus-visible:outline-brand-600"
        >
          {body}
          <ChevronRight className="size-4 shrink-0 text-ink-400" aria-hidden />
        </Link>
      ) : (
        <div className="flex min-h-11 items-center gap-2.5 py-1.5">{body}</div>
      )}
    </li>
  );
}

/**
 * Admin → Approvals → Members' photos (everyone with admin access; only when there's something to show): members'
 * photos go on the public team website on their own, so this lists who's held off it — a member who renamed
 * themselves waits until someone checks the new name and allows it on their page in People — and every photo that
 * went up in the last week, so a picture that shouldn't be public is caught. Names link to the person (for those the
 * viewer manages), where their Photo card has Remove, Keep off, and Allow.
 */
export function WebsitePhotosCard({ review, now, timeZone }: { review: WebsitePhotoReview; now: Date; timeZone: string }) {
  const waiting = review.held.filter((h) => h.hold?.reason === "renamed").length;
  return (
    <Card role="region" aria-label="Members' photos">
      <CardHeader
        title="Members' photos"
        description="They go on the public team website on their own. Check new ones; remove one or keep someone's off on their page in People."
        actions={waiting > 0 ? <Badge tone="yellow">{waiting} to check</Badge> : undefined}
      />
      <CardBody className="space-y-4">
        {!review.showPhotos && (
          <p className="text-sm text-ink-600">The website isn&apos;t showing members&apos; photos right now (Team website, below).</p>
        )}
        {review.held.length > 0 && (
          <section aria-label="Held off the website" className="space-y-1">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-500">Held off the website</h3>
            <ul>
              {review.held.map((item) => (
                <Row
                  key={item.userId}
                  item={item}
                  detail={item.hold ? `${holdLine(item.hold)} · ${timeAgo(new Date(item.hold.at), now, timeZone)}` : ""}
                />
              ))}
            </ul>
          </section>
        )}
        {review.recent.length > 0 && (
          <section aria-label="New on the website" className="space-y-1">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-500">
              New on the website (last {WEBSITE_PHOTO_RECENT_DAYS} days)
            </h3>
            <ul>
              {review.recent.map((item) => (
                <Row key={item.userId} item={item} detail={`Uploaded ${timeAgo(item.uploadedAt, now, timeZone)}`} />
              ))}
            </ul>
          </section>
        )}
      </CardBody>
    </Card>
  );
}
