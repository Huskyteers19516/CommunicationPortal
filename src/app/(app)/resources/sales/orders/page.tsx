import { ChefHat } from "lucide-react";
import type { Metadata } from "next";
import { AutoRefresh } from "@/components/sales/auto-refresh";
import { OrderCard } from "@/components/sales/order-card";
import { SalesHeader } from "@/components/sales/sales-header";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { requireActiveUser } from "@/server/auth/session";
import { env } from "@/server/env";
import { getOrderQueue } from "@/server/queries/sales";

export const metadata: Metadata = { title: "Orders · Sales" };

const sectionHeading = "font-display text-lg font-semibold uppercase tracking-wide text-ink-800";

export default async function SalesOrdersPage() {
  const actor = await requireActiveUser();
  const { open, recent } = await getOrderQueue(actor);
  const now = new Date();
  return (
    <>
      <AutoRefresh seconds={15} />
      <SalesHeader active="orders" />
      <div className="space-y-8">
        <section aria-labelledby="queue-heading">
          <h2 id="queue-heading" className={`${sectionHeading} mb-1`}>
            To make ({open.length})
          </h2>
          <p className="mb-3 text-sm text-ink-500">Oldest first. This page refreshes on its own.</p>
          {open.length === 0 ? (
            <Card>
              <EmptyState icon={ChefHat} title="All caught up" description="Orders rung up with “Needs making” show up here." />
            </Card>
          ) : (
            <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {open.map((s) => (
                <OrderCard key={s.id} sale={s} now={now} timeZone={env.teamTimezone} />
              ))}
            </ul>
          )}
        </section>

        {recent.length > 0 && (
          <section aria-labelledby="recent-heading">
            <h2 id="recent-heading" className={`${sectionHeading} mb-3`}>
              Recent orders
            </h2>
            <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {recent.map((s) => (
                <OrderCard key={s.id} sale={s} now={now} timeZone={env.teamTimezone} />
              ))}
            </ul>
          </section>
        )}
      </div>
    </>
  );
}
