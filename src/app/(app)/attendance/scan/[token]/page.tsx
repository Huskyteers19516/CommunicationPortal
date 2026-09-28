import type { Metadata } from "next";
import type { ReactNode } from "react";
import { CheckInPanel } from "@/components/attendance/check-in-panel";
import { ScanCheckIn } from "@/components/attendance/scan-check-in";
import { Alert } from "@/components/ui/alert";
import { Card, CardBody } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { ATTENDANCE_KIND_LABELS, scanOrigins } from "@/lib/attendance";
import { formatDateOnly, todayInTimezone } from "@/lib/dates";
import { requireActiveUser } from "@/server/auth/session";
import { env } from "@/server/env";
import { getScanLanding } from "@/server/queries/attendance";
import { OTHER_DAY, QR_EXPIRED, QR_INVALID, SESSION_CLOSED } from "@/server/services/attendance";

// The token is in the address: don't send it to other sites as a referrer.
export const metadata: Metadata = { title: "Check in", referrer: "no-referrer" };

/** Request time, read outside of render. */
function requestTime(): Date {
  return new Date();
}

function Problem({ title, message, origins }: { title: string; message: string; origins: string[] }) {
  return (
    <div className="space-y-4">
      <Alert tone="error" title={title}>
        {message}
      </Alert>
      <CheckInPanel origins={origins} />
    </div>
  );
}

/**
 * Where the attendance QR code leads (signed-out people go to /login first and come back). Opening it only
 * reads; the check-in itself is sent once by <ScanCheckIn> after the page has loaded. <ScanCheckIn> is the same
 * element whether or not I'm already checked in, so the refresh after its own check-in (which now says "already
 * checked in") keeps it mounted and it shows its own result.
 */
export default async function ScanPage({ params }: PageProps<"/attendance/scan/[token]">) {
  const actor = await requireActiveUser();
  const { token } = await params;
  const now = requestTime();
  const today = todayInTimezone(env.teamTimezone, now);
  const landing = await getScanLanding(actor, token, { now, today });
  const origins = scanOrigins(env.appUrl);

  let content: ReactNode;
  let title = "Check in";
  if (landing.status === "invalid") {
    content = <Problem title="Couldn't check you in" message={QR_INVALID} origins={origins} />;
  } else {
    const { session } = landing;
    title = `Check in · ${ATTENDANCE_KIND_LABELS[session.kind]}`;
    if (session.checkedIn || (landing.status === "ok" && landing.isToday && session.open)) {
      content = <ScanCheckIn token={token} origins={origins} alreadyCheckedIn={session.checkedIn} />;
    } else if (landing.status === "expired") {
      content = <Problem title="This code expired" message={QR_EXPIRED} origins={origins} />;
    } else if (!landing.isToday) {
      content = <Problem title="Not today's code" message={OTHER_DAY} origins={origins} />;
    } else {
      content = <Problem title="Attendance is closed" message={SESSION_CLOSED} origins={origins} />;
    }
  }

  return (
    <>
      <PageHeader
        title={title}
        description={landing.status === "invalid" ? undefined : formatDateOnly(landing.session.date, today)}
      />
      <Card className="max-w-lg">
        <CardBody>{content}</CardBody>
      </Card>
    </>
  );
}
