import { Users } from "lucide-react";
import type { Metadata } from "next";
import { BackLink } from "@/components/tasks/back-link";
import { ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { MeetingUpdateForm } from "@/components/updates/meeting-update-form";
import type { Subteam } from "@/generated/prisma/enums";
import { todayInTimezone } from "@/lib/dates";
import { meetingDateBounds, prefillMeetingDate } from "@/lib/meeting-updates";
import { requireActiveUser } from "@/server/auth/session";
import { env } from "@/server/env";
import { meetingUpdateSubteams } from "@/server/permissions";
import { createMeetingUpdateAction } from "../actions";

export const metadata: Metadata = { title: "Write an update" };

function first(v: string | string[] | undefined) {
  return Array.isArray(v) ? v[0] : v;
}

/** The subteam picked to start with: `?subteam=` when allowed, else the person's own (else none yet). */
function defaultSubteam(wanted: string | undefined, subteams: Subteam[], own: Subteam | null): Subteam | "" {
  const fromUrl = subteams.find((s) => s === wanted);
  if (fromUrl) return fromUrl;
  if (own && subteams.includes(own)) return own;
  return subteams.length === 1 ? subteams[0] : "";
}

/**
 * Write a meeting update for your subteam (the captain, mentors, teachers, and owners: any subteam).
 * `?date=` and `?subteam=` prefill the form (ignored when not a date/subteam the person may use).
 */
export default async function NewMeetingUpdatePage({ searchParams }: PageProps<"/updates/new">) {
  const actor = await requireActiveUser();
  const sp = await searchParams;
  const today = todayInTimezone(env.teamTimezone);
  const subteams = meetingUpdateSubteams(actor);

  if (subteams.length === 0) {
    return (
      <>
        <BackLink href="/updates">Meeting updates</BackLink>
        <PageHeader title="Write an update" />
        <Card className="max-w-2xl">
          <EmptyState
            icon={Users}
            title="You're not on a subteam"
            description="Meeting updates are written for the Software, Build, or Business subteam. Ask a leader to set your subteam."
            action={
              <ButtonLink href="/updates" variant="secondary">
                Read the updates
              </ButtonLink>
            }
          />
        </Card>
      </>
    );
  }

  const { min, max } = meetingDateBounds(today);
  const subteam = defaultSubteam(first(sp.subteam), subteams, actor.subteam);

  return (
    <>
      <BackLink href="/updates">Meeting updates</BackLink>
      <PageHeader
        title="Write an update"
        description={`What ${subteams.length === 1 ? "your" : "the"} subteam did at this meeting. Your name goes on it, and the whole team can read it.`}
      />
      <div className="max-w-3xl">
        <MeetingUpdateForm
          action={createMeetingUpdateAction}
          subteams={subteams}
          submitLabel="Post update"
          minDate={min}
          maxDate={max}
          initial={{
            meetingDate: prefillMeetingDate(first(sp.date), today) ?? today,
            subteam,
            body: "",
            nextSteps: "",
            blockers: "",
          }}
        />
      </div>
    </>
  );
}
