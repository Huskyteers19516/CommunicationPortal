"use client";

import { Check, Copy, Info, KeyRound, LogOut, Trash2 } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { type ReactNode, useActionState, useState } from "react";
import { deleteUserAction, revokeSessionsAction, sendPasswordResetAction } from "@/app/(app)/admin/actions";
import { Button } from "@/components/ui/button";
import type { ButtonVariant } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/field";
import { FormMessage } from "@/components/ui/form-message";
import { SubmitButton } from "@/components/ui/submit-button";
import { type ActionState, initialActionState } from "@/lib/action-state";
import { RESET_LINK_HINT, RESET_LINK_NOT_EMAILED, type ResetLinkState } from "./messages";

type Action = (prev: ActionState, formData: FormData) => Promise<ActionState>;

function RowHeading({ icon: Icon, title, description }: { icon: LucideIcon; title: string; description: ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-ink-100 text-ink-600">
        <Icon className="size-4" aria-hidden />
      </span>
      <div className="min-w-0">
        <p className="text-sm font-medium text-ink-900">{title}</p>
        <p className="text-sm text-ink-500">{description}</p>
      </div>
    </div>
  );
}

function ActionRow({
  userId,
  action,
  icon,
  title,
  description,
  button,
  pendingText,
  confirm,
  variant = "secondary",
  disabled,
}: {
  userId: string;
  action: Action;
  icon: LucideIcon;
  title: string;
  description: ReactNode;
  button: string;
  pendingText: string;
  confirm?: string;
  variant?: ButtonVariant;
  disabled?: boolean;
}) {
  const [state, formAction] = useActionState(action, initialActionState);
  return (
    <li className="space-y-3 px-4 py-4 sm:px-5">
      <RowHeading icon={icon} title={title} description={description} />
      <form action={formAction}>
        <input type="hidden" name="userId" value={userId} />
        <SubmitButton variant={variant} className="w-full" pendingText={pendingText} confirm={confirm} disabled={disabled}>
          {button}
        </SubmitButton>
      </form>
      <FormMessage state={state} />
    </li>
  );
}

/** Copies `text` to the clipboard; the field next to it stays selectable if the clipboard is blocked. */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="secondary"
      className="shrink-0"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        } catch {
          setCopied(false);
        }
      }}
    >
      {copied ? <Check className="size-4" aria-hidden /> : <Copy className="size-4" aria-hidden />}
      <span aria-live="polite">{copied ? "Copied" : "Copy"}</span>
    </Button>
  );
}

/** Creates a one-time reset link, shows it once (to pass on privately), and emails it when email is set up. */
function PasswordResetRow({
  user,
  emailReady,
  showLink,
}: {
  user: { id: string; email: string; isDisabled: boolean };
  emailReady: boolean;
  /** Owners see the link itself; other admins only send it by email. */
  showLink: boolean;
}) {
  const [state, formAction] = useActionState<ResetLinkState, FormData>(sendPasswordResetAction, initialActionState);
  const linkId = `reset-link-${user.id}`;
  return (
    <li className="space-y-3 px-4 py-4 sm:px-5">
      <RowHeading
        icon={KeyRound}
        title="Password reset"
        description={
          user.isDisabled
            ? "Re-activate this account before creating a reset link."
            : !showLink
              ? emailReady
                ? `Emails ${user.email} a one-time link to choose a new password.`
                : "Email isn't set up yet, so only an owner can create reset links."
              : emailReady
                ? `Creates a one-time link to choose a new password and emails it to ${user.email}. You'll see the link here too.`
                : "Creates a one-time link to choose a new password. Email isn't set up, so you'll need to send it to them yourself."
        }
      />
      <form action={formAction}>
        <input type="hidden" name="userId" value={user.id} />
        <SubmitButton
          variant="secondary"
          className="w-full"
          pendingText={showLink ? "Creating link…" : "Sending…"}
          disabled={user.isDisabled || (!showLink && !emailReady)}
        >
          {showLink ? "Create reset link" : "Email a reset link"}
        </SubmitButton>
      </form>
      {state?.ok && state.resetUrl ? (
        <div role="status" className="space-y-2 rounded-lg border border-brand-200 bg-brand-50 p-3 text-sm text-brand-900">
          <label htmlFor={linkId} className="block font-medium">
            One-time reset link
          </label>
          <div className="flex gap-2">
            <Input
              id={linkId}
              readOnly
              value={state.resetUrl}
              onFocus={(e) => e.currentTarget.select()}
              aria-describedby={`${linkId}-hint`}
              className="min-w-0 font-mono text-xs"
            />
            <CopyButton text={state.resetUrl} />
          </div>
          <p id={`${linkId}-hint`}>{RESET_LINK_HINT}</p>
          <p className="text-brand-800">{state.emailed ? `It was also emailed to ${user.email}.` : RESET_LINK_NOT_EMAILED}</p>
        </div>
      ) : (
        <FormMessage state={state} />
      )}
    </li>
  );
}

export function UserAccountActions({
  user,
  emailReady,
  actorIsOwner = false,
}: {
  user: {
    id: string;
    name: string;
    email: string;
    isDisabled: boolean;
    isSelf: boolean;
    canDelete: boolean;
    /** False for an owner's account viewed by someone who isn't an owner. */
    canManage: boolean;
    /** PENDING/REJECTED but used the portal, so it can't be deleted. */
    deleteBlockedByActivity: boolean;
    activeSessions: number;
  };
  /** Whether an email provider is configured. */
  emailReady: boolean;
  /** Owners also see the reset link itself. */
  actorIsOwner?: boolean;
}) {
  if (!user.canManage) return null;
  return (
    <Card>
      <CardHeader title="Account actions" />
      <ul className="divide-y divide-ink-100">
        <PasswordResetRow user={user} emailReady={emailReady} showLink={actorIsOwner} />
        <ActionRow
          userId={user.id}
          action={revokeSessionsAction}
          icon={LogOut}
          title="Sessions"
          description={
            user.activeSessions === 0
              ? "Not signed in anywhere right now."
              : `Signed in on ${user.activeSessions} device${user.activeSessions === 1 ? "" : "s"}.`
          }
          button="Sign out of all devices"
          pendingText="Signing out…"
          confirm={
            user.isSelf
              ? "Sign yourself out everywhere, including this device?"
              : `Sign ${user.name} out on every device?`
          }
        />
        {user.canDelete && (
          <ActionRow
            userId={user.id}
            action={deleteUserAction}
            icon={Trash2}
            title="Delete sign-up"
            description="Permanently removes this account. They never used the portal, so nothing else is lost, and they can register again later."
            button="Delete sign-up"
            pendingText="Deleting…"
            variant="danger"
            confirm={`Permanently delete ${user.name}'s account? This can't be undone.`}
          />
        )}
        {user.deleteBlockedByActivity && (
          <li className="px-4 py-4 sm:px-5">
            <RowHeading
              icon={Info}
              title="Can't delete"
              description="This person has activity in the portal — disable the account instead."
            />
          </li>
        )}
      </ul>
    </Card>
  );
}
