import { ChevronRight, ClipboardCheck, ShoppingCart } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { plural } from "@/components/checklist/format";
import type { Actor } from "@/server/actor";
import { countOrdersToApprove, countOrdersToOrder } from "@/server/queries/orders";

const linkClasses =
  "flex min-h-12 items-center gap-3 rounded-xl border border-brand-200 bg-brand-50 px-4 py-3 text-sm font-medium text-brand-900 shadow-sm transition-colors hover:border-brand-300 hover:bg-brand-100";

function TodayLink({ href, icon, children }: { href: string; icon: ReactNode; children: ReactNode }) {
  return (
    <Link href={href} className={linkClasses}>
      {icon}
      <span className="flex-1">{children}</span>
      <ChevronRight className="size-4 shrink-0 text-brand-700" aria-hidden />
    </Link>
  );
}

/**
 * Who hears about requests waiting for approval on Today: the Business leader and the captain (not every leader
 * who could approve, to keep Today quiet).
 */
function watchesApprovals(actor: Actor): boolean {
  return actor.role === "BUSINESS_LEADER" || actor.role === "CAPTAIN";
}

/**
 * Today page shortcuts to the order list (there are no emails about it): requests the Business leader or the
 * captain can approve, and the approved items the viewer is ordering.
 */
export async function OrdersToOrderLink({ actor }: { actor: Actor }) {
  const [toApprove, toOrder] = await Promise.all([
    watchesApprovals(actor) ? countOrdersToApprove(actor) : Promise.resolve(0),
    countOrdersToOrder(actor),
  ]);
  return (
    <>
      {toApprove > 0 && (
        <TodayLink href="/orders" icon={<ClipboardCheck className="size-5 shrink-0 text-brand-600" aria-hidden />}>
          {plural(toApprove, "item")} to approve on the order list
        </TodayLink>
      )}
      {toOrder > 0 && (
        <TodayLink href="/orders?mine=1" icon={<ShoppingCart className="size-5 shrink-0 text-brand-600" aria-hidden />}>
          {plural(toOrder, "approved item")} for you to order
        </TodayLink>
      )}
    </>
  );
}
