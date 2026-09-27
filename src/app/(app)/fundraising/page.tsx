import { CalendarPlus, ChevronDown, HandHeart, Plus } from "lucide-react";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { FundraiserCard } from "@/components/fundraising/fundraiser-card";
import { FundraisingSummaryCard } from "@/components/fundraising/fundraising-summary";
import { FocusAlert } from "@/components/sponsors/focus-alert";
import { ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { LIMITS } from "@/lib/constants";
import { type DateOnly, todayInTimezone } from "@/lib/dates";
import { requireActiveUser } from "@/server/auth/session";
import { env } from "@/server/env";
import { type FundraiserItem, getFundraisingPage } from "@/server/queries/fundraising";

export const metadata: Metadata = { title: "Fundraising" };

function first(v: string | string[] | undefined) {
  return Array.isArray(v) ? v[0] : v;
}

function CardGrid({ items, today }: { items: FundraiserItem[]; today: DateOnly }) {
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      {items.map((f) => (
        <FundraiserCard key={f.id} fundraiser={f} today={today} />
      ))}
    </div>
  );
}

function Section({
  id,
  title,
  count,
  description,
  children,
}: {
  id: string;
  title: string;
  count: number;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="space-y-3">
      <div>
        <h2 id={id} className="text-lg font-semibold text-ink-900">
          {title} <span className="font-normal text-ink-500">({count})</span>
        </h2>
        {description && <p className="mt-0.5 text-sm text-ink-500">{description}</p>}
      </div>
      {children}
    </section>
  );
}

/** Everyone sees the team's progress and every fundraiser, and can sign up to help. */
export default async function FundraisingPage({ searchParams }: PageProps<"/fundraising">) {
  const actor = await requireActiveUser();
  const sp = await searchParams;
  const today = todayInTimezone(env.teamTimezone);
  const page = await getFundraisingPage(actor, { today });
  const { canManage, current, planning, datesPassed, done, cancelled } = page;
  const removed = first(sp.removed)?.slice(0, LIMITS.fundraiserNameMax);
  const nothingYet = current.length + planning.length + datesPassed.length + done.length + cancelled.length === 0;

  const addButton = (
    <ButtonLink href="/fundraising/new">
      <Plus className="size-4" aria-hidden />
      Add fundraiser
    </ButtonLink>
  );

  return (
    <>
      <PageHeader
        title="Fundraising"
        description="How the team is doing, and where you can help."
        actions={canManage ? addButton : undefined}
      />

      <div className="max-w-5xl space-y-8">
        {removed && (
          <FocusAlert tone="success">
            Removed <span className="wrap-anywhere">{removed}</span>.
          </FocusAlert>
        )}

        <FundraisingSummaryCard summary={page.summary} canManage={canManage} today={today} />

        {nothingYet ? (
          <Card>
            <EmptyState
              icon={HandHeart}
              title="No fundraisers yet"
              description={
                canManage
                  ? "Add the first one — a car wash, bake sale, or donation page. The whole team can sign up to help."
                  : "When the Business team plans one, it shows up here and you can sign up to help."
              }
              action={canManage ? addButton : undefined}
            />
          </Card>
        ) : (
          <>
            <Section id="fundraising-current" title="Happening now & upcoming" count={current.length}>
              {current.length > 0 ? (
                <CardGrid items={current} today={today} />
              ) : (
                <Card>
                  <EmptyState
                    icon={CalendarPlus}
                    title="Nothing coming up"
                    description={canManage ? "Set a fundraiser to Upcoming when it's ready for helpers." : "Check back soon."}
                  />
                </Card>
              )}
            </Section>

            {planning.length > 0 && (
              <Section id="fundraising-planning" title="Planning" count={planning.length}>
                <CardGrid items={planning} today={today} />
              </Section>
            )}

            {datesPassed.length > 0 && (
              <Section
                id="fundraising-dates-passed"
                title="Dates passed"
                count={datesPassed.length}
                description={
                  canManage
                    ? "Sign-ups are closed. Mark each one Done once the money is in, or change its dates."
                    : "Sign-ups are closed. The Business team will mark these done."
                }
              >
                <CardGrid items={datesPassed} today={today} />
              </Section>
            )}

            {done.length > 0 && (
              <Section id="fundraising-done" title="Done" count={page.doneTotal}>
                {page.doneTotal > done.length && <p className="text-sm text-ink-500">Showing the {done.length} most recent.</p>}
                <CardGrid items={done} today={today} />
              </Section>
            )}

            {cancelled.length > 0 && (
              <details className="group rounded-xl border border-ink-200 bg-white shadow-sm">
                <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 rounded-xl px-4 py-2 sm:px-5 [&::-webkit-details-marker]:hidden">
                  <h2 className="text-lg font-semibold text-ink-900">
                    Cancelled <span className="font-normal text-ink-500">({page.cancelledTotal})</span>
                  </h2>
                  <ChevronDown className="size-5 shrink-0 text-ink-500 transition-transform group-open:rotate-180" aria-hidden />
                </summary>
                <div className="border-t border-ink-100 p-3 sm:p-4">
                  {page.cancelledTotal > cancelled.length && (
                    <p className="mb-3 text-sm text-ink-500">Showing the {cancelled.length} most recent.</p>
                  )}
                  <CardGrid items={cancelled} today={today} />
                </div>
              </details>
            )}
          </>
        )}
      </div>
    </>
  );
}
