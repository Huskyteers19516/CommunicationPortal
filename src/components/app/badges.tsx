import { CircleCheckBig, ShieldCheck, Tag } from "lucide-react";
import type { AccountStatus, AssignmentStatus, Priority, QuestionStatus, Role, Subteam } from "@/generated/prisma/enums";
import {
  ASSIGNMENT_STATUS_LABELS,
  PRIORITY_LABELS,
  QUESTION_STATUS_LABELS,
  ROLE_LABELS,
  STATUS_LABELS,
  SUBTEAM_LABELS,
} from "@/lib/constants";
import { cn } from "@/lib/cn";
import { type DateOnly, daysBetween, relativeDueLabel } from "@/lib/dates";
import { type SignupInfo, signupBadge } from "@/lib/signup";
import { Badge, type BadgeTone } from "../ui/badge";

const roleTone: Record<Role, BadgeTone> = {
  MEMBER: "gray",
  SOFTWARE_LEADER: "blue",
  BUILD_LEADER: "yellow",
  BUSINESS_LEADER: "purple",
  CAPTAIN: "brand",
  MENTOR: "green",
  TEACHER: "green",
};

export function RoleBadge({ role }: { role: Role }) {
  return <Badge tone={roleTone[role]}>{ROLE_LABELS[role]}</Badge>;
}

const subteamTone: Record<Subteam, BadgeTone> = { SOFTWARE: "blue", BUILD: "yellow", BUSINESS: "purple" };

/** Subteam chip; null renders "Whole team". */
export function SubteamBadge({ subteam }: { subteam: Subteam | null }) {
  if (!subteam) return <Badge tone="brand">Whole team</Badge>;
  return <Badge tone={subteamTone[subteam]}>{SUBTEAM_LABELS[subteam]}</Badge>;
}

/** Site owner (the `isAdmin` flag). Leaders, mentors, and teachers have admin access through their position. */
export function OwnerBadge() {
  return (
    <Badge tone="brand">
      <ShieldCheck className="size-3" aria-hidden />
      Owner
    </Badge>
  );
}

const accountTone: Record<AccountStatus, BadgeTone> = { PENDING: "yellow", ACTIVE: "green", REJECTED: "red", DISABLED: "gray" };

export function AccountStatusBadge({ status }: { status: AccountStatus }) {
  return <Badge tone={accountTone[status]}>{STATUS_LABELS[status]}</Badge>;
}

const assignmentTone: Record<AssignmentStatus, BadgeTone> = { TODO: "gray", SUBMITTED: "yellow", APPROVED: "green", REJECTED: "red" };

/** A checklist item's status. `closed`: not approved when its task was marked finished (no credit). */
export function AssignmentStatusBadge({ status, closed = false }: { status: AssignmentStatus; closed?: boolean }) {
  if (closed) return <Badge tone="gray">Closed</Badge>;
  return <Badge tone={assignmentTone[status]}>{ASSIGNMENT_STATUS_LABELS[status]}</Badge>;
}

/** "Finished" — a leader marked the whole task finished. Nothing while it's open. */
export function FinishedBadge({ finished }: { finished: boolean }) {
  if (!finished) return null;
  return (
    <Badge tone="green">
      <CircleCheckBig className="size-3" aria-hidden />
      Finished
    </Badge>
  );
}

const questionTone: Record<QuestionStatus, BadgeTone> = { OPEN: "yellow", ANSWERED: "blue", RESOLVED: "green" };

export function QuestionStatusBadge({ status }: { status: QuestionStatus }) {
  return <Badge tone={questionTone[status]}>{QUESTION_STATUS_LABELS[status]}</Badge>;
}

export function PriorityBadge({ priority }: { priority: Priority }) {
  if (priority === "NORMAL") return null;
  return <Badge tone={priority === "HIGH" ? "red" : "gray"}>{PRIORITY_LABELS[priority]} priority</Badge>;
}

/** "Due today" / "Due in 3 days" / "Overdue · 2 days ago"… red when overdue and still open. */
export function DueBadge({ due, today, done = false }: { due: DateOnly; today: DateOnly; done?: boolean }) {
  const diff = daysBetween(today, due);
  const label = relativeDueLabel(due, today);
  if (!done && diff < 0) return <Badge tone="red">Overdue · {label}</Badge>;
  const text = /^(Today|Tomorrow|Yesterday|In )/.test(label) ? `Due ${label.charAt(0).toLowerCase()}${label.slice(1)}` : `Due ${label}`;
  return <Badge tone={!done && diff === 0 ? "brand" : "gray"}>{text}</Badge>;
}

/** Task dashboard category, e.g. "Intake". Renders nothing without one. */
export function CategoryBadge({ name, className }: { name: string | null | undefined; className?: string }) {
  if (!name) return null;
  return (
    <Badge tone="gray" className={cn("max-w-full", className)}>
      <Tag className="size-3 shrink-0 text-ink-400" aria-hidden />
      <span className="sr-only">Category: </span>
      {/* Names can be one long word; let them wrap instead of widening the page. */}
      <span className="min-w-0 whitespace-normal wrap-anywhere">{name}</span>
    </Badge>
  );
}

/** "Sign-up · 2 of 3 spots taken" / "Sign-up · open" / "Sign-up · full" / "Sign-ups closed"; nothing for assigned tasks. */
export function SignupBadge(props: SignupInfo) {
  const badge = signupBadge(props);
  if (!badge) return null;
  return <Badge tone={badge.tone}>{badge.label}</Badge>;
}
