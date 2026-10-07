import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { MeetingRecapForm } from "@/components/meetings/meeting-recap-form";
import { RetranscribeTool, SuggestKeyPointsTool } from "@/components/meetings/recap-edit-tools";
import { BackLink } from "@/components/tasks/back-link";
import { PageHeader } from "@/components/ui/page-header";
import { meetingRecapHref } from "@/lib/meeting-recaps";
import { requireActiveUser } from "@/server/auth/session";
import { getMeetingRecap, getMeetingRecapFormValues, getMeetingRecorderSetup } from "@/server/queries/meeting-recaps";

export const metadata: Metadata = { title: "Edit meeting recap" };

/**
 * Edit a recap's title, date, categories, key points, and transcript (people with admin access; the recording stays as
 * it is). Everyone else goes to the recap itself; a missing one is a 404. Tools: "Suggest key points" from the
 * transcript, and "Transcribe the recording again" while the recording is kept.
 */
export default async function EditMeetingRecapPage({ params }: PageProps<"/meetings/[id]/edit">) {
  const actor = await requireActiveUser();
  const { id } = await params;
  const values = await getMeetingRecapFormValues(actor, id);
  if (!values) {
    if (await getMeetingRecap(actor, id)) redirect(meetingRecapHref(id));
    notFound();
  }
  const [recap, setup] = await Promise.all([getMeetingRecap(actor, id), getMeetingRecorderSetup(actor)]);
  if (!recap || !setup) notFound();
  const back = meetingRecapHref(id);
  const audio = recap.audio;

  return (
    <div className="mx-auto w-full min-w-0 max-w-3xl">
      <BackLink href={back}>Back to the recap</BackLink>
      <PageHeader title="Edit meeting recap" description="Everyone sees the changes, marked “edited”. The recording stays as it is." />
      <MeetingRecapForm
        initial={values}
        categories={setup.categories}
        today={setup.today}
        cancelHref={back}
        keyPointsActions={<SuggestKeyPointsTool roster={setup.roster} />}
        transcriptActions={
          audio.state === "ready" ? (
            <RetranscribeTool source={{ partIds: audio.partIds, audioType: audio.audioType, audioBytes: audio.audioBytes }} />
          ) : undefined
        }
      />
    </div>
  );
}
