// The team library, for the planner served by this site (/planner/). See src/server/planner-api.ts for the rules
// every planner API route follows (JSON only, ACTIVE people only, no-store, the cross-site checks on changes).
// - GET /api/planner/paths?team=all|ours|<number>&q=<search>: the newest saved paths (at most 200) —
//   200 {"paths":[{"id","name","notes","team":{"number","name"}|null,"size","updatedAt","updatedByName",
//   "createdByName","canEdit"}]}.
// - POST /api/planner/paths {"name","notes"?,"teamNumber"?,"data"}: save a new path — 201 {"id","version"}.
import type { NextRequest } from "next/server";
import { parsePlannerPathTeamFilter } from "@/lib/planner-paths";
import { listPlannerPaths, type PlannerPathRow } from "@/server/queries/planner-paths";
import {
  PLANNER_API_INACTIVE,
  plannerActor,
  plannerContext,
  plannerCsrfResponse,
  plannerError,
  plannerErrorResponse,
  plannerJson,
  readPlannerJson,
} from "@/server/planner-api";
import { createPlannerPath } from "@/server/services/planner-paths";

/** A list row as the planner gets it. */
function toJson(p: PlannerPathRow) {
  return {
    id: p.id,
    name: p.name,
    notes: p.notes,
    team: p.team,
    size: p.size,
    updatedAt: p.updatedAt.toISOString(),
    updatedByName: p.updatedByName,
    createdByName: p.createdByName,
    canEdit: p.canEdit,
  };
}

export async function GET(request: NextRequest): Promise<Response> {
  const actor = await plannerActor();
  if (actor instanceof Response) return actor;
  const sp = request.nextUrl.searchParams;
  const team = parsePlannerPathTeamFilter(sp.get("team"));
  if (team === null) {
    const message = "Pick whose paths to list: all, ours, or another team's number.";
    return plannerError(400, message, { team: message });
  }
  try {
    const list = await listPlannerPaths(actor, { team, q: sp.get("q") ?? undefined });
    if (!list) return plannerError(401, PLANNER_API_INACTIVE);
    return plannerJson({ paths: list.paths.map(toJson) });
  } catch (e) {
    return plannerErrorResponse(e);
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  const forged = plannerCsrfResponse(request);
  if (forged) return forged;
  const actor = await plannerActor();
  if (actor instanceof Response) return actor;
  const body = await readPlannerJson(request);
  if (body instanceof Response) return body;
  try {
    const { id, version } = await createPlannerPath(plannerContext(actor), {
      name: body.name,
      notes: body.notes,
      teamNumber: body.teamNumber,
      data: body.data,
    });
    return plannerJson({ id, version }, 201);
  } catch (e) {
    return plannerErrorResponse(e);
  }
}
