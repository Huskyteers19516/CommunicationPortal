// One path in the team library, for the planner served by this site (/planner/). See src/server/planner-api.ts for
// the rules every planner API route follows (JSON only, ACTIVE people only, no-store, the cross-site checks on
// changes).
// - GET: open it — 200 {"id","name","notes","team":{"number","name"}|null,"data" (the .pp JSON text),"version"
//   (updatedAt, ISO),"canEdit"}, or 404.
// - PUT {"name"?,"notes"?,"teamNumber"?,"data"?,"version"}: save changes — 200 {"version","name","notes","team"}
//   (the path as it is now: a save that only sends the data keeps someone else's rename, and the planner shows that),
//   or 409 {"error","current":{"version","updatedByName"}} when someone saved it after `version`.
// - DELETE: remove it — 204.
import type { NextRequest } from "next/server";
import { getPlannerPath } from "@/server/queries/planner-paths";
import {
  plannerActor,
  plannerContext,
  plannerCsrfResponse,
  plannerError,
  plannerErrorResponse,
  plannerJson,
  plannerNoContent,
  readPlannerJson,
} from "@/server/planner-api";
import { deletePlannerPath, PLANNER_PATH_NOT_FOUND, updatePlannerPath } from "@/server/services/planner-paths";

type Ctx = RouteContext<"/api/planner/paths/[id]">;

export async function GET(_request: NextRequest, ctx: Ctx): Promise<Response> {
  const actor = await plannerActor();
  if (actor instanceof Response) return actor;
  const { id } = await ctx.params;
  try {
    const path = await getPlannerPath(actor, id);
    if (!path) return plannerError(404, PLANNER_PATH_NOT_FOUND);
    return plannerJson({
      id: path.id,
      name: path.name,
      notes: path.notes,
      team: path.team,
      data: path.data,
      version: path.version,
      canEdit: path.canEdit,
    });
  } catch (e) {
    return plannerErrorResponse(e);
  }
}

export async function PUT(request: NextRequest, ctx: Ctx): Promise<Response> {
  const forged = plannerCsrfResponse(request);
  if (forged) return forged;
  const actor = await plannerActor();
  if (actor instanceof Response) return actor;
  const { id } = await ctx.params;
  const body = await readPlannerJson(request);
  if (body instanceof Response) return body;
  try {
    // Only the fields the planner sends change (a missing one stays as it is).
    const saved = await updatePlannerPath(plannerContext(actor), {
      pathId: id,
      name: body.name,
      notes: body.notes,
      teamNumber: body.teamNumber,
      data: body.data,
      version: body.version,
    });
    return plannerJson({ version: saved.version, name: saved.name, notes: saved.notes, team: saved.team });
  } catch (e) {
    return plannerErrorResponse(e);
  }
}

export async function DELETE(request: NextRequest, ctx: Ctx): Promise<Response> {
  const forged = plannerCsrfResponse(request);
  if (forged) return forged;
  const actor = await plannerActor();
  if (actor instanceof Response) return actor;
  const { id } = await ctx.params;
  try {
    await deletePlannerPath(plannerContext(actor), { pathId: id });
    return plannerNoContent();
  } catch (e) {
    return plannerErrorResponse(e);
  }
}
