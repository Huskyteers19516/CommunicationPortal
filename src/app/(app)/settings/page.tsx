import { LogOut } from "lucide-react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { RoleBadge, SubteamBadge } from "@/components/app/badges";
import { UserChipWithPhoto } from "@/components/app/user-avatar";
import { AutoSaveSwitch } from "@/components/settings/auto-save-switch";
import { MyPhotoEditor } from "@/components/settings/my-photo-editor";
import { NotificationPrefsForm } from "@/components/settings/notification-prefs-form";
import { PasswordForm } from "@/components/settings/password-form";
import { PublicProgressSwitch } from "@/components/settings/public-progress-switch";
import { ProfileForm } from "@/components/settings/profile-form";
import { SignOutOthersForm } from "@/components/settings/sign-out-others-form";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { SubmitButton } from "@/components/ui/submit-button";
import { TEAM_SITE_ORIGIN, TEAM_SITE_PROGRESS_URL } from "@/lib/public-progress";
import { websitePhotoHoldSentence } from "@/lib/user-photos";
import { logoutAction } from "@/server/auth/actions";
import { getCurrentSessionTokenHash, requireActiveUser } from "@/server/auth/session";
import { prisma } from "@/server/db";
import { canAdminister, isStaff } from "@/server/permissions";
import { getPublicProgressConfig, PUBLIC_PROGRESS_EXCLUDED_ROLES } from "@/server/queries/public-progress";
import { publicTeamPhotosShown } from "@/server/queries/public-team-photos";
import { getMyPhoto } from "@/server/queries/user-photos";
import { editablePrefKeys, getSettings, resourceEmailScope } from "@/server/services/settings";
import {
  changePasswordAction,
  signOutOtherDevicesAction,
  updateNotificationPrefsAction,
  updateProfileAction,
  updatePhotoVisibilityAction,
  updatePublicProgressVisibilityAction,
} from "./actions";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage() {
  const actor = await requireActiveUser();
  const currentSessionTokenHash = await getCurrentSessionTokenHash();
  // Mentors and teachers are never on the team website's progress page, so they get no switch for it.
  const listable = !PUBLIC_PROGRESS_EXCLUDED_ROLES.includes(actor.role);
  const [settings, publicPage, myPhoto, websitePhotos] = await Promise.all([
    getSettings(prisma, actor, { currentSessionTokenHash, now: new Date() }),
    listable ? getPublicProgressConfig() : null,
    getMyPhoto(actor),
    publicTeamPhotosShown(),
  ]);
  if (!settings || !myPhoto) notFound();
  const others = settings.otherSessionCount;

  return (
    <>
      <PageHeader title="Settings" description="Your profile, email notifications, and sign-in." />
      <div className="max-w-2xl space-y-6">
        <Card>
          <CardHeader title="Profile" description="How you show up for the rest of the team." />
          <CardBody className="space-y-5">
            <UserChipWithPhoto userId={actor.id} name={actor.name} role={actor.role} subteam={actor.subteam} />
            <ProfileForm
              action={updateProfileAction}
              name={actor.name}
              hint={
                myPhoto.photo && myPhoto.showPhotoOnWebsite && !myPhoto.websiteHold
                  ? "Shown to your team on tasks and questions. A new name takes your photo off the team website until a leader checks it (the website finds photos by name)."
                  : undefined
              }
            />
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

        <Card role="region" aria-label="My photo">
          <CardHeader
            title="My photo"
            description="A photo of you, on your name around the portal and on the team website's Our Team page. You choose where with the switches below."
          />
          <CardBody className="space-y-5">
            <MyPhotoEditor
              name={actor.name}
              photoSrc={myPhoto.photo?.src ?? null}
              visibility={{
                inPortal: myPhoto.showPhotoInPortal,
                website: !myPhoto.showPhotoOnWebsite ? "off" : myPhoto.websiteHold ? "held" : websitePhotos ? "on" : "team-off",
              }}
            />
            <div className="space-y-3 border-t border-ink-100 pt-4">
              <AutoSaveSwitch
                action={updatePhotoVisibilityAction}
                checked={myPhoto.showPhotoInPortal}
                id="photo-in-portal"
                fields={{ which: "portal" }}
                label="Show my photo in the portal"
                description="On your name in the menu, Team members, tasks, questions, discussions, and announcements. Off: the team sees your initials instead (people who manage your account can still see it in Admin → People). It doesn't change the team website."
              />
              <AutoSaveSwitch
                action={updatePhotoVisibilityAction}
                checked={myPhoto.showPhotoOnWebsite}
                id="photo-on-website"
                fields={{ which: "website" }}
                label="Show my photo on the team website (public)"
                description={
                  <>
                    The{" "}
                    <a
                      href={`${TEAM_SITE_ORIGIN}/about/team`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-medium text-brand-700 underline underline-offset-2"
                    >
                      team website
                      <span className="sr-only"> (opens in a new tab)</span>
                    </a>{" "}
                    is public: anyone on the internet can see it. While this is on, your photo is public too. It goes up
                    automatically, next to your name wherever the website lists you (your Our Team card, the progress
                    page; it finds you by your full name), and anyone with its link can open it even where you
                    aren&apos;t listed. Turning it off takes it off the website within a few minutes.
                    {!websitePhotos && " Right now the team isn't showing members' photos on the website at all."}
                  </>
                }
              />
              {myPhoto.websiteHold && (
                <Alert tone="warning" role={null}>
                  {websitePhotoHoldSentence(myPhoto.websiteHold)}
                </Alert>
              )}
            </div>
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

        {publicPage && (
          <Card>
            <CardHeader
              title="Team website"
              description={
                <>
                  Our{" "}
                  <a
                    href={TEAM_SITE_PROGRESS_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium text-brand-700 underline underline-offset-2"
                  >
                    progress page
                    <span className="sr-only"> (opens in a new tab)</span>
                  </a>{" "}
                  shows guests the team&apos;s live progress from the portal; the Our Team page shows each
                  person&apos;s.
                </>
              }
            />
            <CardBody className="space-y-2">
              <PublicProgressSwitch action={updatePublicProgressVisibilityAction} show={settings.showOnPublicProgress} />
              {!publicPage.settings.enabled ? (
                <p className="text-sm text-ink-500">The progress page is turned off right now, so nobody is shown.</p>
              ) : publicPage.settings.nameStyle === "hidden" ? (
                <p className="text-sm text-ink-500">Right now the page shows team and subteam totals only, no names.</p>
              ) : (
                <p className="text-sm text-ink-500">
                  {publicPage.settings.showPersonPages
                    ? "Profiles on the Our Team page are on right now: yours lists what you've finished."
                    : "Profiles on the Our Team page are off right now: they show only your numbers."}
                </p>
              )}
            </CardBody>
          </Card>
        )}

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
