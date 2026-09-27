import type { Metadata } from "next";
import { NoSponsorshipAccess } from "@/components/sponsors/no-access";
import { SponsorshipImportForm } from "@/components/sponsors/sponsorship-import-form";
import { BackLink } from "@/components/tasks/back-link";
import { PageHeader } from "@/components/ui/page-header";
import { todayInTimezone } from "@/lib/dates";
import { env } from "@/server/env";
import { getSponsorshipImportContext } from "@/server/queries/sponsorships";
import { getSponsorshipUser } from "../access";

export const metadata: Metadata = { title: "Import sponsors" };

export default async function ImportSponsorshipsPage() {
  const actor = await getSponsorshipUser();
  const context = actor ? await getSponsorshipImportContext(actor) : null;
  if (!context) return <NoSponsorshipAccess />;
  return (
    <div className="mx-auto w-full max-w-4xl min-w-0">
      <BackLink href="/sponsors">Sponsorships</BackLink>
      <PageHeader
        title="Import from a spreadsheet"
        description="Paste rows from your sponsorship sheet. You'll see what gets added before anything is saved."
      />
      <SponsorshipImportForm today={todayInTimezone(env.teamTimezone)} owners={context.owners} existing={context.existing} />
    </div>
  );
}
