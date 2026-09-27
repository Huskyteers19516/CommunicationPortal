"use client";

import { CircleCheck, Globe, Mail, Paperclip, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/cn";
import { type DateOnly, daysBetween } from "@/lib/dates";
import { formatDollars } from "@/lib/money";
import { formatShortDate, isOpenStage, websiteHost } from "@/lib/sponsorships";
import type { SponsorshipItem } from "@/server/queries/sponsorships";
import { StageChangeFocus, StageSelect } from "./stage-select";

function sponsorHref(id: string) {
  return `/sponsors/${encodeURIComponent(id)}`;
}

/** An empty cell ("—"): ink-500 so it still reads at 4.5:1 on white. */
function Empty() {
  return <span className="text-ink-500">—</span>;
}

/**
 * The deadline, highlighted while we still have work to do on it: red once it has passed, amber in the
 * next 7 days. After submitting, it's just a date.
 */
export function ClosesLabel({ item, today, className }: { item: SponsorshipItem; today: DateOnly; className?: string }) {
  if (!item.closesOn) return <Empty />;
  const date = formatShortDate(item.closesOn, today);
  const diff = daysBetween(today, item.closesOn);
  if (isOpenStage(item.stage) && diff < 0) {
    return <span className={cn("font-medium text-red-700", className)}>{date} · closed</span>;
  }
  if (isOpenStage(item.stage) && diff <= 7) {
    const when = diff === 0 ? "today" : diff === 1 ? "tomorrow" : `in ${diff} days`;
    return (
      <span className={cn("font-medium text-amber-800", className)}>
        {date} · {when}
      </span>
    );
  }
  return <span className={cn("text-ink-700", className)}>{date}</span>;
}

function DateCell({ value, today }: { value: DateOnly | null; today: DateOnly }) {
  return value ? <span className="text-ink-700">{formatShortDate(value, today)}</span> : <Empty />;
}

function Amount({ value }: { value: number | null }) {
  return value === null ? <Empty /> : <span className="font-medium tabular-nums text-ink-900">{formatDollars(value)}</span>;
}

/** A paperclip with how many files are attached (forms, filled-out copies…), next to the sponsor's name. */
function FileCount({ count }: { count: number }) {
  if (count <= 0) return null;
  const label = `${count} ${count === 1 ? "file" : "files"}`;
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-ink-100 px-1.5 py-0.5 text-xs font-medium tabular-nums text-ink-600"
    >
      <Paperclip className="size-3" aria-hidden />
      {count}
    </span>
  );
}

/** Website and email links under the sponsor's name. */
function ContactLinks({ item, className }: { item: SponsorshipItem; className?: string }) {
  if (!item.website && !item.contactEmail) return null;
  const link =
    "inline-flex min-h-10 min-w-0 max-w-full items-center gap-1.5 rounded-md text-sm text-brand-700 underline-offset-2 hover:text-brand-800 hover:underline md:min-h-8";
  return (
    <div className={cn("flex min-w-0 flex-wrap gap-x-4", className)}>
      {item.website && (
        <a href={item.website} target="_blank" rel="noopener noreferrer nofollow" className={link}>
          <Globe className="size-3.5 shrink-0" aria-hidden />
          <span className="truncate">{websiteHost(item.website) || "Website"}</span>
          <span className="sr-only"> (website of {item.name})</span>
        </a>
      )}
      {item.contactEmail && (
        <a href={`mailto:${item.contactEmail}`} className={link}>
          <Mail className="size-3.5 shrink-0" aria-hidden />
          <span className="truncate">{item.contactEmail}</span>
        </a>
      )}
    </div>
  );
}

/** A sponsor just added or saved: highlighted, with what happened next to it. */
export interface SponsorHighlight {
  id: string;
  message: string;
  tone: "success" | "warning";
  /** Just added: a link to its page to attach forms and files (they can only be added once it exists). */
  attachFiles?: boolean;
}

/** `id` is on the message only: the sponsor's link is described by it, not by the "Attach" link. */
function HighlightNote({ highlight, id, name }: { highlight: SponsorHighlight; id: string; name: string }) {
  const Icon = highlight.tone === "warning" ? TriangleAlert : CircleCheck;
  return (
    <div>
      <p id={id} className={cn("flex gap-1.5 text-sm font-medium", highlight.tone === "warning" ? "text-amber-900" : "text-brand-800")}>
        <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
        <span className="min-w-0 wrap-anywhere">{highlight.message}</span>
      </p>
      {highlight.attachFiles && (
        <Link
          href={sponsorHref(highlight.id)}
          className="inline-flex min-h-10 items-center gap-1.5 rounded-md text-sm font-medium text-brand-700 underline underline-offset-2 hover:text-brand-800 md:min-h-8"
        >
          <Paperclip className="size-4 shrink-0" aria-hidden />
          Attach forms and files
          <span className="sr-only"> to {name}</span>
        </Link>
      )}
    </div>
  );
}

/**
 * Keeps the order the list first showed while people change stages right here (like a spreadsheet), so a
 * row doesn't jump away from the menu that was just used. New data is merged by id: rows that left the
 * filter disappear, rows someone else added go at the end. It re-sorts on the next visit (or filter change).
 */
function useStableOrder(items: SponsorshipItem[]): SponsorshipItem[] {
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

/** Sponsors: stacked cards on phones, a table from md up. Each has a stage menu that saves on change. */
export function SponsorshipList({
  items,
  today,
  highlight = null,
}: {
  items: SponsorshipItem[];
  today: DateOnly;
  highlight?: SponsorHighlight | null;
}) {
  const shown = useStableOrder(items);
  const rootRef = useRef<HTMLDivElement>(null);
  const highlightId = highlight?.id;

  // Just added or saved: bring that sponsor into view and put focus on its name.
  useEffect(() => {
    if (!highlightId) return;
    const links = rootRef.current?.querySelectorAll<HTMLElement>(`[data-sponsor-link="${CSS.escape(highlightId)}"]`) ?? [];
    const link = Array.from(links).find((el) => el.getClientRects().length > 0);
    if (!link) return;
    link.focus({ preventScroll: true });
    link.scrollIntoView({ block: "center" });
  }, [highlightId]);

  const marked = (id: string) => highlight?.id === id;
  const rowTone = (id: string) =>
    marked(id) ? (highlight?.tone === "warning" ? "bg-amber-50/80" : "bg-brand-50/70") : undefined;

  return (
    <StageChangeFocus>
      <div ref={rootRef}>
        <Card className="overflow-hidden">
          {/* Phones */}
          <ul className="divide-y divide-ink-100 md:hidden">
            {shown.map((item) => (
              <li key={item.id} className={cn("space-y-2 px-4 py-3", rowTone(item.id))}>
                {highlight && marked(item.id) && <HighlightNote highlight={highlight} id={`sponsor-note-phone-${item.id}`} name={item.name} />}
                <div className="flex items-start justify-between gap-3">
                  <div className="-my-1 flex min-w-0 items-center gap-1.5">
                    <Link
                      href={sponsorHref(item.id)}
                      data-sponsor-link={item.id}
                      aria-describedby={marked(item.id) ? `sponsor-note-phone-${item.id}` : undefined}
                      className="flex min-h-10 min-w-0 items-center font-semibold text-ink-900 wrap-anywhere hover:text-brand-700"
                    >
                      {item.name}
                    </Link>
                    <FileCount count={item.fileCount} />
                  </div>
                  {item.amountReceived !== null && (
                    <span className="shrink-0 pt-1.5 text-sm">
                      <Amount value={item.amountReceived} />
                    </span>
                  )}
                </div>
                <ContactLinks item={item} className="-mt-1" />
                <StageSelect id={item.id} name={item.name} stage={item.stage} className="max-w-60" />
                {item.asking && (
                  <p className="text-sm text-ink-700 wrap-anywhere">
                    <span className="text-ink-500">Asking for </span>
                    {item.asking}
                  </p>
                )}
                <p className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-ink-500">
                  <span className="min-w-0 wrap-anywhere">{item.owner ? item.owner.name : "No one on it yet"}</span>
                  {item.submittedOn && <span>Submitted {formatShortDate(item.submittedOn, today)}</span>}
                  {item.acceptedOn && <span>Accepted {formatShortDate(item.acceptedOn, today)}</span>}
                  {item.closesOn && (
                    <span>
                      Closes <ClosesLabel item={item} today={today} />
                    </span>
                  )}
                </p>
              </li>
            ))}
          </ul>

          {/* Tablets and up. Below xl, Received / Asking / Submitted fold into the sponsor's cell. */}
          <table className="hidden w-full table-fixed text-left text-sm md:table">
            <thead className="border-b border-ink-100 bg-ink-50/60 text-xs font-medium uppercase tracking-wide text-ink-500">
              <tr>
                <th scope="col" className="px-3 py-2.5 font-medium lg:px-4">
                  Sponsor
                </th>
                <th scope="col" className="w-40 px-1.5 py-2.5 font-medium">
                  Stage
                </th>
                <th scope="col" className="hidden w-36 px-2 py-2.5 font-medium xl:table-cell">
                  Asking
                </th>
                <th scope="col" className="hidden w-24 px-2 py-2.5 text-right font-medium xl:table-cell">
                  Received
                </th>
                <th scope="col" className="w-32 px-2 py-2.5 font-medium">
                  Person
                </th>
                <th scope="col" className="hidden w-24 px-2 py-2.5 font-medium xl:table-cell">
                  Submitted
                </th>
                <th scope="col" className="w-32 px-2 py-2.5 font-medium lg:pr-4">
                  Closes
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {shown.map((item) => {
                const folded = [
                  item.amountReceived !== null && `Received ${formatDollars(item.amountReceived)}`,
                  item.asking && `Asking for ${item.asking}`,
                  item.submittedOn && `Submitted ${formatShortDate(item.submittedOn, today)}`,
                ].filter(Boolean);
                return (
                  <tr key={item.id} className={cn("align-top", rowTone(item.id))}>
                    <td className="min-w-0 px-3 py-2 lg:px-4">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <Link
                          href={sponsorHref(item.id)}
                          data-sponsor-link={item.id}
                          aria-describedby={marked(item.id) ? `sponsor-note-table-${item.id}` : undefined}
                          className="flex min-h-10 min-w-0 items-center font-semibold text-ink-900 wrap-anywhere hover:text-brand-700"
                        >
                          {item.name}
                        </Link>
                        <FileCount count={item.fileCount} />
                      </div>
                      <ContactLinks item={item} />
                      {folded.length > 0 && (
                        <p className="mt-0.5 text-xs text-ink-500 wrap-anywhere xl:hidden">
                          {folded.map((text, i) => (
                            <span key={i}>
                              {i > 0 && " · "}
                              {i === 0 && item.amountReceived !== null ? <span className="font-medium text-ink-800">{text}</span> : text}
                            </span>
                          ))}
                        </p>
                      )}
                      {highlight && marked(item.id) && (
                        <div className="mt-1">
                          <HighlightNote highlight={highlight} id={`sponsor-note-table-${item.id}`} name={item.name} />
                        </div>
                      )}
                    </td>
                    {/* px-1.5: the w-40 column leaves a 148px menu, enough for "Haven't started" (see StageSelect). */}
                    <td className="px-1.5 py-2">
                      <StageSelect id={item.id} name={item.name} stage={item.stage} />
                    </td>
                    <td className="hidden px-2 py-2 xl:table-cell">
                      <span className="flex min-h-10 items-center text-ink-700 wrap-anywhere">{item.asking || <Empty />}</span>
                    </td>
                    <td className="hidden px-2 py-2 text-right xl:table-cell">
                      <span className="flex min-h-10 items-center justify-end">
                        <Amount value={item.amountReceived} />
                      </span>
                    </td>
                    <td className="px-2 py-2">
                      <span className="flex min-h-10 min-w-0 items-center">
                        {item.owner ? (
                          <span className="truncate text-ink-800" title={item.owner.name}>
                            {item.owner.name}
                          </span>
                        ) : (
                          <Empty />
                        )}
                      </span>
                    </td>
                    <td className="hidden px-2 py-2 xl:table-cell">
                      <span className="flex min-h-10 items-center">
                        <DateCell value={item.submittedOn} today={today} />
                      </span>
                    </td>
                    <td className="px-2 py-2 lg:pr-4">
                      <span className="flex min-h-10 items-center">
                        <ClosesLabel item={item} today={today} />
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      </div>
    </StageChangeFocus>
  );
}
