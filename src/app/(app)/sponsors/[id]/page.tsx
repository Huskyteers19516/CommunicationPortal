import { Trash2 } from "lucide-react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";
import { NoSponsorshipAccess } from "@/components/sponsors/no-access";
import { StageBadge } from "@/components/sponsors/stage-badge";
import { SponsorshipForm } from "@/components/sponsors/sponsorship-form";
import { ActionForm } from "@/components/tasks/action-form";
import { BackLink } from "@/components/tasks/back-link";
import { PageHeader } from "@/components/ui/page-header";
import { timeAgo } from "@/lib/dates";
import { env } from "@/server/env";
import { getSponsorship, getSponsorshipOwnerOptions } from "@/server/queries/sponsorships";
import { getSponsorshipUser } from "../access";
import { deleteSponsorshipAction, updateSponsorshipAction } from "../actions";

// Shared by generateMetadata and the page so the sponsor loads once per request.
const loadSponsorship = cache(async (id: string) => {
  const actor = await getSponsorshipUser();
  return { actor, sponsorship: actor ? await getSponsorship(actor, id) : null };
});

export async function generateMetadata({ params }: PageProps<"/sponsors/[id]">): Promise<Metadata> {
  const { id } = await params;
  const { actor, sponsorship } = await loadSponsorship(id);
  return { title: sponsorship?.name ?? (actor ? "Sponsor" : "Sponsorships") };
}

/** A sponsor's page: the edit form, who added it and when it last changed, and Remove when allowed. */
export default async function SponsorshipPage({ params }: PageProps<"/sponsors/[id]">) {
  const { id } = await params;
  const { actor, sponsorship: s } = await loadSponsorship(id);
  if (!actor) return <NoSponsorshipAccess />;
  if (!s) notFound();
  const owners = await getSponsorshipOwnerOptions(actor);
  const now = new Date();
  const tz = env.teamTimezone;
  const listed = s.owner && [...owners.business, ...owners.staff].some((o) => o.id === s.owner!.id);
  const added = `Added ${timeAgo(s.createdAt, now, tz)}${s.createdByName ? ` by ${s.createdByName}` : ""}`;
  const updated = s.updatedAt.getTime() - s.createdAt.getTime() > 60_000 ? ` · Updated ${timeAgo(s.updatedAt, now, tz)}` : "";

  return (
    <div className="mx-auto w-full max-w-3xl min-w-0">
      <BackLink href="/sponsors">Sponsorships</BackLink>
      <PageHeader
        title={<span className="wrap-anywhere">{s.name}</span>}
        description={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <StageBadge stage={s.stage} />
            <span>
              {added}
              {updated}
            </span>
          </span>
        }
        actions={
          s.canDelete ? (
            <ActionForm
              action={deleteSponsorshipAction}
              fields={{ sponsorshipId: s.id }}
              variant="secondary"
              confirm={`Remove “${s.name}” from Sponsorships? This can't be undone.`}
              pendingText="Removing…"
              aria-label={`Remove ${s.name}`}
            >
              <Trash2 className="size-4" aria-hidden />
              Remove
            </ActionForm>
          ) : null
        }
      />
      <SponsorshipForm
        action={updateSponsorshipAction}
        owners={{ ...owners, current: s.owner && !listed ? s.owner : null }}
        submitLabel="Save changes"
        initial={{
          id: s.id,
          // Saving checks nobody changed it since this page loaded (e.g. its stage, from the list).
          version: s.updatedAt.toISOString(),
          name: s.name,
          website: s.website,
          contactName: s.contactName,
          contactEmail: s.contactEmail,
          asking: s.asking,
          amountReceived: s.amountReceived === null ? "" : String(s.amountReceived),
          stage: s.stage,
          ownerId: s.owner?.id ?? "",
          submittedOn: s.submittedOn ?? "",
          acceptedOn: s.acceptedOn ?? "",
          closesOn: s.closesOn ?? "",
          notes: s.notes,
        }}
      />
    </div>
  );
}
