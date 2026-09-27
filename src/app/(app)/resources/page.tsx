import { BookMarked, Plus } from "lucide-react";
import type { Metadata } from "next";
import { ResourceCard } from "@/components/resources/resource-card";
import { ResourceReviewQueue } from "@/components/resources/resource-review-queue";
import { MyResourceItem, PendingResourceItem } from "@/components/resources/submission-items";
import { ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { requireActiveUser } from "@/server/auth/session";
import { env } from "@/server/env";
import { listResources } from "@/server/queries/resources";
import { deleteResourceAction, reviewResourceAction } from "./actions";

export const metadata: Metadata = { title: "Resources" };

const sectionHeading = "font-display text-lg font-semibold uppercase tracking-wide text-ink-800";

export default async function ResourcesPage() {
  const actor = await requireActiveUser();
  const { groups, canManage, canReview, total, pending, mine } = await listResources(actor);
  const now = new Date();
  const addButton = (
    <ButtonLink href="/resources/new">
      <Plus className="size-4" aria-hidden />
      {canManage ? "Add resource" : "Share a resource"}
    </ButtonLink>
  );

  return (
    <>
      <PageHeader title="Resources" description="Team docs, code, tools, and links in one place." actions={addButton} />
      <div className="space-y-8">
        {/* Mounted for every reviewer (renders nothing when the queue is empty) so its confirmation survives the refresh. */}
        {canReview && (
          <ResourceReviewQueue
            count={pending.length}
            itemIds={pending.map((i) => i.id)}
            action={reviewResourceAction}
            headingClassName={sectionHeading}
          >
            <ul className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              {pending.map((item) => (
                <PendingResourceItem key={item.id} item={item} now={now} timeZone={env.teamTimezone} />
              ))}
            </ul>
          </ResourceReviewQueue>
        )}

        {mine.length > 0 && (
          <section id="mine" aria-labelledby="mine-heading" className="scroll-mt-20">
            <h2 id="mine-heading" className={`${sectionHeading} mb-1`}>
              Your submissions
            </h2>
            <p className="mb-3 text-sm text-ink-500">
              Until they&apos;re approved, only you and the leaders or admins can see these.
            </p>
            <ul className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              {mine.map((item) => (
                <MyResourceItem key={item.id} item={item} deleteAction={deleteResourceAction} />
              ))}
            </ul>
          </section>
        )}

        {total === 0 ? (
          <Card>
            <EmptyState
              icon={BookMarked}
              title="No resources yet"
              description={
                canManage
                  ? "Add the team docs, code, CAD, inventory tracker, game manual…"
                  : "Share a doc, some code, or a useful link. A leader approves it first."
              }
              action={addButton}
            />
          </Card>
        ) : (
          groups.map((g, i) => (
            <section key={g.name} aria-labelledby={`resource-group-${i}`}>
              <h2 id={`resource-group-${i}`} className={`${sectionHeading} mb-3`}>
                {g.name}
              </h2>
              <ul className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                {g.items.map((item) => (
                  <ResourceCard key={item.id} item={item} canManage={canManage} />
                ))}
              </ul>
            </section>
          ))
        )}
      </div>
    </>
  );
}
