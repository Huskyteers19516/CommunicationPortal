import { UserAvatar } from "@/components/app/user-avatar";
import { describeRole } from "@/components/app/user-chip";
import type { Role, Subteam } from "@/generated/prisma/enums";
import { cn } from "@/lib/cn";

/**
 * Avatar + full name + "Build member" line. Like UserChip, but long names wrap instead of being
 * cut off, so leaders can always tell who a progress row is about.
 */
export function PersonLabel({
  userId,
  name,
  role,
  subteam,
  className,
  nameClassName,
}: {
  /** Their portal photo is shown when they have one (else initials). */
  userId: string;
  name: string;
  role: Role;
  subteam: Subteam | null;
  className?: string;
  nameClassName?: string;
}) {
  return (
    <span className={cn("flex min-w-0 items-center gap-2.5", className)}>
      <UserAvatar userId={userId} name={name} />
      <span className="min-w-0 leading-tight">
        <span className={cn("block break-words text-sm font-medium text-ink-900", nameClassName)}>{name}</span>
        <span className="mt-0.5 block break-words text-xs text-ink-500">{describeRole(role, subteam)}</span>
      </span>
    </span>
  );
}
