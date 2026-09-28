import { Pin } from "lucide-react";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { STRATEGY_KIND_LABELS, type StrategyKind } from "@/lib/constants";

const TONES: Record<StrategyKind, BadgeTone> = {
  AUTO: "brand",
  TELEOP: "blue",
  ENDGAME: "purple",
  MATCH: "yellow",
  SCOUTING: "green",
  OTHER: "gray",
};

/** "Autonomous", "Match plan"… */
export function StrategyKindBadge({ kind }: { kind: StrategyKind }) {
  return <Badge tone={TONES[kind]}>{STRATEGY_KIND_LABELS[kind]}</Badge>;
}

/** Shown on pinned strategies (listed first for everyone). */
export function PinnedBadge() {
  return (
    <Badge tone="gray">
      <Pin className="size-3" aria-hidden />
      Pinned
    </Badge>
  );
}
