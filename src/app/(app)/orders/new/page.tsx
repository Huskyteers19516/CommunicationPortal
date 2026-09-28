import type { Metadata } from "next";
import { OrderForm } from "@/components/orders/order-form";
import { BackLink } from "@/components/tasks/back-link";
import { PageHeader } from "@/components/ui/page-header";
import { requireActiveUser } from "@/server/auth/session";
import { canAddPurchaseWithStatus, canManageOrders } from "@/server/permissions";
import { getOrdererOptions } from "@/server/queries/orders";
import { createOrderAction } from "../actions";

export const metadata: Metadata = { title: "Add item" };

/**
 * Anyone on the team adds what they need (they're its orderer). Leaders can also pick who orders it, and
 * all-scope staff can add something that's already approved or bought.
 */
export default async function NewOrderPage() {
  const actor = await requireActiveUser();
  const canPickStatus = canAddPurchaseWithStatus(actor);
  const people = await getOrdererOptions(actor);
  const description = canPickStatus
    ? "Add something the team needs to buy."
    : canManageOrders(actor)
      ? "Another leader approves it, then it can be ordered."
      : "A leader approves it, then you can order it.";
  return (
    // Centered like the item's page, so the form doesn't move between Add and Edit.
    <div className="mx-auto w-full min-w-0 max-w-3xl">
      <BackLink href="/orders">Order list</BackLink>
      <PageHeader title="Add item" description={description} />
      <OrderForm
        action={createOrderAction}
        orderers={{ people, fixedName: `${actor.name} (you)` }}
        canPickStatus={canPickStatus}
        submitLabel="Add to the list"
        initial={{
          description: "",
          notes: "",
          link: "",
          vendor: "",
          quantity: "",
          cost: "",
          subteam: actor.subteam ?? "",
          ordererId: actor.id,
          status: "REQUESTED",
        }}
      />
    </div>
  );
}
