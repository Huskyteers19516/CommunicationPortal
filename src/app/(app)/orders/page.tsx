import { FileSpreadsheet, Plus, SearchX, ShoppingCart } from "lucide-react";
import type { Metadata } from "next";
import { ActiveChipInView } from "@/components/orders/active-chip-in-view";
import { type OrderHighlight, OrderList } from "@/components/orders/order-list";
import { FocusAlert } from "@/components/sponsors/focus-alert";
import { FilterChips, ToggleChip } from "@/components/tasks/filter-chips";
import { Alert } from "@/components/ui/alert";
import { ButtonLink, buttonClasses } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { LinkTabs } from "@/components/ui/link-tabs";
import { PageHeader } from "@/components/ui/page-header";
import { SUBTEAMS } from "@/lib/constants";
import {
  ORDER_FILTER_KEYS,
  ORDER_FILTERS,
  type OrderFilter,
  type OrderFor,
  type OrderQuery,
  orderForLabel,
  orderSummaryText,
  ordersExportHref,
  ordersHref,
  parseOrderFilter,
  parseOrderFor,
} from "@/lib/orders";
import { requireActiveUser } from "@/server/auth/session";
import { env } from "@/server/env";
import { listOrders } from "@/server/queries/orders";

export const metadata: Metadata = { title: "Order list" };

function first(v: string | string[] | undefined) {
  return Array.isArray(v) ? v[0] : v;
}

/** What an empty filtered list means. */
function emptyText(q: OrderQuery): string {
  const who = q.for === "team" ? " for the whole team" : q.for ? ` for ${orderForLabel(q.for)}` : "";
  const texts: Record<OrderFilter, [all: string, mine: string]> = {
    open: [`Nothing to buy${who} right now.`, `Nothing of yours${who} is open right now.`],
    done: [`Nothing${who} is done yet.`, `None of yours${who} are done yet.`],
    na: [`Nothing${who} is marked N/A.`, `None of yours${who} are marked N/A.`],
    all: [`Nothing on the list${who} yet.`, `You haven't added or ordered anything${who} yet.`],
  };
  return texts[q.filter][q.mine ? 1 : 0];
}

/** After adding or saving ("?added=<id>" / "?saved=<id>"): that row is highlighted and focused, with a note. */
function highlightFor(sp: Record<string, string | string[] | undefined>, items: { id: string }[]): OrderHighlight | null {
  const added = first(sp.added);
  const id = added ?? first(sp.saved);
  if (!id || !items.some((i) => i.id === id)) return null;
  return { id, message: added ? "Added just now." : "Changes saved." };
}

/** Request time, read outside of render so dates line up between server and browser. */
function requestTime(): Date {
  return new Date();
}

export default async function OrdersPage({ searchParams }: PageProps<"/orders">) {
  const actor = await requireActiveUser();
  const sp = await searchParams;
  const q: OrderQuery = { filter: parseOrderFilter(sp.filter), for: parseOrderFor(sp.for), mine: first(sp.mine) === "1" };
  const now = requestTime();
  const list = await listOrders(actor, q);
  const { items, summary, counts } = list;
  const highlight = highlightFor(sp, items);
  // "?removed=1" only: the alert never repeats text from the link.
  const removed = first(sp.removed) === "1";
  // Added or saved, but cut off the list (over the limit): say so at the top instead.
  const flashFallback = !highlight && list.truncated ? (first(sp.added) ? "Item added." : first(sp.saved) ? "Changes saved." : null) : null;
  const filtered = q.filter !== "open" || !!q.for || !!q.mine;

  const addButton = (
    <ButtonLink href="/orders/new">
      <Plus className="size-4" aria-hidden />
      Add item
    </ButtonLink>
  );

  const forChips: { href: string; label: string; active: boolean }[] = [
    { href: ordersHref({ ...q, for: undefined }), label: "All", active: !q.for },
    ...[...SUBTEAMS, "team" as const].map((f: OrderFor) => ({ href: ordersHref({ ...q, for: f }), label: orderForLabel(f), active: q.for === f })),
  ];

  return (
    <>
      <PageHeader
        title="Order list"
        description="Everything the team needs to buy. Add what you need; a leader approves it before it's ordered."
        actions={
          <>
            {addButton}
            {/* A plain link (not client navigation): the browser downloads the file. */}
            <a href={ordersExportHref(q)} download className={buttonClasses("secondary")}>
              <FileSpreadsheet className="size-4" aria-hidden />
              Export to spreadsheet
            </a>
          </>
        }
      />

      <div className="space-y-4">
        {removed && <FocusAlert tone="success">Item removed.</FocusAlert>}
        {flashFallback && <FocusAlert tone="success">{flashFallback}</FocusAlert>}

        <LinkTabs
          tabs={ORDER_FILTER_KEYS.map((key) => ({
            href: ordersHref({ ...q, filter: key }),
            label: ORDER_FILTERS[key].label,
            active: q.filter === key,
            count: counts[key],
          }))}
        />

        {/* "Mine" right after the For chips (not pushed to the far edge); tops aligned (the chip row has room for a scrollbar below). */}
        <div className="space-y-2 md:flex md:items-start md:gap-2 md:space-y-0">
          <ActiveChipInView active={q.for ?? "all"} className="min-w-0">
            <FilterChips label="Filter by subteam" chips={forChips} />
          </ActiveChipInView>
          <ToggleChip href={ordersHref({ ...q, mine: !q.mine })} label="Mine" active={!!q.mine} />
        </div>

        <p className="text-sm text-ink-600">{orderSummaryText(summary, q)}</p>

        {list.truncated && <Alert>Showing the first {list.limit} items. Pick a filter to see the rest.</Alert>}

        <section aria-labelledby="order-list-heading">
          <h2 id="order-list-heading" className="sr-only">
            Items
          </h2>
          {/* Keyed by the filters: the list keeps its order while statuses change here, and re-sorts on a new filter.
              Rendered even when empty, so it can say where an item went after the last one leaves this filter. */}
          <OrderList
            key={`${q.filter}:${q.for ?? ""}:${q.mine ? 1 : 0}`}
            items={items}
            timeZone={env.teamTimezone}
            nowIso={now.toISOString()}
            highlight={highlight}
          />
          {items.length === 0 && (
            <Card>
              {counts.all === 0 && !q.for && !q.mine ? (
                <EmptyState
                  icon={ShoppingCart}
                  title="Nothing on the list yet"
                  description="Need something bought? Add it here; once a leader approves it, it can be ordered."
                  action={addButton}
                />
              ) : (
                <EmptyState
                  icon={SearchX}
                  title="Nothing here"
                  description={emptyText(q)}
                  action={
                    filtered ? (
                      <ButtonLink href={ordersHref({ filter: "all" })} variant="secondary">
                        Show everything
                      </ButtonLink>
                    ) : undefined
                  }
                />
              )}
            </Card>
          )}
        </section>
      </div>
    </>
  );
}
