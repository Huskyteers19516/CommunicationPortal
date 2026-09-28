import { ExternalLink, Trash2 } from "lucide-react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { cache } from "react";
import { OrderForm } from "@/components/orders/order-form";
import { OrderStatusControl } from "@/components/orders/status-select";
import { ActionForm } from "@/components/tasks/action-form";
import { BackLink } from "@/components/tasks/back-link";
import { Avatar } from "@/components/ui/avatar";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { SUBTEAM_LABELS } from "@/lib/constants";
import { formatDateTime, timeAgo } from "@/lib/dates";
import { centsToInput, filterForStatus, formatCents, ordersHref } from "@/lib/orders";
import { requireActiveUser } from "@/server/auth/session";
import { env } from "@/server/env";
import { canManageOrders } from "@/server/permissions";
import { getOrder, getOrdererOptions, type OrderDetail } from "@/server/queries/orders";
import { deleteOrderAction, updateOrderAction } from "../actions";

// Shared by generateMetadata and the page so the item loads once per request.
const loadOrder = cache(async (id: string) => {
  const actor = await requireActiveUser();
  return { actor, item: await getOrder(actor, id) };
});

export async function generateMetadata({ params }: PageProps<"/orders/[id]">): Promise<Metadata> {
  const { id } = await params;
  const { item } = await loadOrder(id);
  return { title: item?.description ?? "Order list" };
}

/** Request time, read outside of render. */
function requestTime(): Date {
  return new Date();
}

/** What the viewer can do next with it, in a line. */
function nextStep(item: OrderDetail, manager: boolean, isOrderer: boolean): string | null {
  switch (item.status) {
    case "REQUESTED":
      if (item.statusOptions.includes("APPROVED")) return "Approve it when it's OK to buy.";
      return manager ? "You added it, so another leader approves it." : "Waiting for a leader to approve it.";
    case "APPROVED":
      return isOrderer ? "Approved! Go ahead and order it, then set it to Ordered." : null;
    case "ORDERED":
      return isOrderer ? "Set it to Done once it arrives." : null;
    default:
      return null;
  }
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium uppercase tracking-wide text-ink-500">{label}</dt>
      <dd className="mt-0.5 text-sm text-ink-800 wrap-anywhere">{children}</dd>
    </div>
  );
}

/** Read-only details, for people who can't change the item. */
function ItemDetails({ item }: { item: OrderDetail }) {
  const none = <span className="text-ink-500">—</span>;
  return (
    <Card>
      <CardHeader title="Details" />
      <CardBody>
        <dl className="grid gap-4 sm:grid-cols-2">
          <Detail label="Orderer">
            {item.orderer ? (
              <span className="flex min-w-0 items-center gap-2">
                <Avatar name={item.orderer.name} size="sm" />
                <span className="min-w-0">{item.orderer.name}</span>
              </span>
            ) : (
              "No one yet"
            )}
          </Detail>
          <Detail label="For">{item.subteam ? SUBTEAM_LABELS[item.subteam] : "Whole team"}</Detail>
          <Detail label="Link">
            {item.link ? (
              <a
                href={item.link}
                target="_blank"
                rel="noopener noreferrer nofollow"
                className="inline-flex min-h-10 max-w-full items-center gap-1.5 font-medium text-brand-700 underline underline-offset-2 hover:text-brand-800"
              >
                <span className="min-w-0 wrap-anywhere">{item.linkHost || "Product page"}</span>
                <ExternalLink className="size-3.5 shrink-0" aria-hidden />
              </a>
            ) : (
              none
            )}
          </Detail>
          <Detail label="Vendor">{item.vendor || none}</Detail>
          <Detail label="Quantity">{item.quantity === null ? none : item.quantity.toLocaleString("en-US")}</Detail>
          <Detail label="Cost">{item.costCents === null ? none : formatCents(item.costCents)}</Detail>
          <div className="sm:col-span-2">
            <Detail label="Notes">{item.notes ? <span className="whitespace-pre-line">{item.notes}</span> : none}</Detail>
          </div>
        </dl>
      </CardBody>
    </Card>
  );
}

/**
 * One item: its status (a menu for people who can change it) with who changed it last, then the edit form
 * (leaders: always; whoever added it or orders it: while it's Requested) or its details.
 */
export default async function OrderPage({ params }: PageProps<"/orders/[id]">) {
  const { id } = await params;
  const { actor, item } = await loadOrder(id);
  if (!item) notFound();
  const manager = canManageOrders(actor);
  const people = item.canEdit ? await getOrdererOptions(actor) : [];
  const now = requestTime();
  const tz = env.teamTimezone;
  const isOrderer = item.orderer?.id === actor.id;
  const listHref = ordersHref({ filter: filterForStatus(item.status) });
  const added = `Added ${timeAgo(new Date(item.createdAt), now, tz)}${item.createdBy ? ` by ${item.createdBy.name}` : ""}`;
  const step = nextStep(item, manager, isOrderer);
  const orderer = item.orderer;
  const ordererListed = !orderer || people.some((p) => p.id === orderer.id);

  return (
    <div className="mx-auto w-full min-w-0 max-w-3xl">
      <BackLink href={listHref}>Order list</BackLink>
      <PageHeader
        title={<span className="wrap-anywhere">{item.description}</span>}
        description={added}
        actions={
          item.canEdit ? (
            <ActionForm
              action={deleteOrderAction}
              fields={{ itemId: item.id }}
              variant="secondary"
              confirm={
                item.status === "REQUESTED"
                  ? `Remove “${item.description}” from the order list? This can't be undone.`
                  : `Remove “${item.description}” from the order list? This can't be undone. To keep a record of it, set it to N/A instead.`
              }
              pendingText="Removing…"
              aria-label={`Remove ${item.description}`}
            >
              <Trash2 className="size-4" aria-hidden />
              Remove
            </ActionForm>
          ) : null
        }
      />

      <div className="space-y-5">
        <Card>
          <CardHeader title="Status" />
          <CardBody className="space-y-2">
            <OrderStatusControl
              id={item.id}
              description={item.description}
              status={item.status}
              updatedAt={item.updatedAt}
              options={item.statusOptions}
              className="max-w-60"
            />
            <p className="text-sm text-ink-600 wrap-anywhere">
              {item.statusChangedAt ? (
                <span title={formatDateTime(new Date(item.statusChangedAt), tz)}>
                  Status changed by {item.statusChangedBy ?? "a former member"} · {timeAgo(new Date(item.statusChangedAt), now, tz)}
                </span>
              ) : (
                "No status changes yet."
              )}
            </p>
            {step && <p className="text-sm text-ink-500">{step}</p>}
          </CardBody>
        </Card>

        {item.canEdit ? (
          <OrderForm
            action={updateOrderAction}
            orderers={{
              people,
              current: orderer && !ordererListed ? orderer : null,
              fixedName: orderer ? `${orderer.name}${isOrderer ? " (you)" : ""}` : null,
            }}
            submitLabel="Save changes"
            cancelHref={listHref}
            initial={{
              id: item.id,
              description: item.description,
              notes: item.notes,
              link: item.link,
              vendor: item.vendor,
              quantity: item.quantity === null ? "" : String(item.quantity),
              cost: centsToInput(item.costCents),
              subteam: item.subteam ?? "",
              ordererId: orderer?.id ?? "",
              seen: item.updatedAt,
            }}
          />
        ) : (
          <ItemDetails item={item} />
        )}
      </div>
    </div>
  );
}
