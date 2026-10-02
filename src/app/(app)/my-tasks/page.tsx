import { CircleCheck, ClipboardList, ListChecks, type LucideIcon } from "lucide-react";
import type { Metadata } from "next";
import { ChecklistList, DueGroupedList } from "@/components/checklist/checklist-list";
import { ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { LinkTabs } from "@/components/ui/link-tabs";
import { PageHeader } from "@/components/ui/page-header";
import { Pagination, parsePage } from "@/components/ui/pagination";
import { todayInTimezone } from "@/lib/dates";
import { requireActiveUser } from "@/server/auth/session";
import { env } from "@/server/env";
import { getMyTasks, type MyTasksTab, parseMyTasksTab } from "@/server/queries/checklist";

export const metadata: Metadata = { title: "My tasks" };

const TAB_LABELS: Record<MyTasksTab, string> = { open: "Open", done: "Done", all: "All" };

const EMPTY: Record<MyTasksTab, { icon: LucideIcon; title: string; description: string }> = {
  open: {
    icon: CircleCheck,
    title: "Nothing on your plate",
    description: "You have no open tasks. New tasks from your leaders will show up here.",
  },
  done: {
    icon: ListChecks,
    title: "No approved tasks yet",
    description:
      "Check items off on your Today list. They land here once a leader approves them, or marks the whole task finished.",
  },
  all: {
    icon: ClipboardList,
    title: "No tasks yet",
    description: "When a leader assigns you something, it will show up here.",
  },
};

function hrefFor(tab: MyTasksTab, page = 1): string {
  const q = new URLSearchParams();
  if (tab !== "open") q.set("tab", tab);
  if (page > 1) q.set("page", String(page));
  const s = q.toString();
  return s ? `/my-tasks?${s}` : "/my-tasks";
}

/** Request time, read outside of render so relative labels line up between server and browser. */
function requestTime(): Date {
  return new Date();
}

export default async function MyTasksPage({ searchParams }: PageProps<"/my-tasks">) {
  const actor = await requireActiveUser();
  const sp = await searchParams;
  const tab = parseMyTasksTab(sp.tab);
  const now = requestTime();
  const timeZone = env.teamTimezone;
  const today = todayInTimezone(timeZone, now);
  const nowIso = now.toISOString();

  const data = await getMyTasks(actor, { tab, page: parsePage(sp.page) });
  const empty = EMPTY[tab];

  return (
    <>
      <PageHeader title="My tasks" description="Everything assigned to you. Checked items count once a leader approves them." />

      <div className="max-w-3xl space-y-4">
        {/* Counts here are informational, so the tabs keep LinkTabs' neutral (gray) count — no "alert" tone. */}
        <LinkTabs
          tabs={(Object.keys(TAB_LABELS) as MyTasksTab[]).map((t) => ({
            href: hrefFor(t),
            label: TAB_LABELS[t],
            active: t === tab,
            count: data.counts[t],
          }))}
        />

        <h2 className="sr-only">{TAB_LABELS[tab]} tasks</h2>
        {data.items.length === 0 ? (
          <Card>
            <EmptyState
              icon={empty.icon}
              title={empty.title}
              description={empty.description}
              action={
                tab === "open" && data.counts.done > 0 ? (
                  <ButtonLink href={hrefFor("done")} variant="secondary">
                    See what you&apos;ve finished
                  </ButtonLink>
                ) : undefined
              }
            />
          </Card>
        ) : tab === "open" ? (
          <DueGroupedList items={data.items} today={today} now={nowIso} timeZone={timeZone} />
        ) : (
          <ChecklistList items={data.items} today={today} now={nowIso} timeZone={timeZone} />
        )}

        <Pagination page={data.page} pageCount={data.pageCount} hrefFor={(p) => hrefFor(tab, p)} />
      </div>
    </>
  );
}
