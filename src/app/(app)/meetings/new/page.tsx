import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { MeetingRecapForm } from "@/components/meetings/meeting-recap-form";
import { RecorderLink } from "@/components/meetings/recorder-link";
import { BackLink } from "@/components/tasks/back-link";
import { PageHeader } from "@/components/ui/page-header";
import { todayInTimezone } from "@/lib/dates";
import { requireActiveUser } from "@/server/auth/session";
import { env } from "@/server/env";
import { canManageMeetingRecaps } from "@/server/permissions";
import { listMeetingCategories } from "@/server/queries/meeting-recaps";

export const metadata: Metadata = { title: "Write up a meeting" };

/**
 * A recap without a recording (people with admin access): for a meeting nobody recorded, typed from notes. Everyone
 * else reads recaps, so they go to the list.
 */
export default async function NewMeetingRecapPage() {
  const actor = await requireActiveUser();
  if (!canManageMeetingRecaps(actor)) redirect("/meetings");
  const categories = await listMeetingCategories(actor);
  const today = todayInTimezone(env.teamTimezone);

  return (
    <div className="mx-auto w-full min-w-0 max-w-3xl">
      <BackLink href="/meetings">Meeting recaps</BackLink>
      <PageHeader
        title="Write up a meeting"
        description={
          <>
            The key points of a meeting nobody recorded. To record one instead, use{" "}
            <RecorderLink className="font-medium text-brand-700 underline underline-offset-2 hover:text-brand-800">
              Record a meeting
            </RecorderLink>
            .
          </>
        }
      />
      <MeetingRecapForm
        initial={{ title: "", meetingDate: today, categoryIds: [], keyPoints: "", transcript: "", durationSec: null }}
        categories={categories.map((c) => ({ id: c.id, name: c.name }))}
        today={today}
        cancelHref="/meetings"
      />
    </div>
  );
}
