"use client";

import { useState } from "react";
import type { Role, Subteam } from "@/generated/prisma/enums";
import { ROLES, ROLE_LABELS, SUBTEAMS, SUBTEAM_LABELS, subteamForRole } from "@/lib/constants";
import { Field, Select } from "@/components/ui/field";

export interface SeatInfo {
  filled: number;
  limit: number;
}

/**
 * Position select + (for Members) a subteam select. Leaders' subteam comes from their role,
 * captain/mentor/teacher have none — the server normalizes this too.
 * `form` associates the inputs with a <form> elsewhere on the page.
 * Inputs are uncontrolled (React resets forms after an action): remount with a new `key`
 * after each submission so the visible role and the subteam field stay in sync.
 */
export function PositionFields({
  idPrefix,
  defaultRole,
  defaultSubteam,
  errors,
  seats,
  form,
  roles: allowedRoles,
}: {
  idPrefix: string;
  defaultRole: Role;
  defaultSubteam: Subteam | null;
  errors?: { role?: string; subteam?: string };
  seats?: Partial<Record<Role, SeatInfo>>;
  form?: string;
  /** Positions offered (the default one is always kept). Default: every position. */
  roles?: Role[];
}) {
  const [role, setRole] = useState<Role>(defaultRole);
  const implied = subteamForRole(role);
  const seat = seats?.[role];
  const full = seat && seat.filled >= seat.limit;

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field
        label="Position"
        htmlFor={`${idPrefix}-role`}
        error={errors?.role}
        hint={
          full
            ? undefined
            : implied
              ? `Leads the ${SUBTEAM_LABELS[implied]} subteam.`
              : implied === null
                ? "Sees and manages every subteam."
                : undefined
        }
      >
        <Select
          id={`${idPrefix}-role`}
          name="role"
          form={form}
          defaultValue={defaultRole}
          invalid={!!errors?.role}
          onChange={(e) => setRole(e.target.value as Role)}
        >
          {ROLES.filter((r) => !allowedRoles || r === defaultRole || allowedRoles.includes(r)).map((r) => (
            <option key={r} value={r}>
              {ROLE_LABELS[r]}
            </option>
          ))}
        </Select>
        {full && (
          <p className="text-xs font-medium text-amber-700">
            All {seat.limit} {ROLE_LABELS[role]} seat{seat.limit === 1 ? " is" : "s are"} taken.
          </p>
        )}
      </Field>

      {role === "MEMBER" && (
        <Field label="Subteam" htmlFor={`${idPrefix}-subteam`} error={errors?.subteam}>
          <Select
            id={`${idPrefix}-subteam`}
            name="subteam"
            form={form}
            defaultValue={defaultSubteam ?? ""}
            invalid={!!errors?.subteam}
          >
            <option value="" disabled>
              Choose a subteam
            </option>
            {SUBTEAMS.map((s) => (
              <option key={s} value={s}>
                {SUBTEAM_LABELS[s]}
              </option>
            ))}
          </Select>
        </Field>
      )}
    </div>
  );
}
