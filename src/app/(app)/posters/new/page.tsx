import type { Metadata } from "next";
import { PosterForm } from "@/components/posters/poster-form";
import { BackLink } from "@/components/tasks/back-link";
import { PageHeader } from "@/components/ui/page-header";
import { requireActiveUser } from "@/server/auth/session";
import { createPosterAction } from "../actions";

export const metadata: Metadata = { title: "Add a poster" };

/** Everyone can add posters; they go up right away. */
export default async function NewPosterPage() {
  await requireActiveUser();
  return (
    <>
      <BackLink href="/posters">Posters</BackLink>
      <PageHeader title="Add a poster" description="Pick a photo or PDF of it, or add a link. The whole team sees it right away." />
      <div className="max-w-2xl">
        <PosterForm
          action={createPosterAction}
          submitLabel="Add poster"
          cancelHref="/posters"
          initial={{ title: "", description: "", link: "", event: "", eventDate: "" }}
        />
      </div>
    </>
  );
}
