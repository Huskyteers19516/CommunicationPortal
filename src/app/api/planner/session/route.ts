// GET /api/planner/session: the planner (served by this site at /planner/) asks who's signed in, to turn on its
// team library ("Save to team library", "Open from team library"). 200 {"user":{"name","canManageAll"},"teams":
// [{"number","name"}]} (the other teams in the league, by number), or a JSON 401 for everyone who isn't signed in
// and ACTIVE (the planner then works on its own, with paths in the browser). See src/server/planner-api.ts.
import { getPlannerSession } from "@/server/queries/planner-paths";
import { PLANNER_API_INACTIVE, plannerActor, plannerError, plannerErrorResponse, plannerJson } from "@/server/planner-api";

export async function GET(): Promise<Response> {
  const actor = await plannerActor();
  if (actor instanceof Response) return actor;
  try {
    const session = await getPlannerSession(actor);
    if (!session) return plannerError(401, PLANNER_API_INACTIVE);
    return plannerJson(session);
  } catch (e) {
    return plannerErrorResponse(e);
  }
}
