"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { ActionState } from "@/lib/action-state";
import { parsePlannerPathTeamFilter, plannerPathTeamParam } from "@/lib/planner-paths";
import { cleanSearchText } from "@/lib/search";
import { formDataToObject, runAction } from "@/server/action";
import { getServiceContext } from "@/server/context";
import { ConflictError } from "@/server/errors";
import { PLANNER_PATH_SEARCH_MAX } from "@/server/queries/planner-paths";
import { deletePlannerPath, updatePlannerPath } from "@/server/services/planner-paths";

/** The Paths tab, with the filters it had (checked again: only a team filter and a search) and a notice. */
function pathsListHref(input: Record<string, unknown>, notice: "saved" | "removed"): string {
  const sp = new URLSearchParams();
  const team = parsePlannerPathTeamFilter(typeof input.team === "string" ? input.team : null);
  const param = team === null ? null : plannerPathTeamParam(team);
  if (param) sp.set("team", param);
  const q = cleanSearchText(typeof input.q === "string" ? input.q : undefined, PLANNER_PATH_SEARCH_MAX);
  if (q) sp.set("q", q);
  sp.set(notice, "1");
  return `/strategy/paths?${sp.toString()}`;
}

/**
 * Rename a saved path, change its notes, or whose it is (the edit form sends all three, with the `version` it
 * loaded). Then back to where it came from: the team's page (`from=team`, the team it now belongs to) or the Paths
 * tab. After a conflict the page is refreshed, so the form now carries the newer version: saving again replaces it.
 */
export async function updatePlannerPathAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(
    async () => {
      const input = formDataToObject(formData);
      let teamNumber: number | null;
      try {
        const ctx = await getServiceContext();
        ({ teamNumber } = await updatePlannerPath(ctx, {
          pathId: input.pathId,
          version: input.version,
          name: input.name,
          notes: input.notes ?? "",
          teamNumber: input.teamNumber ?? "",
        }));
      } catch (e) {
        if (e instanceof ConflictError) revalidatePath("/", "layout");
        throw e;
      }
      revalidatePath("/", "layout");
      redirect(input.from === "team" && teamNumber !== null ? `/strategy/teams/${teamNumber}?pathSaved=1` : "/strategy/paths?saved=1");
    },
    { formData },
  );
}

/** Remove a saved path, then back to the list it was on (the team's page, or the Paths tab with its filters). */
export async function deletePlannerPathAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(async () => {
    const input = formDataToObject(formData);
    const ctx = await getServiceContext();
    const { teamNumber } = await deletePlannerPath(ctx, { pathId: input.pathId });
    revalidatePath("/", "layout");
    redirect(input.from === "team" && teamNumber !== null ? `/strategy/teams/${teamNumber}?pathRemoved=1` : pathsListHref(input, "removed"));
  });
}
