import { markSaleServedAction, reopenSaleAction, voidSaleAction } from "@/app/(app)/resources/sales/actions";
import { cn } from "@/lib/cn";
import { formatDateTime, timeAgo } from "@/lib/dates";
import { formatCents } from "@/lib/orders";
import { SALE_PAYMENT_LABELS, SALE_STATUS_LABELS } from "@/lib/sales";
import type { SaleSummary } from "@/server/queries/sales";
import { Badge } from "../ui/badge";
import { SalesActionButton } from "./action-button";

const statusTone = { OPEN: "yellow", SERVED: "green", VOIDED: "gray" } as const;

/** An order on the queue (big, with Served) or in the recent list (compact). */
export function OrderCard({ sale, now, timeZone }: { sale: SaleSummary; now: Date; timeZone: string }) {
  const open = sale.status === "OPEN";
  const voided = sale.status === "VOIDED";
  return (
    <li className={cn("rounded-xl border bg-white p-4 shadow-sm", open ? "border-amber-300" : "border-ink-200", voided && "opacity-70")}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2">
            <span className={cn("font-display font-semibold text-ink-900", open ? "text-2xl" : "text-lg", voided && "line-through")}>
              #{sale.number}
            </span>
            {sale.customer && <span className="font-semibold text-ink-800">{sale.customer}</span>}
            <Badge tone={statusTone[sale.status]}>{SALE_STATUS_LABELS[sale.status]}</Badge>
          </p>
          <p className="mt-0.5 text-xs text-ink-500" title={formatDateTime(sale.createdAt, timeZone)}>
            {timeAgo(sale.createdAt, now, timeZone)}
            {sale.soldBy && ` · by ${sale.soldBy}`} · {SALE_PAYMENT_LABELS[sale.payment]} · {formatCents(sale.totalCents)}
            {sale.event && ` · ${sale.event}`}
          </p>
        </div>
      </div>
      <ul className={cn("mt-2 space-y-0.5", open ? "text-base" : "text-sm")}>
        {sale.lines.map((l, i) => (
          <li key={i} className="text-ink-800">
            <span className="font-semibold tabular-nums">{l.quantity}×</span> {l.name}
          </li>
        ))}
      </ul>
      {sale.note && <p className="mt-2 rounded-md bg-amber-50 px-2 py-1 text-sm text-amber-900">Note: {sale.note}</p>}
      {!voided && (
        <div className="mt-3 flex flex-wrap items-start gap-2">
          {open ? (
            <SalesActionButton action={markSaleServedAction} fields={{ saleId: sale.id }} variant="primary" pendingText="Saving…">
              Served
            </SalesActionButton>
          ) : (
            <SalesActionButton action={reopenSaleAction} fields={{ saleId: sale.id }} variant="ghost">
              Back to queue
            </SalesActionButton>
          )}
          {sale.canVoid && (
            <SalesActionButton
              action={voidSaleAction}
              fields={{ saleId: sale.id }}
              variant="ghost"
              confirm={`Void order #${sale.number} (${formatCents(sale.totalCents)})? It stays on the record but leaves the totals. Give the money back separately.`}
            >
              Void
            </SalesActionButton>
          )}
        </div>
      )}
    </li>
  );
}
