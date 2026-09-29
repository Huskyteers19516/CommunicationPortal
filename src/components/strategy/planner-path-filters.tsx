import { Search } from "lucide-react";
import { AutoSubmitSelect } from "@/components/ui/auto-submit-select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { type PlannerPathTeamFilter, plannerPathTeamParam } from "@/lib/planner-paths";
import { PLANNER_PATH_SEARCH_MAX, type PlannerPathTeam } from "@/server/queries/planner-paths";

/**
 * Plain GET form, so the filters live in the URL (shareable, back-button friendly, no JS needed): search the name
 * and notes; picking whose paths applies right away; Search (or Enter) sends the search.
 */
export function PlannerPathFilters({ team, q, teams }: { team: PlannerPathTeamFilter; q: string; teams: PlannerPathTeam[] }) {
  return (
    <form method="get" action="/strategy/paths" role="search" className="flex flex-col gap-2 sm:flex-row">
      <div className="relative min-w-0 sm:flex-1">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-400" aria-hidden />
        <Input
          id="path-search"
          type="search"
          name="q"
          defaultValue={q}
          placeholder="Search names and notes"
          aria-label="Search saved paths by name or notes"
          maxLength={PLANNER_PATH_SEARCH_MAX}
          autoComplete="off"
          enterKeyHint="search"
          className="pl-9"
        />
      </div>
      <div className="grid grid-cols-1 gap-2 min-[360px]:grid-cols-[minmax(0,1fr)_auto] sm:flex">
        <AutoSubmitSelect name="team" defaultValue={plannerPathTeamParam(team) ?? ""} aria-label="Whose paths" className="min-w-0 sm:w-60">
          <option value="">All paths</option>
          <option value="ours">Ours</option>
          {teams.map((t) => (
            <option key={t.number} value={String(t.number)}>
              {t.number} · {t.name}
            </option>
          ))}
        </AutoSubmitSelect>
        <Button type="submit" variant="secondary">
          Search
        </Button>
      </div>
    </form>
  );
}
