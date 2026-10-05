import { Paperclip } from "lucide-react";
import type { Metadata } from "next";
import { NoSponsorshipAccess } from "@/components/sponsors/no-access";
import { SponsorshipForm } from "@/components/sponsors/sponsorship-form";
import { BackLink } from "@/components/tasks/back-link";
import { PageHeader } from "@/components/ui/page-header";
import { publicSponsorsShown } from "@/server/queries/public-sponsors";
import { getSponsorshipOwnerOptions } from "@/server/queries/sponsorships";
import { getSponsorshipUser } from "../access";
import { createSponsorshipAction } from "../actions";

export const metadata: Metadata = { title: "Add sponsor" };

export default async function NewSponsorshipPage() {
  const actor = await getSponsorshipUser();
  if (!actor) return <NoSponsorshipAccess />;
  const [owners, onWebsite] = await Promise.all([getSponsorshipOwnerOptions(actor), publicSponsorsShown()]);
  return (
    <div className="mx-auto w-full max-w-3xl min-w-0">
      <BackLink href="/sponsors">Sponsorships</BackLink>
      <PageHeader title="Add sponsor" description="A company, donor, or grant we're asking for support." />
      <p className="-mt-3 mb-5 flex gap-1.5 text-sm text-ink-500">
        <Paperclip className="mt-0.5 size-4 shrink-0" aria-hidden />
        <span className="min-w-0">To attach forms and files (or their logo for the team website), open the sponsor after you add it.</span>
      </p>
      <SponsorshipForm
        action={createSponsorshipAction}
        owners={owners}
        submitLabel="Add sponsor"
        websiteOff={!onWebsite}
        initial={{
          name: "",
          website: "",
          contactName: "",
          contactEmail: "",
          asking: "",
          amountReceived: "",
          stage: "NOT_STARTED",
          // Most people add the asks they're handling themselves.
          ownerId: [...owners.business, ...owners.staff].some((o) => o.id === actor.id) ? actor.id : "",
          submittedOn: "",
          acceptedOn: "",
          closesOn: "",
          notes: "",
          showOnWebsite: true,
          publicName: "",
        }}
      />
    </div>
  );
}
