import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AttendanceSettingsForm } from "@/components/attendance/settings-form";
import { BackLink } from "@/components/tasks/back-link";
import { Card, CardBody } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { requireActiveUser } from "@/server/auth/session";
import { canRunAttendance } from "@/server/permissions";
import { getAttendanceSettings } from "@/server/queries/attendance-settings";

export const metadata: Metadata = { title: "Attendance schedule" };

/** Teachers, the Business leader, the captain, mentors, and owners set the team's days. */
export default async function AttendanceSettingsPage() {
  const actor = await requireActiveUser();
  if (!canRunAttendance(actor)) redirect("/attendance");
  const settings = await getAttendanceSettings();
  return (
    <>
      <BackLink href="/attendance">Attendance</BackLink>
      <PageHeader title="Schedule" description="Which days people are asked “Coming?”, and when the two-week reports start." />
      <Card className="max-w-2xl">
        <CardBody>
          <AttendanceSettingsForm settings={settings} />
        </CardBody>
      </Card>
    </>
  );
}
