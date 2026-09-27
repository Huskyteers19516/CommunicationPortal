"use client";

import { UserMinus, Users } from "lucide-react";
import { useActionState, useEffect, useRef } from "react";
import { removeVolunteerAction } from "@/app/(app)/fundraising/actions";
import { initialActionState } from "@/lib/action-state";
import { cn } from "@/lib/cn";
import { timeAgo } from "@/lib/dates";
import { helpersLine } from "@/lib/fundraising";
import type { FundraiserDetail } from "@/server/queries/fundraising";
import { describeRole } from "../app/user-chip";
import { Avatar } from "../ui/avatar";
import { Card } from "../ui/card";
import { EmptyState } from "../ui/empty-state";
import { SubmitButton } from "../ui/submit-button";
import { VolunteerButtons } from "./volunteer-buttons";

/**
 * "Helpers" on a fundraiser's page: "I'll help" / "Leave", and everyone who signed up. Managers can take
 * someone off the list; the row goes away, so focus moves to the card's heading and a status line says who.
 */
export function HelpersCard({
  fundraiser: f,
  nowIso,
  timeZone,
}: {
  fundraiser: Pick<
    FundraiserDetail,
    | "id"
    | "name"
    | "status"
    | "helpers"
    | "volunteerCount"
    | "volunteerLimit"
    | "closedReason"
    | "datesPassed"
    | "canVolunteer"
    | "canLeave"
    | "canManage"
  >;
  /** Request time and team timezone (server and browser render the same "2 h ago"). */
  nowIso: string;
  timeZone: string;
}) {
  const [state, removeAction] = useActionState(removeVolunteerAction, initialActionState);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (state) headingRef.current?.focus();
  }, [state]);

  const now = new Date(nowIso);
  return (
    <Card id="helpers" className="scroll-mt-24">
      <div className="border-b border-ink-100 px-4 py-3 sm:px-5">
        <h2 ref={headingRef} tabIndex={-1} className="text-base font-semibold text-ink-900">
          Helpers ({f.volunteerCount})
        </h2>
        <p className="mt-0.5 text-sm text-ink-500">{helpersLine(f)}</p>
        {f.datesPassed && (
          <p className="mt-0.5 text-sm text-ink-500">
            Its dates have passed, so sign-ups are closed.{f.canManage && " Mark it Done once the money is in."}
          </p>
        )}
        <VolunteerButtons fundraiser={f} className="mt-3" />
        <p role="status" className={cn("text-xs font-medium text-brand-700", state?.ok && "mt-2")}>
          {state?.ok ? state.message : ""}
        </p>
        {state && !state.ok && (
          <p role="alert" className="mt-2 text-sm text-red-600">
            {state.message}
          </p>
        )}
      </div>
      {f.helpers.length === 0 ? (
        <EmptyState
          icon={Users}
          title="Nobody has signed up yet"
          description={f.canVolunteer ? "Tap “I'll help” to be the first." : undefined}
        />
      ) : (
        <ul className="divide-y divide-ink-100">
          {f.helpers.map((h) => (
            <li key={h.id} className="flex min-h-14 items-center gap-3 px-4 py-2.5 sm:px-5">
              <Avatar name={h.name} />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-ink-900 wrap-anywhere">
                  {h.name}
                  {h.isMe && <span className="font-normal text-ink-500"> (you)</span>}
                </p>
                <p className="text-xs text-ink-500">
                  {describeRole(h.role, h.subteam)} · signed up {timeAgo(new Date(h.signedUpAt), now, timeZone)}
                </p>
              </div>
              {f.canManage && (
                <form action={removeAction} className="inline-flex shrink-0">
                  <input type="hidden" name="fundraiserId" value={f.id} />
                  <input type="hidden" name="userId" value={h.id} />
                  <SubmitButton
                    variant="ghost"
                    size="icon"
                    className="sm:w-auto sm:gap-2 sm:px-3"
                    confirm={`Take ${h.name} off the helper list for “${f.name}”?`}
                    aria-label={`Take ${h.name} off the helper list`}
                    title="Take off the list"
                  >
                    <UserMinus className="size-4 shrink-0 text-red-600" aria-hidden />
                    <span className="hidden sm:inline">Remove</span>
                  </SubmitButton>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
