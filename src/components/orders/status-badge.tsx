import type { PurchaseStatus } from "@/generated/prisma/enums";
import { cn } from "@/lib/cn";
import { PURCHASE_STATUS_LABELS } from "@/lib/constants";

/**
 * Status colors, like the colored dropdown in the old Purchase List sheet: Requested amber (waiting on
 * someone), Approved sky, Ordered violet, Done green, N/A gray.
 */
export const PURCHASE_STATUS_STYLES: Record<PurchaseStatus, { badge: string; control: string }> = {
  REQUESTED: { badge: "bg-amber-50 text-amber-800 ring-amber-200", control: "border-amber-300 bg-amber-50 text-amber-900" },
  APPROVED: { badge: "bg-sky-50 text-sky-700 ring-sky-200", control: "border-sky-300 bg-sky-50 text-sky-900" },
  ORDERED: { badge: "bg-violet-50 text-violet-700 ring-violet-200", control: "border-violet-300 bg-violet-50 text-violet-900" },
  DONE: { badge: "bg-emerald-50 text-emerald-700 ring-emerald-200", control: "border-emerald-300 bg-emerald-50 text-emerald-900" },
  NOT_NEEDED: { badge: "bg-ink-100 text-ink-700 ring-ink-200", control: "border-ink-200 bg-ink-50 text-ink-800" },
};

export function OrderStatusBadge({ status, className }: { status: PurchaseStatus; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset",
        PURCHASE_STATUS_STYLES[status].badge,
        className,
      )}
    >
      {PURCHASE_STATUS_LABELS[status]}
    </span>
  );
}
