import { UtensilsCrossed } from "lucide-react";
import type { Metadata } from "next";
import { AddMenuItemForm, CategoryOptions, MenuItemRow } from "@/components/sales/menu-forms";
import { SalesHeader } from "@/components/sales/sales-header";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { formatCents } from "@/lib/orders";
import { saleCategoryLabel } from "@/lib/sales";
import { requireActiveUser } from "@/server/auth/session";
import { canManageSales } from "@/server/permissions";
import { listSaleItems } from "@/server/queries/sales";

export const metadata: Metadata = { title: "Menu · Sales" };

export default async function SalesMenuPage() {
  const actor = await requireActiveUser();
  const canManage = canManageSales(actor);
  const items = await listSaleItems({ includeHidden: canManage });
  const categories = [...new Set(items.map((i) => i.category).filter(Boolean))].sort();

  return (
    <>
      <SalesHeader active="menu" />
      <div className="space-y-6">
        {canManage && (
          <Card>
            <CardHeader title="Add to the menu" description="Prices are what the register charges. Group buttons with a category." />
            <CardBody>
              <CategoryOptions categories={categories} />
              <AddMenuItemForm />
            </CardBody>
          </Card>
        )}
        <Card>
          <CardHeader
            title={`Menu (${items.length})`}
            description={canManage ? "Tap an item to change its price, hide it when it sells out, or remove it." : "Only the Business team and leaders change the menu."}
          />
          <CardBody className="py-1">
            {items.length === 0 ? (
              <EmptyState icon={UtensilsCrossed} title="Nothing on the menu yet" />
            ) : canManage ? (
              <ul className="divide-y divide-ink-100">
                {items.map((i) => (
                  <MenuItemRow key={i.id} item={i} />
                ))}
              </ul>
            ) : (
              <ul className="divide-y divide-ink-100">
                {items.map((i) => (
                  <li key={i.id} className="flex items-center justify-between gap-3 py-3">
                    <span>
                      <span className="font-medium text-ink-900">{i.name}</span>
                      <span className="ml-2 text-xs text-ink-500">{saleCategoryLabel(i.category)}</span>
                    </span>
                    <span className="tabular-nums text-ink-800">{formatCents(i.priceCents)}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      </div>
    </>
  );
}
