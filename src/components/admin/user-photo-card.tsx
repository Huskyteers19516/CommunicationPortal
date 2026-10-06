"use client";

import { Globe, ShieldOff, Trash2 } from "lucide-react";
import { useActionState } from "react";
import { allowWebsitePhotoAction, keepPhotoOffWebsiteAction, removeUserPhotoAction } from "@/app/(app)/admin/actions";
import { AvatarPhoto } from "@/components/ui/avatar-photo";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { FormMessage } from "@/components/ui/form-message";
import { SubmitButton } from "@/components/ui/submit-button";
import { initialActionState } from "@/lib/action-state";
import { formatDateTime } from "@/lib/dates";
import type { WebsitePhotoHold } from "@/lib/user-photos";

/** What the card says about a hold (to someone who manages the account). */
function holdSentence(hold: WebsitePhotoHold, name: string, timeZone: string): string {
  const when = formatDateTime(new Date(hold.at), timeZone);
  switch (hold.reason) {
    case "renamed":
      return `${name} changed their name${hold.from ? ` from “${hold.from}”` : ""} (${when}). The website finds photos by name, so theirs stays off it until someone checks the new name is really theirs and allows it.`;
    case "removed":
      return `${hold.byName ?? "Someone who manages their account"} removed their photo (${when}), so a new one stays off the team website until someone allows it.`;
    case "kept-off":
      return `${hold.byName ?? "Someone who manages their account"} is keeping their photo off the team website (since ${when}), whatever their own switch says.`;
  }
}

/**
 * Admin → People → a person: their own photo (Settings → My photo) and where it shows, with Remove for people who
 * manage their account — it goes on the public team website on its own, so someone has to be able to take it down (a
 * new one then waits for "Allow on the team website") — and "Keep off the team website" (e.g. no photo release) /
 * "Allow on the team website" (after a removal, or checking a new name: renaming yourself holds your photo). Never on
 * your own photo unless you're an owner (`website.canChange`).
 */
export function UserPhotoCard({
  userId,
  name,
  photo,
  website,
  timeZone,
}: {
  userId: string;
  name: string;
  /** Null: no photo (or just removed — the card stays, so it can say so). */
  photo: { src: string; showPhotoInPortal: boolean; showPhotoOnWebsite: boolean } | null;
  /** Whether it's held off the website, and whether this viewer may change that. */
  website: { hold: WebsitePhotoHold | null; canChange: boolean } | null;
  timeZone: string;
}) {
  const [removeState, removeAction] = useActionState(removeUserPhotoAction, initialActionState);
  const [holdState, holdAction] = useActionState(keepPhotoOffWebsiteAction, initialActionState);
  const [allowState, allowAction] = useActionState(allowWebsitePhotoAction, initialActionState);
  const hold = website?.hold ?? null;
  const onWebsite = !!photo?.showPhotoOnWebsite && !hold;
  const where = photo ? [photo.showPhotoInPortal ? "in the portal" : null, onWebsite ? "on the team website (public)" : null].filter(Boolean) : [];
  const latest = [removeState, holdState, allowState].filter((s) => s !== null).sort((a, b) => (b?.nonce ?? 0) - (a?.nonce ?? 0))[0] ?? null;

  return (
    <Card role="region" aria-label="Photo">
      <CardHeader title="Photo" description="Their own photo, from their Settings." />
      <CardBody className="space-y-3">
        {photo ? (
          <div className="flex items-center gap-3">
            <span className="relative size-16 shrink-0 overflow-hidden rounded-full bg-ink-100">
              <AvatarPhoto key={photo.src} src={photo.src} alt={`${name}'s photo`} lazy={false} className="size-full object-cover" />
            </span>
            <p className="text-sm text-ink-600">
              {where.length > 0 ? `Shown ${where.join(" and ")}.` : "They don't show it anywhere right now."}
              {photo.showPhotoOnWebsite && hold && " Their switch for the team website is on, but it's held off (below)."}
            </p>
          </div>
        ) : (
          <p className="text-sm text-ink-600">No photo: their initials show instead.</p>
        )}
        {photo && (
          <form action={removeAction}>
            <input type="hidden" name="userId" value={userId} />
            <SubmitButton
              variant="secondary"
              pendingText="Removing…"
              confirm={`Remove ${name}'s photo? It comes off the portal and the team website, and a new one they upload stays off the website until someone who manages their account allows it.`}
              className="w-full sm:w-auto"
            >
              <Trash2 className="size-4" aria-hidden />
              Remove photo
            </SubmitButton>
          </form>
        )}
        {website && (
          <div className="space-y-2 border-t border-ink-100 pt-3">
            <p className="text-sm text-ink-700">
              {hold
                ? holdSentence(hold, name, timeZone)
                : "Their photo goes on the public team website on its own while their switch is on. Keep it off if they shouldn't be shown there (for example, no photo release); their own switch can't put it back."}
            </p>
            {website.canChange ? (
              hold ? (
                <form action={allowAction}>
                  <input type="hidden" name="userId" value={userId} />
                  <SubmitButton variant="secondary" pendingText="Allowing…" className="w-full sm:w-auto">
                    <Globe className="size-4" aria-hidden />
                    Allow on the team website
                  </SubmitButton>
                </form>
              ) : (
                <form action={holdAction}>
                  <input type="hidden" name="userId" value={userId} />
                  <SubmitButton variant="secondary" pendingText="Saving…" className="w-full sm:w-auto">
                    <ShieldOff className="size-4" aria-hidden />
                    Keep off the team website
                  </SubmitButton>
                </form>
              )
            ) : (
              <p className="text-xs text-ink-500">This is your own photo: someone else who manages accounts decides this.</p>
            )}
          </div>
        )}
        <FormMessage state={latest} />
      </CardBody>
    </Card>
  );
}
