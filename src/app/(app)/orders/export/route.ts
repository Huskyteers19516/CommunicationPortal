// "Export to spreadsheet" on the order list: the items matching the page's filters as a CSV file (opens in
// Google Sheets / Excel). Every ACTIVE person can see the order list, so they can export it too. Cells that a
// spreadsheet would run as a formula are escaped (see csvCell in src/lib/orders.ts).
import type { NextRequest } from "next/server";
import { todayInTimezone } from "@/lib/dates";
import { type OrderQuery, ordersExportFilename, ordersToCsv, parseOrderFilter, parseOrderFor } from "@/lib/orders";
import { getCurrentUser } from "@/server/auth/session";
import { env } from "@/server/env";
import { plainResponse, redirectToLogin } from "@/server/files/respond";
import { listOrdersForExport } from "@/server/queries/orders";

export async function GET(request: NextRequest): Promise<Response> {
  const user = await getCurrentUser();
  if (!user) return redirectToLogin(request);
  if (user.status !== "ACTIVE") return plainResponse(403, "Your account isn't active yet.");

  const sp = request.nextUrl.searchParams;
  // No filter = everything (the page always says which one it shows).
  const q: OrderQuery = {
    filter: parseOrderFilter(sp.get("filter"), "all"),
    for: parseOrderFor(sp.get("for")),
    mine: sp.get("mine") === "1",
  };
  const items = await listOrdersForExport(user, q);
  // The name says which part of the list it is ("order-list-software-open-2026-09-24.csv").
  const filename = ordersExportFilename(q, todayInTimezone(env.teamTimezone));
  return new Response(ordersToCsv(items, env.teamTimezone), {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
