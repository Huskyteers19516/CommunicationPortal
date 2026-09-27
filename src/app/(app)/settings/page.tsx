import { LogOut } from "lucide-react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { RoleBadge, SubteamBadge } from "@/components/app/badges";
import { UserChip } from "@/components/app/user-chip";
import { NotificationPrefsForm } from "@/components/settings/notification-prefs-form";
import { PasswordForm } from "@/components/settings/password-form";
import { ProfileForm } from "@/components/settings/profile-form";
import { SignOutOthersForm } from "@/components/settings/sign-out-others-form";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { SubmitButton } from "@/components/ui/submit-button";
import { logoutAction } from "@/server/auth/actions";
import { getCurrentSessionTokenHash, requireActiveUser } from "@/server/auth/session";
import { prisma } from "@/server/db";
import { canAdminister, isStaff } from "@/server/permissions";
import { editablePrefKeys, getSettings, resourceEmailScope } from "@/server/services/settings";
import {
  changePasswordAction,
  signOutOtherDevicesAction,
  updateNotificationPrefsAction,
  updateProfileAction,
} from "./actions";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage() {
  const actor = await requireActiveUser();
  const currentSessionTokenHash = await getCurrentSessionTokenHash();
  const settings = await getSettings(prisma, actor, { currentSessionTokenHash, now: new Date() });
  if (!settings) notFound();
  const others = settings.otherSessionCount;

  return (
    <>
      <PageHeader title="Settings" description="Your profile, email notifications, and sign-in." />
      <div className="max-w-2xl space-y-6">
        <Card>
          <CardHeader title="Profile" description="How you show up for the rest of the team." />
          <CardBody className="space-y-5">
            <UserChip name={actor.name} role={actor.role} subteam={actor.subteam} />
            <ProfileForm action={updateProfileAction} name={actor.name} />
            <dl className="divide-y divide-ink-100 border-t border-ink-100">
              <div className="py-3">
                <dt className="text-sm font-medium text-ink-800">Email</dt>
                <dd className="mt-1 break-all text-sm text-ink-900">{actor.email}</dd>
                <dd className="mt-0.5 text-xs text-ink-500">Ask the team admin if your email needs to change.</dd>
              </div>
              <div className="pt-3">
                <dt className="text-sm font-medium text-ink-800">Position</dt>
                <dd className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  <RoleBadge role={actor.role} />
                  <SubteamBadge subteam={actor.subteam} />
                  {actor.isAdmin ? <Badge tone="brand">Owner</Badge> : canAdminister(actor) && <Badge tone="brand">Admin</Badge>}
                </dd>
                <dd className="mt-1 text-xs text-ink-500">Positions are managed by the team admin.</dd>
              </div>
            </dl>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Email notifications" description="Choose what we email you about." />
          <CardBody>
            <NotificationPrefsForm
              action={updateNotificationPrefsAction}
              prefs={settings.prefs}
              showStaff={isStaff(actor)}
              showAdmin={canAdminister(actor)}
              editableKeys={editablePrefKeys(actor)}
              resourceScope={resourceEmailScope(actor)}
            />
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Password" description="Changing it signs you out on your other devices." />
          <CardBody>
            <PasswordForm action={changePasswordAction} email={actor.email} />
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Devices"
            description={
              others === 0
                ? "This is the only device signed in to your account."
                : `You're also signed in on ${others} other ${others === 1 ? "device" : "devices"}.`
            }
          />
          <CardBody className="space-y-4">
            <p className="text-sm text-ink-600">Lost a phone or used a shared computer? Sign out everywhere else.</p>
            <SignOutOthersForm action={signOutOtherDevicesAction} />
            <form action={logoutAction} className="border-t border-ink-100 pt-4">
              <SubmitButton variant="ghost" pendingText="Signing out…" className="w-full sm:w-auto">
                <LogOut className="size-4" aria-hidden />
                Sign out of this device
              </SubmitButton>
            </form>
          </CardBody>
        </Card>
      </div>
    </>
  );
}
