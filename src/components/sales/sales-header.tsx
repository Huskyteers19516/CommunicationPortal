import { prisma } from "@/server/db";
import { PageHeader } from "../ui/page-header";
import { ResourcesTabs, type SalesView, SalesTabs } from "./sales-tabs";

/** Resources | Sales tabs, the Sales title, and Register | Orders | Money book | Menu. */
export async function SalesHeader({ active, actions }: { active: SalesView; actions?: React.ReactNode }) {
  const openCount = await prisma.sale.count({ where: { status: "OPEN" } });
  return (
    <>
      <ResourcesTabs active="sales" />
      <PageHeader title="Sales" description="Ring up orders at bake sales and food stands, and keep the books." actions={actions} />
      <SalesTabs active={active} openCount={openCount} />
    </>
  );
}
