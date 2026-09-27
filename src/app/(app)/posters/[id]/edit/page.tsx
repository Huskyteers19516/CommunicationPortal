import { Trash2 } from "lucide-react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PosterForm } from "@/components/posters/poster-form";
import { ActionForm } from "@/components/tasks/action-form";
import { BackLink } from "@/components/tasks/back-link";
import { PageHeader } from "@/components/ui/page-header";
import { requireActiveUser } from "@/server/auth/session";
import { getPosterForEdit } from "@/server/queries/posters";
import { deletePosterAction, updatePosterAction } from "../../actions";

export const metadata: Metadata = { title: "Edit poster" };

/** Whoever added the poster, and everyone with admin access. Everyone else: 404. */
export default async function EditPosterPage({ params }: PageProps<"/posters/[id]/edit">) {
  const actor = await requireActiveUser();
  const { id } = await params;
  const poster = await getPosterForEdit(actor, id);
  if (!poster) notFound();

  return (
    <>
      <BackLink href={`/posters/${poster.id}`}>
        {/* A fixed cap: the back link sizes to its text, so a long title would otherwise widen the page. */}
        <span className="max-w-56 truncate sm:max-w-lg">{poster.title}</span>
      </BackLink>
      <PageHeader
        title="Edit poster"
        description={<span className="wrap-anywhere">{poster.title}</span>}
        actions={
          <ActionForm
            action={deletePosterAction}
            fields={{ posterId: poster.id }}
            variant="secondary"
            confirm={`Remove “${poster.title}” from Posters?`}
            pendingText="Removing…"
            aria-label={`Remove ${poster.title}`}
          >
            <Trash2 className="size-4" aria-hidden />
            Remove
          </ActionForm>
        }
      />
      <div className="max-w-2xl">
        <PosterForm
          action={updatePosterAction}
          submitLabel="Save changes"
          cancelHref={`/posters/${poster.id}`}
          initial={{
            id: poster.id,
            title: poster.title,
            description: poster.description,
            link: poster.link,
            event: poster.event,
            eventDate: poster.eventDate ?? "",
            currentFile: poster.file
              ? { filename: poster.file.filename, size: poster.file.size, kind: poster.file.kind, viewHref: poster.file.viewHref }
              : null,
          }}
        />
      </div>
    </>
  );
}
