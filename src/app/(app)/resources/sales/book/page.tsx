import { Download, NotebookPen } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { SalesActionButton } from "@/components/sales/action-button";
import { LedgerEntryForm } from "@/components/sales/ledger-form";
import { SalesHeader } from "@/components/sales/sales-header";
import { AutoSubmitSelect } from "@/components/ui/auto-submit-select";
import { Badge } from "@/components/ui/badge";
import { Button, ButtonLink } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { StatCard } from "@/components/ui/stat-card";
import { cn } from "@/lib/cn";
import { formatDateOnly, todayInTimezone } from "@/lib/dates";
import { formatCents } from "@/lib/orders";
import {
  LEDGER_KIND_LABELS,
  parseSalesEvent,
  parseSalesPeriod,
  SALE_PAYMENT_LABELS,
  SALES_PERIOD_LABELS,
  SALES_PERIODS,
  signedCents,
} from "@/lib/sales";
import { requireActiveUser } from "@/server/auth/session";
import { env } from "@/server/env";
import { getMoneyBook, MONEY_BOOK_LIST_LIMIT } from "@/server/queries/sales";
import { deleteLedgerEntryAction } from "../actions";

export const metadata: Metadata = { title: "Money book · Sales" };

export default async function MoneyBookPage({ searchParams }: PageProps<"/resources/sales/book">) {
  const actor = await requireActiveUser();
  const sp = await searchParams;
  const q = { period: parseSalesPeriod(sp.period), event: parseSalesEvent(sp.event) };
  const today = todayInTimezone(env.teamTimezone);
  const book = await getMoneyBook(actor, q, today);
  const { totals } = book;

  const href = (over: Partial<typeof q>) => {
    const params = new URLSearchParams();
    const next = { ...q, ...over };
    if (next.period !== "today") params.set("period", next.period);
    if (next.event) params.set("event", next.event);
    const s = params.toString();
    return `/resources/sales/book${s ? `?${s}` : ""}`;
  };
  const exportParams = new URLSearchParams({ period: q.period, ...(q.event ? { event: q.event } : {}) });

  return (
    <>
      <SalesHeader
        active="book"
        actions={
          <ButtonLink href={`/resources/sales/export?${exportParams}`} variant="secondary" prefetch={false}>
            <Download className="size-4" aria-hidden />
            Export to spreadsheet
          </ButtonLink>
        }
      />

      <div className="space-y-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <nav aria-label="Period" className="flex flex-wrap gap-1.5">
            {SALES_PERIODS.map((p) => (
              <Link
                key={p}
                href={href({ period: p })}
                aria-current={q.period === p ? "page" : undefined}
                className={cn(
                  "inline-flex h-9 items-center rounded-full border px-3 text-sm font-medium",
                  q.period === p ? "border-brand-500 bg-brand-50 text-brand-800" : "border-ink-200 bg-white text-ink-600 hover:border-ink-300",
                )}
              >
                {SALES_PERIOD_LABELS[p]}
              </Link>
            ))}
          </nav>
          {book.events.length > 0 && (
            <form method="get" className="flex items-center gap-2">
              {q.period !== "today" && <input type="hidden" name="period" value={q.period} />}
              <label htmlFor="book-event" className="sr-only">
                Fundraiser
              </label>
              <AutoSubmitSelect id="book-event" name="event" defaultValue={q.event ?? ""} className="w-56">
                <option value="">Every fundraiser</option>
                <option value="none">Not tied to a fundraiser</option>
                {book.events.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
              </AutoSubmitSelect>
              <noscript>
                <Button type="submit" variant="secondary" size="sm">
                  Show
                </Button>
              </noscript>
            </form>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard label="Sales" value={formatCents(totals.salesCents)} hint={`${totals.salesCount.toLocaleString("en-US")} order${totals.salesCount === 1 ? "" : "s"}`} />
          <StatCard label="Other money in" value={formatCents(totals.incomeCents)} />
          <StatCard label="Money out" value={formatCents(totals.expenseCents)} />
          <StatCard label="Net" value={signedCents(totals.netCents)} tone={totals.netCents < 0 ? "attention" : "default"} />
        </div>

        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader title="Sales by payment" description="What should be in the cash box, and what came in online." />
            <CardBody>
              {book.payments.length === 0 ? (
                <p className="text-sm text-ink-500">No sales in this period.</p>
              ) : (
                <ul className="divide-y divide-ink-100">
                  {book.payments.map((p) => (
                    <li key={p.payment} className="flex justify-between py-2 text-sm">
                      <span className="text-ink-700">{SALE_PAYMENT_LABELS[p.payment]}</span>
                      <span className="font-medium tabular-nums text-ink-900">{formatCents(p.cents)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="What sold" description="Best sellers first." />
            <CardBody>
              {book.items.length === 0 ? (
                <p className="text-sm text-ink-500">No sales in this period.</p>
              ) : (
                <ul className="max-h-72 divide-y divide-ink-100 overflow-y-auto">
                  {book.items.map((i) => (
                    <li key={i.name} className="flex justify-between gap-3 py-2 text-sm">
                      <span className="min-w-0 truncate text-ink-700">
                        <span className="font-semibold tabular-nums">{i.quantity.toLocaleString("en-US")}×</span> {i.name}
                      </span>
                      <span className="font-medium tabular-nums text-ink-900">{formatCents(i.cents)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>
        </div>

        {book.canManage && (
          <Card>
            <CardHeader title="Add money in or out" description="Supplies you bought, a cash donation, a table fee… Register sales are added on their own." />
            <CardBody>
              <LedgerEntryForm today={today} events={book.events} />
            </CardBody>
          </Card>
        )}

        <Card>
          <CardHeader
            title="Entries"
            description={book.rows.length >= MONEY_BOOK_LIST_LIMIT ? `The latest ${MONEY_BOOK_LIST_LIMIT}. Export to see them all.` : "Newest first. Voided orders are left out."}
          />
          {book.rows.length === 0 ? (
            <EmptyState icon={NotebookPen} title="Nothing in this period" description="Sales from the register and money in or out show up here." />
          ) : (
            <ul className="divide-y divide-ink-100">
              {book.rows.map((r) => (
                <li key={`${r.type}-${r.id}`} className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 px-4 py-3 sm:px-5">
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2 text-sm">
                      {r.type === "sale" ? (
                        <Badge tone="brand">Order #{r.number}</Badge>
                      ) : (
                        <Badge tone={r.kind === "EXPENSE" ? "red" : "blue"}>{LEDGER_KIND_LABELS[r.kind]}</Badge>
                      )}
                      <span className="min-w-0 text-ink-900">{r.description}</span>
                    </p>
                    <p className="mt-0.5 text-xs text-ink-500">
                      {formatDateOnly(r.date, today)}
                      {r.payment && ` · ${SALE_PAYMENT_LABELS[r.payment]}`}
                      {r.event && ` · ${r.event}`}
                      {r.by && ` · ${r.by}`}
                    </p>
                  </div>
                  <div className="flex items-start gap-2">
                    <span className={cn("text-sm font-semibold tabular-nums", r.amountCents < 0 ? "text-red-700" : "text-ink-900")}>
                      {signedCents(r.amountCents)}
                    </span>
                    {r.type === "entry" && book.canManage && (
                      <SalesActionButton
                        action={deleteLedgerEntryAction}
                        fields={{ entryId: r.id }}
                        variant="ghost"
                        confirm={`Remove “${r.description}” (${formatCents(Math.abs(r.amountCents))}) from the money book?`}
                      >
                        Remove
                      </SalesActionButton>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
