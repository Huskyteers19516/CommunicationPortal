import { Trash2 } from "lucide-react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AnnouncementForm } from "@/components/announcements/announcement-form";
import { ActionForm } from "@/components/tasks/action-form";
import { BackLink } from "@/components/tasks/back-link";
import { PageHeader } from "@/components/ui/page-header";
import type { Subteam } from "@/generated/prisma/enums";
import { announcementFocusHref, audienceValue } from "@/lib/announcements";
import { SUBTEAMS } from "@/lib/constants";
import { requireActiveUser } from "@/server/auth/session";
import { announcementAudiences } from "@/server/permissions";
import { getAnnouncement } from "@/server/queries/announcements";
import { deleteAnnouncementAction, updateAnnouncementAction } from "../../actions";

export const metadata: Metadata = { title: "Edit announcement" };

/** Whoever posted it, and the captain, mentors, teachers, and owners. Everyone else gets a 404. */
export default async function EditAnnouncementPage({ params }: PageProps<"/announcements/[id]/edit">) {
  const actor = await requireActiveUser();
  const { id } = await params;
  const item = await getAnnouncement(actor, id);
  if (!item || !item.canEdit) notFound();

  // It can stay for whoever it's for (even if the person no longer posts for them) or move to anyone they post for.
  const allowed = announcementAudiences(actor);
  const audiences = ([null, ...SUBTEAMS] as (Subteam | null)[]).filter((a) => a === item.subteam || allowed.includes(a));
  // Back and Cancel return to this announcement on the list.
  const backHref = announcementFocusHref(item.id);
  const quoted = `“${item.title}”`;

  return (
    <>
      <BackLink href={backHref}>Announcements</BackLink>
      <PageHeader
        title="Edit announcement"
        description={
          <span className="wrap-anywhere">
            {item.mine ? "Your announcement" : `Posted by ${item.author?.name ?? "a former member"}`}. Changing the title or
            message marks it “edited”.
          </span>
        }
        actions={
          <ActionForm
            action={deleteAnnouncementAction}
            fields={{ announcementId: item.id, version: item.version, back: "" }}
            variant="secondary"
            confirm={`Remove ${quoted}? Nobody will see it anymore. This can't be undone.`}
            pendingText="Removing…"
            aria-label={`Remove ${quoted}`}
          >
            <Trash2 className="size-4 text-red-600" aria-hidden />
            Remove
          </ActionForm>
        }
      />
      <div className="max-w-3xl">
        <AnnouncementForm
          action={updateAnnouncementAction}
          audiences={audiences}
          submitLabel="Save changes"
          cancelHref={backHref}
          initial={{
            id: item.id,
            version: item.version,
            title: item.title,
            body: item.body,
            audience: audienceValue(item.subteam),
            pinned: item.pinned,
          }}
        />
      </div>
    </>
  );
}
