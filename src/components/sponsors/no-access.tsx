import { Lock } from "lucide-react";
import { ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";

/** What people outside the Business team (and not staff) see on a Sponsorships link: why, and a way back. No data. */
export function NoSponsorshipAccess() {
  return (
    <div className="mx-auto w-full max-w-xl min-w-0">
      <PageHeader title="Sponsorships" />
      <Card>
        <EmptyState
          icon={Lock}
          title="Sponsorships are for the Business team and leaders"
          description="If you'd like to help find sponsors, ask the Business leader."
          action={<ButtonLink href="/today">Back to Today</ButtonLink>}
        />
      </Card>
    </div>
  );
}
