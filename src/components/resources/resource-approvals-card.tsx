import { BookMarked } from "lucide-react";
import { ButtonLink } from "../ui/button";
import { Card, CardBody, CardHeader } from "../ui/card";

/** Admin → Approvals: how many members' resources wait, with a link to the queue on the Resources page. */
export function ResourceApprovalsCard({ count }: { count: number }) {
  return (
    <Card>
      <CardHeader title="Resources waiting for approval" description="Links and files members shared." />
      <CardBody className="flex flex-wrap items-center justify-between gap-3">
        <p className="flex items-center gap-2 text-sm text-ink-700">
          <BookMarked className="size-4 shrink-0 text-ink-400" aria-hidden />
          {count === 0 ? "Nothing waiting right now." : `${count} ${count === 1 ? "resource is" : "resources are"} waiting.`}
        </p>
        {count > 0 && (
          <ButtonLink href="/resources#pending" variant="secondary">
            Review resources
          </ButtonLink>
        )}
      </CardBody>
    </Card>
  );
}
