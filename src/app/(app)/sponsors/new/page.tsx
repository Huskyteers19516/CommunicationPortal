import type { Metadata } from "next";
import { NoSponsorshipAccess } from "@/components/sponsors/no-access";
import { SponsorshipForm } from "@/components/sponsors/sponsorship-form";
import { BackLink } from "@/components/tasks/back-link";
import { PageHeader } from "@/components/ui/page-header";
import { getSponsorshipOwnerOptions } from "@/server/queries/sponsorships";
import { getSponsorshipUser } from "../access";
import { createSponsorshipAction } from "../actions";

export const metadata: Metadata = { title: "Add sponsor" };

export default async function NewSponsorshipPage() {
  const actor = await getSponsorshipUser();
  if (!actor) return <NoSponsorshipAccess />;
  const owners = await getSponsorshipOwnerOptions(actor);
  return (
    <div className="mx-auto w-full max-w-3xl min-w-0">
      <BackLink href="/sponsors">Sponsorships</BackLink>
      <PageHeader title="Add sponsor" description="A company, donor, or grant we're asking for support." />
      <SponsorshipForm
        action={createSponsorshipAction}
        owners={owners}
        submitLabel="Add sponsor"
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
        }}
      />
    </div>
  );
}
