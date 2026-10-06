import type { Metadata } from "next";
import { FileStorageCard } from "@/components/admin/file-storage-card";
import { PendingList } from "@/components/admin/pending-list";
import type { SeatInfo } from "@/components/admin/position-fields";
import { RecentDecisions } from "@/components/admin/recent-decisions";
import { SeatUsageCard } from "@/components/admin/seat-usage-card";
import { TeamWebsiteCard } from "@/components/admin/team-website-card";
import { WebsitePhotosCard } from "@/components/admin/website-photos-card";
import { ResourceApprovalsCard } from "@/components/resources/resource-approvals-card";
import { PageHeader } from "@/components/ui/page-header";
import type { Role } from "@/generated/prisma/enums";
import { formatDateTime, timeAgo, todayInTimezone } from "@/lib/dates";
import { requireAdminUser } from "@/server/auth/session";
import { canManageAccount, grantableRoles } from "@/server/permissions";
import { env } from "@/server/env";
import { scheduleFileCleanup } from "@/server/files/cleanup";
import { getPendingUsers, getRecentDecisions, getSeatUsage } from "@/server/queries/admin";
import { getFileStorageOverview } from "@/server/queries/files";
import { getPublicProgressAdminView } from "@/server/queries/public-progress";
import { countPendingResources } from "@/server/queries/resources";
import { getTeamWebsitePreview } from "@/server/queries/team-website";
import { getWebsitePhotoReview } from "@/server/queries/user-photos";

export const metadata: Metadata = { title: "Approvals" };
// The owners' file storage tools (Server Actions on this page) stop starting new work after 25 s, with at most 10 s per
// R2 request, so a click ends well inside this (src/server/services/file-storage.ts).
export const maxDuration = 60;

export default async function ApprovalsPage() {
  const actor = await requireAdminUser();
  const now = new Date();
  const [pending, seats, decisions, pendingResources, storage, teamWebsite, websitePreview, websitePhotos] = await Promise.all([
    getPendingUsers(actor),
    getSeatUsage(actor),
    getRecentDecisions(actor, 10),
    countPendingResources(actor),
    getFileStorageOverview(actor),
    getPublicProgressAdminView(actor),
    getTeamWebsitePreview(actor, env.teamTimezone),
    getWebsitePhotoReview(actor, now),
  ]);
  // An owner looking at the storage card: delete R2 objects of removed files that are still waiting (after the page).
  if (storage?.owner && storage.location === "r2" && storage.owner.waitingDeletions > 0) scheduleFileCleanup();
  const seatMap: Partial<Record<Role, SeatInfo>> = Object.fromEntries(
    seats.map((s) => [s.role, { filled: s.filled, limit: s.limit }]),
  );

  return (
    <>
      <PageHeader
        eyebrow="Admin"
        title="Approvals"
        description={
          pending.total === 0
            ? "Leaders, captains, mentors, and teachers need your OK before they can use the portal."
            : `${pending.total} ${pending.total === 1 ? "person is" : "people are"} waiting for your OK.`
        }
      />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <section aria-label="Waiting for approval" className="min-w-0">
          <PendingList
            total={pending.total}
            seats={seatMap}
            users={pending.users.map((u) => ({
              id: u.id,
              name: u.name,
              email: u.email,
              role: u.role,
              subteam: u.subteam,
              registeredAgo: timeAgo(u.createdAt, now, env.teamTimezone),
              registeredAt: formatDateTime(u.createdAt, env.teamTimezone),
              canDecide: canManageAccount(actor, { ...u, status: "PENDING" }),
            }))}
            roles={grantableRoles(actor, { approving: true })}
          />
        </section>
        <aside className="min-w-0 space-y-6">
          <ResourceApprovalsCard count={pendingResources} />
          {websitePhotos && (websitePhotos.held.length > 0 || websitePhotos.recent.length > 0) && (
            <WebsitePhotosCard review={websitePhotos} now={now} timeZone={env.teamTimezone} />
          )}
          <SeatUsageCard seats={seats} />
          {storage && <FileStorageCard overview={storage} />}
          {teamWebsite && (
            <TeamWebsiteCard
              settings={teamWebsite.settings}
              defaultSince={teamWebsite.defaultSince}
              hiddenPeople={teamWebsite.hiddenPeople}
              hiddenUncounted={teamWebsite.hiddenUncounted}
              preview={websitePreview}
              today={todayInTimezone(env.teamTimezone, now)}
            />
          )}
          <RecentDecisions decisions={decisions} now={now} timeZone={env.teamTimezone} />
        </aside>
      </div>
    </>
  );
}
