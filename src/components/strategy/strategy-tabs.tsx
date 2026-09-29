import { LinkTabs } from "@/components/ui/link-tabs";

/**
 * The Strategy page's tabs: our own strategies (with the path planner), the other teams in the league, and the
 * paths saved from the planner (the team library). Every tab passes every count, so the tabs never change size
 * when switching.
 */
export function StrategyTabs({
  active,
  counts,
}: {
  active: "ours" | "teams" | "paths";
  counts: { ours: number; teams: number; paths: number } | null;
}) {
  return (
    <LinkTabs
      className="mb-5"
      tabs={[
        { href: "/strategy", label: "Our strategies", active: active === "ours", count: counts?.ours },
        { href: "/strategy/teams", label: "Other teams", active: active === "teams", count: counts?.teams },
        { href: "/strategy/paths", label: "Paths", active: active === "paths", count: counts?.paths },
      ]}
    />
  );
}
