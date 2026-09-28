import { ArrowLeft, BookOpenText } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { EntryComposer } from "@/components/notebook/editable-entry";
import { EntryCard } from "@/components/notebook/entry-card";
import { EntryRegion } from "@/components/notebook/entry-region";
import { ExportMenu } from "@/components/notebook/export-menu";
import { JumpMenu } from "@/components/notebook/jump-menu";
import { NotebookOutlineNav } from "@/components/notebook/notebook-outline-nav";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Pagination, parsePage } from "@/components/ui/pagination";
import { cn } from "@/lib/cn";
import { NOTEBOOK_DEFAULT_EMOJI } from "@/lib/notebook";
import { requireActiveUser } from "@/server/auth/session";
import { env } from "@/server/env";
import { getNotebookOutline, getNotebookPageView, type NotebookEntryOrder } from "@/server/queries/notebook";

export const metadata: Metadata = { title: "Team notebook" };

function first(v: string | string[] | undefined) {
  return Array.isArray(v) ? v[0] : v;
}

function hrefFor(pageId: string, order: NotebookEntryOrder, screen = 1): string {
  const sp = new URLSearchParams();
  if (order === "oldest") sp.set("order", "oldest");
  if (screen > 1) sp.set("page", String(screen));
  const qs = sp.toString();
  return `/notebook/p/${encodeURIComponent(pageId)}${qs ? `?${qs}` : ""}`;
}

/**
 * One notebook page: its entries (newest first, or oldest first), "New entry" for everyone, and export.
 * On desktop the notebook outline sits on the left; on phones it folds into "All notebooks".
 */
export default async function NotebookPageView({ params, searchParams }: PageProps<"/notebook/p/[pageId]">) {
  const actor = await requireActiveUser();
  const { pageId } = await params;
  const sp = await searchParams;
  const order: NotebookEntryOrder = first(sp.order) === "oldest" ? "oldest" : "newest";
  const [view, outline] = await Promise.all([
    getNotebookPageView(actor, pageId, { order, screen: parsePage(sp.page) }),
    getNotebookOutline(actor),
  ]);
  if (!view || !outline) notFound();
  const tz = env.teamTimezone;
  const { notebook, page } = view;
  const emoji = notebook.emoji || NOTEBOOK_DEFAULT_EMOJI;

  const orderLink = (value: NotebookEntryOrder, label: string) => (
    <Link
      href={hrefFor(page.id, value)}
      aria-current={order === value ? "true" : undefined}
      className={cn(
        "inline-flex min-h-10 items-center rounded-md px-3 text-sm font-medium transition-colors",
        order === value ? "bg-white text-ink-900 shadow-sm" : "text-ink-600 hover:text-ink-900",
      )}
    >
      {label}
    </Link>
  );

  return (
    <div className="lg:grid lg:grid-cols-[15rem_minmax(0,1fr)] lg:gap-8">
      <aside className="hidden lg:block">
        <div className="sticky top-6 max-h-[calc(100vh-3rem)] overflow-y-auto pb-6">
          <Link
            href="/notebook"
            className="mb-2 flex min-h-10 items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-ink-500 hover:bg-ink-100 hover:text-ink-800"
          >
            <ArrowLeft className="size-4" aria-hidden />
            All notebooks
          </Link>
          <NotebookOutlineNav notebooks={outline.notebooks} currentPageId={page.id} />
        </div>
      </aside>

      <div className="min-w-0">
        {/* Phones: back to the list, or jump to another page. */}
        <div className="relative mb-3 flex flex-wrap items-start gap-2 lg:hidden">
          <Link
            href={`/notebook#notebook-${notebook.id}`}
            className="-ml-2 inline-flex h-10 items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-ink-500 hover:bg-ink-100 hover:text-ink-800"
          >
            <ArrowLeft className="size-4" aria-hidden />
            All notebooks
          </Link>
          <JumpMenu label="Jump to a page">
            <NotebookOutlineNav notebooks={outline.notebooks} currentPageId={page.id} label="Jump to a page" />
          </JumpMenu>
        </div>

        <PageHeader
          // Plain text: "All notebooks" (and the outline on desktop) already go to this notebook with a full-size target.
          eyebrow={
            <span className="wrap-anywhere">
              <span aria-hidden>{emoji} </span>
              {notebook.title}
            </span>
          }
          title={<span className="wrap-anywhere">{page.title}</span>}
          description={`${view.entryCount} ${view.entryCount === 1 ? "entry" : "entries"}`}
          actions={
            <ExportMenu
              label={`${notebook.title}, ${page.title}`}
              wordHref={`/notebook/p/${encodeURIComponent(page.id)}/export`}
              printHref={`/notebook/print/p/${encodeURIComponent(page.id)}`}
              align="end"
            />
          }
        />

        <EntryRegion>
          <div className="space-y-4">
            <EntryComposer pageId={page.id} timeZone={tz} />

            {view.entryCount > 1 && (
              <nav aria-label="Order" className="inline-flex rounded-lg bg-ink-100 p-1">
                {orderLink("newest", "Newest first")}
                {orderLink("oldest", "Oldest first")}
              </nav>
            )}

            {view.entries.length === 0 ? (
              // Hidden while "New entry" is open (it says the same thing).
              <div className="[[data-composer-open]~&]:hidden">
                <Card>
                  <EmptyState
                    icon={BookOpenText}
                    title="No entries yet"
                    description="Write the first one: what you built, tested, or decided. Your name and the time are added for you."
                  />
                </Card>
              </div>
            ) : (
              <ol className="space-y-4" aria-label={`Entries, ${order} first`}>
                {view.entries.map((entry) => (
                  <li key={entry.id}>
                    <EntryCard entry={entry} pageId={page.id} timeZone={tz} />
                  </li>
                ))}
              </ol>
            )}
          </div>
        </EntryRegion>

        <Pagination page={view.screen} pageCount={view.screenCount} hrefFor={(screen) => hrefFor(page.id, order, screen)} />
      </div>
    </div>
  );
}
