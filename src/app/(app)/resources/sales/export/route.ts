// "Export to spreadsheet" on the money book: the rows matching the page's period and fundraiser as a CSV file.
// Every ACTIVE person can see the money book, so they can export it too (cells are escaped: csvCell).
import type { NextRequest } from "next/server";
import { todayInTimezone } from "@/lib/dates";
import { moneyBookToCsv, parseSalesEvent, parseSalesPeriod } from "@/lib/sales";
import { getCurrentUser } from "@/server/auth/session";
import { env } from "@/server/env";
import { plainResponse, redirectToLogin } from "@/server/files/respond";
import { getMoneyBookExport } from "@/server/queries/sales";

export async function GET(request: NextRequest): Promise<Response> {
  const user = await getCurrentUser();
  if (!user) return redirectToLogin(request);
  if (user.status !== "ACTIVE") return plainResponse(403, "Your account isn't active yet.");

  const sp = request.nextUrl.searchParams;
  const q = { period: parseSalesPeriod(sp.get("period")), event: parseSalesEvent(sp.get("event")) };
  const today = todayInTimezone(env.teamTimezone);
  const rows = await getMoneyBookExport(q, today);
  return new Response(moneyBookToCsv(rows), {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="money-book-${q.period}-${today}.csv"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
