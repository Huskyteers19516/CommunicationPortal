// The attendance change log as CSV (admins only), with the page's filters. Cells a spreadsheet would run as formulas
// are escaped (src/server/attendance/report.ts: csvCell).
import type { NextRequest } from "next/server";
import { todayInTimezone } from "@/lib/dates";
import { attendanceChangesCsv, parseAttendanceChangeFilters } from "@/server/attendance/changes";
import { getCurrentUser } from "@/server/auth/session";
import { env } from "@/server/env";
import { plainResponse, redirectToLogin } from "@/server/files/respond";
import { listAttendanceChangesForCsv } from "@/server/queries/attendance-changes";

export async function GET(request: NextRequest): Promise<Response> {
  const user = await getCurrentUser();
  if (!user) return redirectToLogin(request);
  if (user.status !== "ACTIVE") return plainResponse(403, "Your account isn't active yet.");
  const filters = parseAttendanceChangeFilters(request.nextUrl.searchParams);
  const rows = await listAttendanceChangesForCsv(user, filters);
  if (!rows) return plainResponse(404, "That page doesn't exist.");
  const timeZone = env.teamTimezone;
  // A byte-order mark so Excel reads it as UTF-8 (names with accents).
  return new Response(`﻿${attendanceChangesCsv(rows, timeZone)}`, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="attendance-changes-${todayInTimezone(timeZone)}.csv"`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    },
  });
}
