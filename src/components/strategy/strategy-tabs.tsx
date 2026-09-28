import { LinkTabs } from "@/components/ui/link-tabs";

/**
 * The Strategy page's two tabs: our own strategies (with the path planner) and the other teams in the league.
 * Both pages pass both counts, so the tabs never change size when switching.
 */
export function StrategyTabs({ active, counts }: { active: "ours" | "teams"; counts: { ours: number; teams: number } | null }) {
  return (
    <LinkTabs
      className="mb-5"
      tabs={[
        { href: "/strategy", label: "Our strategies", active: active === "ours", count: counts?.ours },
        { href: "/strategy/teams", label: "Other teams", active: active === "teams", count: counts?.teams },
      ]}
    />
  );
}
