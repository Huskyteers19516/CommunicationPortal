"use client";

import { ChevronDown, UserCheck } from "lucide-react";
import { useActionState } from "react";
import { approveUserAction, rejectUserAction } from "@/app/(app)/admin/actions";
import { describeRole } from "@/components/app/user-chip";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { CheckboxField } from "@/components/ui/field";
import { FormMessage } from "@/components/ui/form-message";
import { SubmitButton } from "@/components/ui/submit-button";
import type { Role, Subteam } from "@/generated/prisma/enums";
import { type ActionState, initialActionState } from "@/lib/action-state";
import { ROLE_LABELS } from "@/lib/constants";
import { PositionFields, type SeatInfo } from "./position-fields";

export interface PendingCardUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  subteam: Subteam | null;
  /** Pre-formatted on the server ("2 h ago") so client and server render the same text. */
  registeredAgo: string;
  registeredAt: string;
  /** The viewer may approve/reject this sign-up (leaders: up to their own rank; see canManageAccount). */
  canDecide: boolean;
}

/** Pending sign-ups with Approve / Change position / Reject. One shared action state keeps messages visible after a card disappears. */
export function PendingList({
  users,
  total,
  seats,
  roles,
}: {
  users: PendingCardUser[];
  total: number;
  seats: Partial<Record<Role, SeatInfo>>;
  /** Positions the viewer may approve someone as. Default: all. */
  roles?: Role[];
}) {
  const [approveState, approveAction] = useActionState(approveUserAction, initialActionState);
  const [rejectState, rejectAction] = useActionState(rejectUserAction, initialActionState);
  const latest = (approveState?.nonce ?? 0) >= (rejectState?.nonce ?? 0) ? approveState : rejectState;
  const failedFor = latest && !latest.ok ? latest.values?.userId : undefined;
  const showOnCard = !!failedFor && users.some((u) => u.id === failedFor);

  return (
    <div className="space-y-3">
      {!showOnCard && <FormMessage state={latest} />}
      {users.length === 0 ? (
        <Card>
          <EmptyState
            icon={UserCheck}
            title="No one is waiting for approval."
            description="New leader, captain, mentor, and teacher sign-ups will show up here."
          />
        </Card>
      ) : (
        <>
          {users.map((u) => (
            <PendingCard
              key={u.id}
              user={u}
              seats={seats}
              roles={roles}
              state={failedFor === u.id ? latest : null}
              approveAction={approveAction}
              rejectAction={rejectAction}
            />
          ))}
          {total > users.length && (
            <p className="text-center text-sm text-ink-500">
              Showing the {users.length} oldest of {total} sign-ups. Approve or reject these to see the rest.
            </p>
          )}
        </>
      )}
    </div>
  );
}

function PendingCard({
  user,
  seats,
  roles,
  state,
  approveAction,
  rejectAction,
}: {
  user: PendingCardUser;
  seats: Partial<Record<Role, SeatInfo>>;
  roles?: Role[];
  state: ActionState;
  approveAction: (formData: FormData) => void;
  rejectAction: (formData: FormData) => void;
}) {
  const formId = `approve-${user.id}`;
  const seat = seats[user.role];
  const requestedFull = !!seat && seat.filled >= seat.limit;
  const values = state?.values;

  return (
    <Card>
      <CardBody className="space-y-4">
        <div className="flex items-start gap-3">
          <Avatar name={user.name} />
          <div className="min-w-0 flex-1">
            <p className="truncate font-semibold text-ink-900">{user.name}</p>
            <p className="truncate text-sm text-ink-500">{user.email}</p>
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-ink-600">
              <span>
                Wants to be <span className="font-medium text-ink-900">{describeRole(user.role, user.subteam)}</span>
              </span>
              <time title={user.registeredAt} className="whitespace-nowrap">
                Registered {user.registeredAgo}
              </time>
            </div>
            {requestedFull && (
              <Badge tone="yellow" className="mt-2">
                {ROLE_LABELS[user.role]} seats full ({seat.filled}/{seat.limit})
              </Badge>
            )}
          </div>
        </div>

        {state && <FormMessage state={state} />}

        {!user.canDecide ? (
          <p className="rounded-lg bg-ink-50 px-3 py-2 text-sm text-ink-600">
            Only the captain, a mentor, a teacher, or an owner can approve a {ROLE_LABELS[user.role]}.
          </p>
        ) : (
          <>
            <details className="group rounded-lg border border-ink-200 bg-ink-50/60" open={requestedFull || !!state?.fieldErrors?.subteam}>
              <summary className="flex min-h-10 cursor-pointer list-none items-center justify-between gap-2 px-3 py-2 text-sm font-medium text-ink-700 [&::-webkit-details-marker]:hidden">
                Change position
                <ChevronDown className="size-4 text-ink-400 transition-transform group-open:rotate-180" aria-hidden />
              </summary>
              <div className="space-y-3 border-t border-ink-200 px-3 pb-3 pt-3">
                <PositionFields
                  key={state?.nonce ?? "initial"}
                  idPrefix={formId}
                  form={formId}
                  defaultRole={(values?.role as Role | undefined) ?? user.role}
                  defaultSubteam={(values?.subteam as Subteam | undefined) ?? user.subteam}
                  errors={state?.fieldErrors}
                  seats={seats}
                  roles={roles}
                />
                <CheckboxField
                  form={formId}
                  name="overrideSeatLimit"
                  label="Approve anyway (over seat limit)"
                  description="Only if you really want more people in this position than planned."
                />
              </div>
            </details>

            <div className="flex flex-wrap gap-2">
              <form id={formId} action={approveAction} className="flex-1 sm:flex-none">
                <input type="hidden" name="userId" value={user.id} />
                <SubmitButton className="w-full sm:w-auto" pendingText="Approving…">
                  Approve
                </SubmitButton>
              </form>
              <form action={rejectAction} className="flex-1 sm:flex-none">
                <input type="hidden" name="userId" value={user.id} />
                <SubmitButton
                  variant="secondary"
                  className="w-full text-red-700 sm:w-auto"
                  pendingText="Rejecting…"
                  confirm={`Reject ${user.name}'s sign-up? They won't be able to use the portal.`}
                >
                  Reject
                </SubmitButton>
              </form>
            </div>
          </>
        )}
      </CardBody>
    </Card>
  );
}
