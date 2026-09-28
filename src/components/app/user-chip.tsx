import type { Role, Subteam } from "@/generated/prisma/enums";
import { describeRole } from "@/lib/constants";
import { cn } from "@/lib/cn";
import { Avatar } from "../ui/avatar";

/** Avatar + name + "Build Leader" / "Software member" line. */
export function UserChip({
  name,
  role,
  subteam,
  size = "md",
  className,
}: {
  name: string;
  role?: Role;
  subteam?: Subteam | null;
  size?: "sm" | "md";
  className?: string;
}) {
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-2.5", className)}>
      <Avatar name={name} size={size === "sm" ? "sm" : "md"} />
      <span className="min-w-0 leading-tight">
        <span className={cn("block truncate font-medium text-ink-900", size === "sm" ? "text-sm" : "text-sm")}>{name}</span>
        {role && <span className="block truncate text-xs text-ink-500">{describeRole(role, subteam ?? null)}</span>}
      </span>
    </span>
  );
}

// Lives in lib/constants (queries use it too); re-exported here for the components that already import it from here.
export { describeRole };
