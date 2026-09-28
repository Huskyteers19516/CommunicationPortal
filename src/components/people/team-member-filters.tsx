import { Search } from "lucide-react";
import { AutoSubmitSelect } from "@/components/ui/auto-submit-select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { ROLES, ROLE_LABELS, SUBTEAMS, SUBTEAM_LABELS } from "@/lib/constants";
import { TEAM_MEMBER_SEARCH_MAX, type TeamMemberFilters as Filters } from "@/server/queries/people";

/**
 * Plain GET form (like Admin → People) so filters live in the URL: shareable, back-button friendly, no JS needed.
 * Picking a position or subteam applies it right away; Filter (or Enter) sends the search.
 */
export function TeamMemberFilters({ filters }: { filters: Filters }) {
  return (
    <form method="get" action="/people" role="search" className="flex flex-col gap-2 lg:flex-row">
      <div className="relative lg:flex-1">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-400" aria-hidden />
        <Input
          type="search"
          name="q"
          defaultValue={filters.q ?? ""}
          placeholder="Search name, email, or position"
          aria-label="Search name, email, or position"
          maxLength={TEAM_MEMBER_SEARCH_MAX}
          autoComplete="off"
          enterKeyHint="search"
          className="pl-9"
        />
      </div>
      {/* One column below 360px so the menus' text isn't cut off. */}
      <div className="grid grid-cols-1 gap-2 min-[360px]:grid-cols-2 sm:grid-cols-3 lg:flex">
        <AutoSubmitSelect name="role" defaultValue={filters.role ?? ""} aria-label="Position" className="lg:w-44">
          <option value="">All positions</option>
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABELS[r]}
            </option>
          ))}
        </AutoSubmitSelect>
        <AutoSubmitSelect name="subteam" defaultValue={filters.subteam ?? ""} aria-label="Subteam" className="lg:w-40">
          <option value="">All subteams</option>
          {SUBTEAMS.map((s) => (
            <option key={s} value={s}>
              {SUBTEAM_LABELS[s]}
            </option>
          ))}
        </AutoSubmitSelect>
        <Button type="submit" variant="secondary" className="min-[360px]:col-span-2 sm:col-span-1">
          Filter
        </Button>
      </div>
    </form>
  );
}
