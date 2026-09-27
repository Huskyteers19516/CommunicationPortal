import { HandHeart } from "lucide-react";
import type { Metadata } from "next";
import { FundraiserForm } from "@/components/fundraising/fundraiser-form";
import { BackLink } from "@/components/tasks/back-link";
import { ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { todayInTimezone } from "@/lib/dates";
import { fundraiserDateBounds } from "@/lib/fundraising";
import { requireActiveUser } from "@/server/auth/session";
import { env } from "@/server/env";
import { canManageFundraisers } from "@/server/permissions";
import { getFundraiserLeadOptions } from "@/server/queries/fundraising";
import { createFundraiserAction } from "../actions";

export const metadata: Metadata = { title: "Add a fundraiser" };

/** The Business team and leaders add fundraisers; everyone else gets a short explanation. */
export default async function NewFundraiserPage() {
  const actor = await requireActiveUser();
  if (!canManageFundraisers(actor)) {
    return (
      <div className="mx-auto w-full max-w-3xl min-w-0">
        <BackLink href="/fundraising">Fundraising</BackLink>
        <PageHeader title="Add a fundraiser" />
        <Card>
          <EmptyState
            icon={HandHeart}
            title="The Business team adds fundraisers"
            description="Have an idea? Tell the Business team or a leader. You can sign up to help on any fundraiser."
            action={
              <ButtonLink href="/fundraising" variant="secondary">
                See fundraisers
              </ButtonLink>
            }
          />
        </Card>
      </div>
    );
  }

  const leadGroups = await getFundraiserLeadOptions();
  const bounds = fundraiserDateBounds(todayInTimezone(env.teamTimezone));
  return (
    <div className="mx-auto w-full max-w-3xl min-w-0">
      <BackLink href="/fundraising">Fundraising</BackLink>
      <PageHeader title="Add a fundraiser" description="The whole team sees it and can sign up to help." />
      <FundraiserForm
        action={createFundraiserAction}
        leadGroups={leadGroups}
        submitLabel="Add fundraiser"
        cancelHref="/fundraising"
        minDate={bounds.min}
        maxDate={bounds.max}
        initial={{
          name: "",
          kind: "EVENT",
          status: "PLANNING",
          description: "",
          location: "",
          link: "",
          startsOn: "",
          endsOn: "",
          goalAmount: "",
          raisedAmount: "",
          leadId: "",
          volunteerLimit: "",
        }}
      />
    </div>
  );
}
