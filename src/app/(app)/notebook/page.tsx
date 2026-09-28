import { BookOpenText, NotebookPen, Plus, Sparkles } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { NotebookSection, type NotebookSectionData } from "@/components/notebook/notebook-section";
import { FocusAlert } from "@/components/sponsors/focus-alert";
import { ActionForm } from "@/components/tasks/action-form";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { timeAgo } from "@/lib/dates";
import { NOTEBOOK_DEFAULT_EMOJI, STANDARD_NOTEBOOKS } from "@/lib/notebook";
import { requireActiveUser } from "@/server/auth/session";
import { env } from "@/server/env";
import { getLatestNotebookEntries, getNotebookOutline, notebookPageHref } from "@/server/queries/notebook";
import { createStandardNotebooksAction } from "./actions";

export const metadata: Metadata = { title: "Team notebook" };

function first(v: string | string[] | undefined) {
  return Array.isArray(v) ? v[0] : v;
}

const standardList = STANDARD_NOTEBOOKS.map((n) => `${n.title.replace(/ Notebook$/, "")} (${n.pages.join(", ")})`).join("; ");

/**
 * The team's engineering notebooks, like the outline of the team's Google Doc: each notebook with its pages.
 * Everyone reads, writes, and exports; the captain (and all-scope staff) manage notebooks, and each notebook's
 * subteam leaders manage its pages.
 */
export default async function NotebookPage({ searchParams }: PageProps<"/notebook">) {
  const actor = await requireActiveUser();
  const sp = await searchParams;
  const [outline, latest] = await Promise.all([getNotebookOutline(actor), getLatestNotebookEntries(actor, 6)]);
  const now = new Date();
  const tz = env.teamTimezone;
  const canManage = outline?.canManageNotebooks ?? false;
  const notebooks = outline?.notebooks ?? [];

  const sections: NotebookSectionData[] = notebooks.map((n) => ({
    id: n.id,
    title: n.title,
    emoji: n.emoji,
    description: n.description,
    subteam: n.subteam,
    entryCount: n.entryCount,
    canManagePages: n.canManagePages,
    pages: n.pages.map((p) => ({
      id: p.id,
      title: p.title,
      entryCount: p.entryCount,
      updatedLabel: p.lastEntryAt ? `last entry ${timeAgo(p.lastEntryAt, now, tz)}` : null,
    })),
  }));

  // A notebook just added or saved says so itself (and takes focus), since it can be far down the page.
  const added = first(sp.added);
  const saved = first(sp.saved);
  const arrivedAt = notebooks.some((n) => n.id === added || n.id === saved);
  const notice =
    first(sp.created) === "1"
      ? "The notebooks are ready. Pick a page to start writing."
      : (added || saved) && !arrivedAt
        ? added
          ? "Notebook added."
          : "Notebook saved."
        : first(sp.removed) === "1"
          ? "Notebook deleted."
          : null;

  return (
    <>
      <PageHeader
        title="Team notebook"
        description="Pick a page and write what you did. The date, time, and your name are added for you."
        actions={
          canManage && notebooks.length > 0 ? (
            <ButtonLink href="/notebook/new" variant="secondary">
              <Plus className="size-4" aria-hidden />
              New notebook
            </ButtonLink>
          ) : undefined
        }
      />

      {/* Takes focus, so keyboard and screen-reader users hear it (instead of landing on <body>). */}
      {notice && (
        <div className="mb-4">
          <FocusAlert tone="success">{notice}</FocusAlert>
        </div>
      )}

      {notebooks.length === 0 ? (
        <Card>
          {canManage ? (
            <EmptyState
              icon={NotebookPen}
              title="No notebooks yet"
              description={`Start with the team's usual notebooks — ${standardList} — or make your own.`}
              action={
                <div className="flex flex-col items-center gap-2 sm:flex-row">
                  <ActionForm action={createStandardNotebooksAction} fields={{}} variant="primary" pendingText="Creating…">
                    <Sparkles className="size-4" aria-hidden />
                    Create the standard notebooks
                  </ActionForm>
                  <ButtonLink href="/notebook/new" variant="secondary">
                    <Plus className="size-4" aria-hidden />
                    New notebook
                  </ButtonLink>
                </div>
              }
            />
          ) : (
            <EmptyState
              icon={NotebookPen}
              title="No notebooks yet"
              description="The captain sets up the team's notebooks. Check back soon."
            />
          )}
        </Card>
      ) : (
        // Side by side only from 1280px: at 1024 the app's menu takes 256px and the notebooks would be squeezed.
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="min-w-0 space-y-4">
            {sections.map((n, i) => (
              <NotebookSection
                key={n.id}
                notebook={n}
                canManageNotebooks={canManage}
                isFirst={i === 0}
                isLast={i === sections.length - 1}
                arrived={n.id === added ? "added" : n.id === saved ? "saved" : undefined}
              />
            ))}
          </div>

          <aside className="min-w-0" aria-labelledby="latest-entries">
            <Card>
              <CardHeader title={<span id="latest-entries">Latest entries</span>} />
              {latest.length === 0 ? (
                <EmptyState icon={BookOpenText} title="Nothing written yet" description="Open a page and add the first entry." />
              ) : (
                <ul className="divide-y divide-ink-100">
                  {latest.map((e) => (
                    <li key={e.id}>
                      <Link
                        href={`${notebookPageHref(e.pageId)}#entry-${e.id}`}
                        className="block px-4 py-3 hover:bg-ink-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500/40 sm:px-5"
                      >
                        <span className="block text-xs text-ink-500 wrap-anywhere">
                          <span aria-hidden>{e.notebookEmoji || NOTEBOOK_DEFAULT_EMOJI} </span>
                          {e.notebookTitle} › {e.pageTitle}
                        </span>
                        <span className="mt-0.5 block text-sm font-medium text-ink-900 wrap-anywhere">{e.title || e.snippet}</span>
                        <span className="mt-0.5 block text-xs text-ink-500 wrap-anywhere">
                          {e.authorName ?? "A former member"} · {timeAgo(e.createdAt, now, tz)}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </aside>
        </div>
      )}
    </>
  );
}
