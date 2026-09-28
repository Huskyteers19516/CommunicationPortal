import { Megaphone } from "lucide-react";
import type { Metadata } from "next";
import { AnnouncementForm } from "@/components/announcements/announcement-form";
import { BackLink } from "@/components/tasks/back-link";
import { ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { SUBTEAMS } from "@/lib/constants";
import { requireActiveUser } from "@/server/auth/session";
import { announcementAudiences } from "@/server/permissions";
import { createAnnouncementAction } from "../actions";

export const metadata: Metadata = { title: "Post an announcement" };

function first(v: string | string[] | undefined) {
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Post an announcement (leaders, the captain, mentors, teachers, owners). `?for=BUILD` starts on that subteam when
 * the person can post for it; otherwise it starts on the whole team.
 */
export default async function NewAnnouncementPage({ searchParams }: PageProps<"/announcements/new">) {
  const actor = await requireActiveUser();
  const sp = await searchParams;
  const audiences = announcementAudiences(actor);

  if (audiences.length === 0) {
    return (
      <>
        <BackLink href="/announcements">Announcements</BackLink>
        <PageHeader title="Post an announcement" />
        <Card className="max-w-2xl">
          <EmptyState
            icon={Megaphone}
            title="Leaders post announcements"
            description="Leaders, the captain, mentors, and teachers post news for the team. Have something to share? Ask one of them, or start a thread in Discussion."
            action={
              <ButtonLink href="/announcements" variant="secondary">
                Read the announcements
              </ButtonLink>
            }
          />
        </Card>
      </>
    );
  }

  const wanted = SUBTEAMS.find((s) => s === first(sp.for));
  const start = wanted && audiences.includes(wanted) ? wanted : null;

  return (
    <>
      <BackLink href="/announcements">Announcements</BackLink>
      <PageHeader title="Post an announcement" description="Your name goes on it, and the whole team can read it." />
      <div className="max-w-3xl">
        <AnnouncementForm
          action={createAnnouncementAction}
          audiences={audiences}
          submitLabel="Post announcement"
          pendingText="Posting…"
          initial={{ title: "", body: "", audience: start ?? "team", pinned: false }}
        />
      </div>
    </>
  );
}
