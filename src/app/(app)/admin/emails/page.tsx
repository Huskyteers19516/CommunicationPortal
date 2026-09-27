import { Mail } from "lucide-react";
import type { Metadata } from "next";
import { DiscordCard, type DiscordSetup } from "@/components/admin/discord-card";
import { EmailConfigCard } from "@/components/admin/email-config-card";
import { EmailLogList } from "@/components/admin/email-log-list";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { LinkTabs } from "@/components/ui/link-tabs";
import { PageHeader } from "@/components/ui/page-header";
import { Pagination } from "@/components/ui/pagination";
import type { EmailStatus } from "@/generated/prisma/enums";
import { requireOwnerUser } from "@/server/auth/session";
import { env } from "@/server/env";
import { discordWebhookUrl } from "@/server/notifications/discord";
import { getEmailConfigStatus, listEmailLogs, parseEmailLogFilters } from "@/server/queries/admin";

export const metadata: Metadata = { title: "Email log" };

const TABS: { status?: EmailStatus; label: string }[] = [
  { label: "All" },
  { status: "SENT", label: "Sent" },
  { status: "FAILED", label: "Failed" },
  { status: "SKIPPED", label: "Logged only" },
];

function hrefFor(status: EmailStatus | undefined, page = 1) {
  const sp = new URLSearchParams();
  if (status) sp.set("status", status);
  if (page > 1) sp.set("page", String(page));
  const qs = sp.toString();
  return qs ? `/admin/emails?${qs}` : "/admin/emails";
}

export default async function EmailLogPage({ searchParams }: PageProps<"/admin/emails">) {
  // Owners only: subjects reveal things (who was sent back, private question titles) other admins shouldn't see.
  const actor = await requireOwnerUser();
  const filters = parseEmailLogFilters(await searchParams);
  const config = getEmailConfigStatus(actor);
  const result = await listEmailLogs(actor, filters);
  const discordSetup: DiscordSetup = discordWebhookUrl() ? "connected" : process.env.DISCORD_WEBHOOK_URL?.trim() ? "invalid" : "none";

  return (
    <>
      <PageHeader
        eyebrow="Admin"
        title="Email log"
        description="Every email (and Discord post) the portal tried to send — handy when someone says “I never got it”."
      />
      <div className="space-y-6">
        <EmailConfigCard config={config} adminEmail={actor.email} />
        <DiscordCard setup={discordSetup} />

        <section aria-labelledby="log-heading" className="space-y-3">
          <h2 id="log-heading" className="text-base font-semibold text-ink-900">
            Recent emails
          </h2>
          <LinkTabs tabs={TABS.map((t) => ({ href: hrefFor(t.status), label: t.label, active: filters.status === t.status }))} />
          {result.logs.length === 0 ? (
            <Card>
              <EmptyState
                icon={Mail}
                title={filters.status ? "No emails with this status." : "No emails yet."}
                description={filters.status ? undefined : "Notifications and test emails will show up here."}
              />
            </Card>
          ) : (
            <EmailLogList logs={result.logs} timeZone={env.teamTimezone} />
          )}
          <Pagination page={result.page} pageCount={result.pageCount} hrefFor={(p) => hrefFor(filters.status, p)} />
        </section>
      </div>
    </>
  );
}
