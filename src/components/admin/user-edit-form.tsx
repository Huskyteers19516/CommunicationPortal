"use client";

import { useActionState } from "react";
import { updateUserAction } from "@/app/(app)/admin/actions";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { CheckboxField, Field, FieldError, Input, Select } from "@/components/ui/field";
import { FormMessage } from "@/components/ui/form-message";
import { SubmitButton } from "@/components/ui/submit-button";
import { AccountStatus, type Role, type Subteam } from "@/generated/prisma/enums";
import { initialActionState } from "@/lib/action-state";
import { LIMITS, STATUS_LABELS } from "@/lib/constants";
import { describeRole } from "@/components/app/user-chip";
import { PositionFields, type SeatInfo } from "./position-fields";

const STATUSES = Object.values(AccountStatus);

/** A field this admin can't change here, shown as text (the value is sent by a hidden input). */
function LockedField({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="space-y-1.5">
      <p className="text-sm font-medium text-ink-800">{label}</p>
      <p className="text-sm text-ink-900">{value}</p>
      <p className="text-xs text-ink-500">{hint}</p>
    </div>
  );
}

export interface EditableUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  subteam: Subteam | null;
  status: AccountStatus;
  isAdmin: boolean;
}

export function UserEditForm({
  user,
  isSelf,
  inAdminEmails = false,
  seats,
  actorIsOwner = false,
  readOnly = false,
  roles,
}: {
  user: EditableUser;
  isSelf: boolean;
  /** The email is listed in ADMIN_EMAILS (shows a short explanation next to the Owner checkbox). */
  inAdminEmails?: boolean;
  seats: Partial<Record<Role, SeatInfo>>;
  /** Only owners see (and can change) the Owner checkbox. */
  actorIsOwner?: boolean;
  /** An account the viewer can't change (an owner's, or one ranked at/above them): shown read-only. */
  readOnly?: boolean;
  /** Positions this admin may give (the person's current one is always listed). Default: all. */
  roles?: Role[];
}) {
  const [state, formAction] = useActionState(updateUserAction, initialActionState);
  // After a failed save, show what was submitted; after a successful one (no values), the saved values.
  const v = state?.values;
  const err = state?.fieldErrors;
  const isAdminDefault = v ? v.isAdmin === "on" : user.isAdmin;
  // Leaders, mentors, and teachers get Admin through their position, so they can't change their own.
  const lockPosition = isSelf && !actorIsOwner;
  const statusDefault = (v?.status as AccountStatus | undefined) ?? user.status;
  // "Approve anyway" only matters when this form can change someone's position or status.
  const showSeatOverride = !readOnly && !lockPosition;
  const adminNote = "Leaders, the captain, mentors, and teachers have admin access through their position.";

  return (
    <Card>
      <CardHeader title="Profile & access" />
      <CardBody>
        <form action={formAction} className="space-y-5" noValidate>
          <input type="hidden" name="userId" value={user.id} />
          {isSelf && <input type="hidden" name="status" value="ACTIVE" />}
          {isSelf && actorIsOwner && <input type="hidden" name="isAdmin" value="on" />}
          <FormMessage state={state} />

          {/*
            Remount every field after each save. React resets a form after its action runs but never
            re-applies a changed <select> defaultValue, so without this the Status select would snap back
            to its first value and the next save would silently undo the last one (or skip the seat check
            after "Approve anyway"). It must keep working for two saves in a row.
          */}
          <fieldset key={state?.nonce ?? "initial"} disabled={readOnly} className="min-w-0 space-y-5">
            <Field label="Name" htmlFor="edit-name" error={err?.name}>
              <Input
                id="edit-name"
                name="name"
                defaultValue={v?.name ?? user.name}
                maxLength={LIMITS.nameMax}
                autoComplete="off"
                required
                invalid={!!err?.name}
              />
            </Field>

            <Field
              label="Email"
              htmlFor="edit-email"
              error={err?.email}
              hint={
                actorIsOwner || isSelf
                  ? "Used to sign in and for notifications. Changing it cancels any reset link already sent."
                  : "Used to sign in. Only an owner can change someone else's email."
              }
            >
              <Input
                id="edit-email"
                name="email"
                type="email"
                readOnly={!actorIsOwner && !isSelf}
                defaultValue={v?.email ?? user.email}
                maxLength={LIMITS.emailMax}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                required
                invalid={!!err?.email}
              />
            </Field>

            {lockPosition ? (
              <>
                <input type="hidden" name="role" value={user.role} />
                {user.subteam && <input type="hidden" name="subteam" value={user.subteam} />}
                <LockedField
                  label="Position"
                  value={describeRole(user.role, user.subteam)}
                  hint="Ask another admin to change your own position."
                />
              </>
            ) : (
              <PositionFields
                idPrefix="edit"
                defaultRole={(v?.role as Role | undefined) ?? user.role}
                defaultSubteam={(v?.subteam as Subteam | undefined) ?? user.subteam}
                errors={err}
                seats={seats}
                roles={roles}
              />
            )}

            {isSelf ? (
              // Sent as ACTIVE by the hidden input above.
              <LockedField label="Account status" value={STATUS_LABELS.ACTIVE} hint="Your own account always stays active." />
            ) : (
              <Field
                label="Account status"
                htmlFor="edit-status"
                error={err?.status}
                hint="Disabled and rejected people are signed out right away."
              >
                <Select id="edit-status" name="status" defaultValue={statusDefault} invalid={!!err?.status}>
                  {STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {STATUS_LABELS[s]}
                    </option>
                  ))}
                </Select>
              </Field>
            )}

            {actorIsOwner || showSeatOverride ? (
              <div className="space-y-4 rounded-lg border border-ink-200 bg-ink-50/60 p-3">
                {actorIsOwner ? (
                  <div>
                    <CheckboxField
                      name={isSelf ? undefined : "isAdmin"}
                      label="Owner"
                      description={
                        isSelf
                          ? "You can't remove yourself as an owner — ask another owner."
                          : "Full control, including owners' accounts. Leaders, mentors, and teachers already have admin access."
                      }
                      defaultChecked={isSelf || isAdminDefault}
                      disabled={isSelf}
                    />
                    <FieldError>{err?.isAdmin}</FieldError>
                    {inAdminEmails && (
                      <p className="mt-1.5 pl-7 text-xs text-ink-500">
                        This email is in ADMIN_EMAILS. It only matters before the first owner exists.
                      </p>
                    )}
                  </div>
                ) : (
                  <p className="text-xs text-ink-500">{adminNote}</p>
                )}
                {showSeatOverride && (
                  <CheckboxField
                    name="overrideSeatLimit"
                    label="Approve anyway (over seat limit)"
                    description="Only needed if this change puts more people in a leadership seat than planned."
                    // Stays ticked after a failed save, so "tick Approve anyway and save again" works.
                    defaultChecked={v?.overrideSeatLimit === "on"}
                  />
                )}
              </div>
            ) : (
              // Nothing to tick here (your own account, or one you can only look at): no grey box.
              !readOnly && <p className="text-xs text-ink-500">{adminNote}</p>
            )}
          </fieldset>

          {!readOnly && (
            <div className="flex justify-end">
              <SubmitButton className="w-full sm:w-auto" pendingText="Saving…">
                Save changes
              </SubmitButton>
            </div>
          )}
        </form>
      </CardBody>
    </Card>
  );
}
