"use client";

import { ChevronRight, CircleCheck, ExternalLink, Pencil } from "lucide-react";
import Link from "next/link";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Avatar } from "@/components/ui/avatar";
import { buttonClasses } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/cn";
import { SUBTEAM_LABELS } from "@/lib/constants";
import { formatAddedDay, formatCents } from "@/lib/orders";
import type { OrderItem } from "@/server/queries/orders";
import { OrderStatusControl, OrderStatusFocus } from "./status-select";

function itemHref(id: string) {
  return `/orders/${encodeURIComponent(id)}`;
}

/** An empty cell ("—"): ink-500 so it still reads at 4.5:1 on white. */
function Empty() {
  return <span className="text-ink-500">—</span>;
}

function forLabel(item: OrderItem): string {
  return item.subteam ? SUBTEAM_LABELS[item.subteam] : "Whole team";
}

/**
 * Text followed by an inline icon that never sits alone on a line: the last word goes with it (unless it's so
 * long it has to break anyway).
 */
function WithIcon({ text, icon }: { text: string; icon: ReactNode }) {
  const at = text.search(/\S+\s*$/);
  if (at < 0 || text.length - at > 24) {
    return (
      <>
        {text}
        {icon}
      </>
    );
  }
  return (
    <>
      {text.slice(0, at)}
      <span className="whitespace-nowrap">
        {text.slice(at)}
        {icon}
      </span>
    </>
  );
}

/** The description (table): a link to the product page when there is one. */
function Description({ item, className }: { item: OrderItem; className?: string }) {
  if (!item.link) return <span className={cn("font-semibold text-ink-900 wrap-anywhere", className)}>{item.description}</span>;
  return (
    <a
      href={item.link}
      target="_blank"
      rel="noopener noreferrer nofollow"
      className={cn("font-semibold text-brand-700 underline-offset-2 wrap-anywhere hover:text-brand-800 hover:underline", className)}
    >
      <WithIcon text={item.description} icon={<ExternalLink className="ml-1 inline size-3.5 align-[-0.125em]" aria-hidden />} />
      <span className="sr-only"> (product page)</span>
    </a>
  );
}

/** Phones: the product page, next to the vendor (the card's title opens the item's page). */
function ProductLink({ item }: { item: OrderItem }) {
  return (
    <a
      href={item.link}
      target="_blank"
      rel="noopener noreferrer nofollow"
      className="inline-flex min-h-10 items-center gap-1 font-medium text-brand-700 underline-offset-2 hover:text-brand-800 hover:underline"
    >
      Product page
      <ExternalLink className="size-3.5 shrink-0" aria-hidden />
      <span className="sr-only"> for {item.description} (opens in a new tab)</span>
    </a>
  );
}

/** Vendor (or the link's site) under the description. */
function vendorText(item: OrderItem): string {
  return item.vendor || item.linkHost;
}

function Cost({ cents }: { cents: number | null }) {
  return cents === null ? <Empty /> : <span className="font-medium tabular-nums text-ink-900">{formatCents(cents)}</span>;
}

/** Who's ordering it. `labeled` (phone cards, which have no column header): "Orderer: …" / "No orderer yet". */
function Orderer({ item, labeled = false, photoIds }: { item: OrderItem; labeled?: boolean; photoIds?: Record<string, string> }) {
  if (!item.orderer) return <span className="text-ink-500">{labeled ? "No orderer yet" : "No one yet"}</span>;
  return (
    <span className="flex min-w-0 items-center gap-2">
      {labeled && <span className="shrink-0">Orderer:</span>}
      <Avatar name={item.orderer.name} size="sm" photoId={photoIds?.[item.orderer.id]} />
      {/* Wraps at spaces first ("Ava / Thompson", not "Thompso / n"). */}
      <span className="min-w-0 break-words text-ink-800">{item.orderer.name}</span>
    </span>
  );
}

/** "Edit" (people who can change it) or "Details" (everyone else): the item's page. */
function DetailsLink({ item, describedBy, className }: { item: OrderItem; describedBy?: string; className?: string }) {
  const Icon = item.canEdit ? Pencil : ChevronRight;
  return (
    <Link
      href={itemHref(item.id)}
      data-order-link={item.id}
      aria-label={`${item.canEdit ? "Edit" : "Details for"} ${item.description}`}
      aria-describedby={describedBy}
      className={buttonClasses("ghost", "icon", cn("text-ink-500 hover:text-ink-800", className))}
    >
      <Icon className="size-4" aria-hidden />
    </Link>
  );
}

/** An item just added or saved: highlighted, with what happened. */
export interface OrderHighlight {
  id: string;
  message: string;
}

function HighlightNote({ highlight, id }: { highlight: OrderHighlight; id: string }) {
  return (
    <p id={id} className="flex gap-1.5 text-sm font-medium text-brand-800">
      <CircleCheck className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span className="min-w-0 wrap-anywhere">{highlight.message}</span>
    </p>
  );
}

/**
 * Keeps the order the list first showed while people change statuses right here (like a spreadsheet), so a
 * row doesn't jump away from the menu that was just used. New data is merged by id: rows that left the filter
 * disappear, rows someone else added go at the end. It re-sorts on the next visit (or filter change).
 */
function useStableOrder(items: OrderItem[]): OrderItem[] {
  const [order] = useState(() => items.map((i) => i.id));
  return useMemo(() => {
    const byId = new Map(items.map((i) => [i.id, i]));
    const known = new Set(order);
    const kept = order.flatMap((id) => {
      const item = byId.get(id);
      return item ? [item] : [];
    });
    return [...kept, ...items.filter((i) => !known.has(i.id))];
  }, [items, order]);
}

/**
 * The order list: stacked cards on phones, a spreadsheet-like table from md up (Notes, Qty, For, and Added get
 * their own columns from xl; below that they fold into the Description cell). Status menus save on change.
 */
export function OrderList({
  items,
  timeZone,
  nowIso,
  highlight = null,
  photoIds,
}: {
  items: OrderItem[];
  timeZone: string;
  /** Request time (so dates render the same on the server and in the browser). */
  nowIso: string;
  highlight?: OrderHighlight | null;
  /** Orderers' portal photos (user id → photo id; photoIdsFor), else initials. */
  photoIds?: Record<string, string>;
}) {
  const shown = useStableOrder(items);
  const rootRef = useRef<HTMLDivElement>(null);
  const highlightId = highlight?.id;
  const now = useMemo(() => new Date(nowIso), [nowIso]);
  const added = (item: OrderItem) => formatAddedDay(item.createdAt, timeZone, now);
  const marked = (id: string) => highlightId === id;

  // Just added or saved: bring that item into view and put focus on its Edit link.
  useEffect(() => {
    if (!highlightId) return;
    const links = rootRef.current?.querySelectorAll<HTMLElement>(`[data-order-link="${CSS.escape(highlightId)}"]`) ?? [];
    const link = Array.from(links).find((el) => el.getClientRects().length > 0);
    if (!link) return;
    link.focus({ preventScroll: true });
    link.scrollIntoView({ block: "center" });
  }, [highlightId]);

  // Nothing (left) in this filter: keep only the status line, so "… moved to Done." still shows after the last
  // item leaves the list (the page shows its empty state below).
  if (shown.length === 0) return <OrderStatusFocus>{null}</OrderStatusFocus>;

  return (
    <OrderStatusFocus>
      <div ref={rootRef}>
        <Card className="overflow-hidden">
          {/* Phones */}
          <ul className="divide-y divide-ink-100 md:hidden">
            {shown.map((item) => {
              const vendor = vendorText(item);
              const meta = [vendor, item.quantity !== null && `Qty ${item.quantity.toLocaleString("en-US")}`, forLabel(item)].filter(Boolean);
              const noteId = `order-note-phone-${item.id}`;
              return (
                <li key={item.id} className={cn("space-y-2 px-4 py-3", marked(item.id) && "bg-brand-50/70")}>
                  {highlight && marked(item.id) && <HighlightNote highlight={highlight} id={noteId} />}
                  <div className="flex items-start justify-between gap-2">
                    <p className="min-w-0 pt-2 font-semibold leading-snug">
                      {/* The item's page (the product page is its own link below). Padded out to a ≥ 40px tap
                          target without moving the text. */}
                      <Link
                        href={itemHref(item.id)}
                        className="-my-2.5 block rounded py-2.5 text-ink-900 underline-offset-2 wrap-anywhere hover:text-brand-800 hover:underline"
                      >
                        {item.description}
                      </Link>
                    </p>
                    <DetailsLink item={item} describedBy={marked(item.id) ? noteId : undefined} className="-mr-2" />
                  </div>
                  {(meta.length > 0 || item.link) && (
                    <div className="flex flex-wrap items-center gap-x-3 text-xs text-ink-500">
                      {meta.length > 0 && <span className="min-w-0 wrap-anywhere">{meta.join(" · ")}</span>}
                      {item.link && <ProductLink item={item} />}
                    </div>
                  )}
                  {/* The full notes are on the item's page. */}
                  {item.notes && <p className="line-clamp-3 whitespace-pre-line text-sm text-ink-700 wrap-anywhere">{item.notes}</p>}
                  <div className="flex items-start justify-between gap-3">
                    <OrderStatusControl
                      id={item.id}
                      description={item.description}
                      status={item.status}
                      updatedAt={item.updatedAt}
                      options={item.statusOptions}
                      className="w-40 min-w-0"
                    />
                    <span className="shrink-0 pt-2.5 text-sm">
                      <Cost cents={item.costCents} />
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-500">
                    <Orderer item={item} labeled photoIds={photoIds} />
                    <span>Added {added(item)}</span>
                  </div>
                </li>
              );
            })}
          </ul>

          {/* Tablets and up */}
          <table className="hidden w-full table-fixed text-left text-sm md:table">
            <thead className="border-b border-ink-100 bg-ink-50/60 text-xs font-medium uppercase tracking-wide text-ink-500">
              <tr>
                <th scope="col" className="w-32 py-2.5 pl-3 pr-2 font-medium lg:w-40 lg:pl-4">
                  Orderer
                </th>
                <th scope="col" className="w-32 px-1.5 py-2.5 font-medium">
                  Status
                </th>
                <th scope="col" className="px-2 py-2.5 font-medium">
                  Description
                </th>
                <th scope="col" className="hidden w-36 px-2 py-2.5 font-medium xl:table-cell">
                  Notes
                </th>
                <th scope="col" className="hidden w-14 px-2 py-2.5 text-right font-medium xl:table-cell">
                  Qty
                </th>
                <th scope="col" className="w-22 px-2 py-2.5 text-right font-medium">
                  Cost
                </th>
                <th scope="col" className="hidden w-24 px-2 py-2.5 font-medium xl:table-cell">
                  For
                </th>
                <th scope="col" className="hidden w-20 px-2 py-2.5 font-medium xl:table-cell">
                  Added
                </th>
                <th scope="col" className="w-12 py-2.5 pr-1">
                  <span className="sr-only">Edit or details</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {shown.map((item) => {
                const vendor = vendorText(item);
                const folded = [item.quantity !== null && `Qty ${item.quantity.toLocaleString("en-US")}`, forLabel(item), `Added ${added(item)}`].filter(
                  Boolean,
                );
                const noteId = `order-note-table-${item.id}`;
                return (
                  <tr key={item.id} className={cn("align-top", marked(item.id) && "bg-brand-50/70")}>
                    <td className="py-2 pl-3 pr-2 lg:pl-4">
                      <span className="flex min-h-10 min-w-0 items-center">
                        <Orderer item={item} photoIds={photoIds} />
                      </span>
                    </td>
                    {/* px-1.5: the w-32 column leaves a 116px menu, enough for "Requested" (see OrderStatusControl). */}
                    <td className="px-1.5 py-2">
                      <OrderStatusControl
                        id={item.id}
                        description={item.description}
                        status={item.status}
                        updatedAt={item.updatedAt}
                        options={item.statusOptions}
                      />
                    </td>
                    <td className="min-w-0 px-2 py-2">
                      <p className="flex min-h-10 items-center leading-snug">
                        <span className="min-w-0">
                          <Description item={item} />
                        </span>
                      </p>
                      {vendor && <p className="text-xs text-ink-500 wrap-anywhere">{vendor}</p>}
                      <p className="mt-0.5 text-xs text-ink-500 wrap-anywhere xl:hidden">{folded.join(" · ")}</p>
                      {item.notes && (
                        <p className="mt-1 line-clamp-3 whitespace-pre-line text-xs text-ink-700 wrap-anywhere xl:hidden">{item.notes}</p>
                      )}
                      {highlight && marked(item.id) && (
                        <div className="mt-1">
                          <HighlightNote highlight={highlight} id={noteId} />
                        </div>
                      )}
                    </td>
                    <td className="hidden px-2 py-2 xl:table-cell">
                      {item.notes ? (
                        // Margin, not padding: padding on a clamped box shows part of the next line under the "…".
                        <p className="my-2.5 line-clamp-4 whitespace-pre-line text-ink-700 wrap-anywhere" title={item.notes}>
                          {item.notes}
                        </p>
                      ) : (
                        <span className="flex min-h-10 items-center">
                          <Empty />
                        </span>
                      )}
                    </td>
                    <td className="hidden px-2 py-2 text-right xl:table-cell">
                      <span className="flex min-h-10 items-center justify-end tabular-nums text-ink-800">
                        {item.quantity === null ? <Empty /> : item.quantity.toLocaleString("en-US")}
                      </span>
                    </td>
                    <td className="px-2 py-2 text-right">
                      <span className="flex min-h-10 items-center justify-end">
                        <Cost cents={item.costCents} />
                      </span>
                    </td>
                    <td className="hidden px-2 py-2 xl:table-cell">
                      <span className="flex min-h-10 items-center text-ink-700">{forLabel(item)}</span>
                    </td>
                    <td className="hidden px-2 py-2 xl:table-cell">
                      <span className="flex min-h-10 items-center text-ink-700">{added(item)}</span>
                    </td>
                    <td className="py-2 pr-1">
                      <DetailsLink item={item} describedBy={marked(item.id) ? noteId : undefined} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      </div>
    </OrderStatusFocus>
  );
}
