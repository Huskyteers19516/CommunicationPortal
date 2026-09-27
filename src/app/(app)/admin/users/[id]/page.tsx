import { ChevronLeft, ShieldCheck } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { SeatInfo } from "@/components/admin/position-fields";
import { UserAccountActions } from "@/components/admin/user-account-actions";
import { UserEditForm } from "@/components/admin/user-edit-form";
import { UserStats } from "@/components/admin/user-stats";
import { AccountStatusBadge, RoleBadge, SubteamBadge } from "@/components/app/badges";
import { Alert } from "@/components/ui/alert";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import type { Role } from "@/generated/prisma/enums";
import { requireAdminUser } from "@/server/auth/session";
import { env } from "@/server/env";
import { grantableRoles } from "@/server/permissions";
import { getEmailConfigStatus, getSeatUsage, getUserDetail } from "@/server/queries/admin";

export const metadata: Metadata = { title: "Person" };

export default async function PersonPage({ params }: PageProps<"/admin/users/[id]">) {
  const actor = await requireAdminUser();
  const { id } = await params;
  const now = new Date();
  const [user, seats] = await Promise.all([getUserDetail(actor, id, undefined, now), getSeatUsage(actor)]);
  if (!user) notFound();
  const emailReady = getEmailConfigStatus(actor).mode !== "none";

  const seatMap: Partial<Record<Role, SeatInfo>> = Object.fromEntries(
    // Don't count this person against their own seat.
    seats.map((s) => [
      s.role,
      { filled: s.filled - (s.holders.some((h) => h.id === user.id) ? 1 : 0), limit: s.limit },
    ]),
  );

  return (
    <>
      <Link
        href="/admin/users"
        className="-ml-2 mb-3 inline-flex min-h-10 items-center gap-1 rounded-lg px-2 text-sm font-medium text-ink-600 hover:bg-ink-100 hover:text-ink-900"
      >
        <ChevronLeft className="size-4" aria-hidden /> People
      </Link>

      <header className="mb-6 flex items-start gap-4">
        <Avatar name={user.name} size="lg" />
        <div className="min-w-0">
          <h1 className="font-display text-2xl font-semibold uppercase tracking-wide text-ink-900 sm:text-3xl break-words">
            {user.name}
          </h1>
          <p className="truncate text-sm text-ink-500">{user.email}</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <AccountStatusBadge status={user.status} />
            <RoleBadge role={user.role} />
            {user.subteam && <SubteamBadge subteam={user.subteam} />}
            {user.isAdmin && (
              <Badge tone="brand">
                <ShieldCheck className="size-3" aria-hidden />
                Owner
              </Badge>
            )}
            {user.isSelf && <Badge tone="gray">You</Badge>}
          </div>
        </div>
      </header>

      {user.status === "PENDING" && (
        <Alert tone="warning" className="mb-6" title="Waiting for approval">
          Set the status to Active to approve, or use the{" "}
          <Link href="/admin" className="font-medium underline underline-offset-2">
            Approvals
          </Link>{" "}
          page.
        </Alert>
      )}

      {!user.canManage ? (
        <Alert tone="info" className="mb-6" title={user.isAdmin ? "Owner account" : "You can't change this account"}>
          {user.isAdmin
            ? "Only an owner can change an owner's account."
            : "Leaders manage members' accounts; the captain, mentors, and teachers also manage leaders'. Ask an owner to change this one."}
        </Alert>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0">
          <UserEditForm
            key={user.id}
            user={{
              id: user.id,
              name: user.name,
              email: user.email,
              role: user.role,
              subteam: user.subteam,
              status: user.status,
              isAdmin: user.isAdmin,
            }}
            isSelf={user.isSelf}
            inAdminEmails={user.inAdminEmails}
            seats={seatMap}
            actorIsOwner={actor.isAdmin}
            readOnly={!user.canManage}
            roles={grantableRoles(actor, { approving: user.status === "PENDING" || user.status === "REJECTED" })}
          />
        </div>
        <div className="min-w-0 space-y-6">
          <UserAccountActions
            key={user.id}
            user={{
              id: user.id,
              name: user.name,
              email: user.email,
              isDisabled: user.status === "DISABLED",
              isSelf: user.isSelf,
              canDelete: user.canDelete,
              canManage: user.canManage,
              deleteBlockedByActivity:
                !user.isSelf && user.hasActivity && (user.status === "PENDING" || user.status === "REJECTED"),
              activeSessions: user.activeSessions,
            }}
            emailReady={emailReady}
            actorIsOwner={actor.isAdmin}
          />
          <UserStats user={user} now={now} timeZone={env.teamTimezone} />
        </div>
      </div>
    </>
  );
}
