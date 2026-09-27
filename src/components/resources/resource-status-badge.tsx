import type { ResourceStatus } from "@/generated/prisma/enums";
import { RESOURCE_STATUS_LABELS } from "@/lib/constants";
import { Badge, type BadgeTone } from "../ui/badge";

const tone: Record<ResourceStatus, BadgeTone> = { PENDING: "yellow", APPROVED: "green", REJECTED: "red" };

/** "Waiting for approval" / "Approved" / "Sent back". */
export function ResourceStatusBadge({ status }: { status: ResourceStatus }) {
  return <Badge tone={tone[status]}>{RESOURCE_STATUS_LABELS[status]}</Badge>;
}
