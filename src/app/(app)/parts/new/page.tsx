import type { Metadata } from "next";
import { PartForm } from "@/components/parts/part-form";
import { BackLink } from "@/components/tasks/back-link";
import { PageHeader } from "@/components/ui/page-header";
import { requireActiveUser } from "@/server/auth/session";
import { getPartCategoryGroups } from "@/server/queries/parts";
import { createPartAction } from "../actions";

export const metadata: Metadata = { title: "Add a part" };

/** Anyone on the team can ask for a part; it goes to the end of the queue. */
export default async function NewPartPage() {
  await requireActiveUser();
  const categoryGroups = await getPartCategoryGroups();
  return (
    <>
      <BackLink href="/parts">Parts queue</BackLink>
      <PageHeader title="Add a part" description="It goes to the end of the queue. A Build leader can move it up if it's urgent." />
      <div className="max-w-3xl">
        <PartForm
          action={createPartAction}
          categoryGroups={categoryGroups}
          submitLabel="Add to the queue"
          initial={{
            name: "",
            process: "PRINT_3D",
            quantity: "1",
            material: "",
            fileUrl: "",
            notes: "",
            forText: "",
            neededBy: "",
          }}
        />
      </div>
    </>
  );
}
