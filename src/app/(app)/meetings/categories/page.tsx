import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { MeetingCategoryList } from "@/components/meetings/meeting-category-list";
import { BackLink } from "@/components/tasks/back-link";
import { Card, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { MEETING_CATEGORIES_MAX } from "@/lib/meeting-recaps";
import { requireActiveUser } from "@/server/auth/session";
import { canManageMeetingRecaps } from "@/server/permissions";
import { listMeetingCategories } from "@/server/queries/meeting-recaps";

export const metadata: Metadata = { title: "Meeting categories" };

/** The team's one list of meeting categories (people with admin access). Everyone else goes to the recaps. */
export default async function MeetingCategoriesPage() {
  const actor = await requireActiveUser();
  if (!canManageMeetingRecaps(actor)) redirect("/meetings");
  const categories = await listMeetingCategories(actor);

  return (
    <div className="mx-auto w-full max-w-3xl">
      <BackLink href="/meetings">Meeting recaps</BackLink>
      <PageHeader
        title="Meeting categories"
        description="The kinds of meetings, e.g. Build or Strategy. A recap can have up to 5, and the list filters by them."
      />
      <Card>
        <CardHeader
          title="Categories"
          description={`${categories.length} of ${MEETING_CATEGORIES_MAX} · shown A–Z everywhere · deleting one keeps its recaps`}
        />
        <MeetingCategoryList categories={categories} />
      </Card>
    </div>
  );
}
