// A two-week attendance report as CSV (staff only). Cells a spreadsheet would run as formulas are escaped
// (src/server/attendance/report.ts: csvCell).
import type { NextRequest } from "next/server";
import { parseReportIndex } from "@/lib/attendance";
import { todayInTimezone } from "@/lib/dates";
import { reportChangesCsv } from "@/server/attendance/changes";
import { reportCsv } from "@/server/attendance/report";
import { getCurrentUser } from "@/server/auth/session";
import { env } from "@/server/env";
import { plainResponse, redirectToLogin } from "@/server/files/respond";
import { canPlanAttendance } from "@/server/permissions";
import { getAttendanceReport } from "@/server/queries/attendance";
import { CHANGES_CSV_MAX } from "@/server/queries/attendance-changes";

export async function GET(request: NextRequest, ctx: RouteContext<"/attendance/reports/[index]/csv">): Promise<Response> {
  const user = await getCurrentUser();
  if (!user) return redirectToLogin(request);
  if (user.status !== "ACTIVE") return plainResponse(403, "Your account isn't active yet.");
  if (!canPlanAttendance(user)) return plainResponse(404, "That report doesn't exist.");

  const { index: raw } = await ctx.params;
  const index = parseReportIndex(raw);
  const timeZone = env.teamTimezone;
  const report =
    index === null ? null : await getAttendanceReport(user, index, { today: todayInTimezone(timeZone), timeZone, changesMax: CHANGES_CSV_MAX });
  if (!report) return plainResponse(404, "That report doesn't exist.");

  // A byte-order mark so Excel reads it as UTF-8 (names with accents). Admins also get "Changes by admins".
  const changes = report.changes ? reportChangesCsv(report.changes.rows, report.changes.total, timeZone) : "";
  const body = `﻿${reportCsv(report.data, report.period, report)}${changes}`;
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="attendance-${report.period.start}-to-${report.period.end}.csv"`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    },
  });
}
