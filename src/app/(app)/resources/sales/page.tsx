import { Store } from "lucide-react";
import type { Metadata } from "next";
import { Register } from "@/components/sales/register";
import { SalesHeader } from "@/components/sales/sales-header";
import { ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { requireActiveUser } from "@/server/auth/session";
import { getRegister } from "@/server/queries/sales";

export const metadata: Metadata = { title: "Sales" };

export default async function SalesRegisterPage() {
  const actor = await requireActiveUser();
  const { items, events, defaultEventId, canManage } = await getRegister(actor);
  return (
    <>
      <SalesHeader active="register" />
      {items.length === 0 ? (
        <Card>
          <EmptyState
            icon={Store}
            title="Nothing on the menu yet"
            description={
              canManage
                ? "Add what you're selling (cookies, drinks, T-shirts…) and it shows up here as buttons."
                : "The Business team or a leader adds what's for sale on the Menu tab."
            }
            action={canManage ? <ButtonLink href="/resources/sales/menu">Set up the menu</ButtonLink> : undefined}
          />
        </Card>
      ) : (
        <Register items={items} events={events} defaultEventId={defaultEventId} />
      )}
    </>
  );
}
