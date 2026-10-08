import { LinkTabs } from "../ui/link-tabs";

/** Resources | Sales, at the top of both. */
export function ResourcesTabs({ active }: { active: "resources" | "sales" }) {
  return (
    <LinkTabs
      className="mb-6"
      tabs={[
        { href: "/resources", label: "Resources", active: active === "resources" },
        { href: "/resources/sales", label: "Sales", active: active === "sales" },
      ]}
    />
  );
}

export type SalesView = "register" | "orders" | "book" | "menu";

/** Register | Orders | Money book | Menu, under the Sales page header. */
export function SalesTabs({ active, openCount }: { active: SalesView; openCount: number }) {
  return (
    <LinkTabs
      className="mb-6"
      tabs={[
        { href: "/resources/sales", label: "Register", active: active === "register" },
        { href: "/resources/sales/orders", label: "Orders", active: active === "orders", count: openCount, tone: "alert" },
        { href: "/resources/sales/book", label: "Money book", active: active === "book" },
        { href: "/resources/sales/menu", label: "Menu", active: active === "menu" },
      ]}
    />
  );
}
