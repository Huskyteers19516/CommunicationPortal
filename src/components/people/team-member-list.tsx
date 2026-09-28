import { ChevronRight, Mail } from "lucide-react";
import Link from "next/link";
import { OwnerBadge } from "@/components/app/badges";
import { UserChip } from "@/components/app/user-chip";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/cn";
import { lastSeenLabel, timeAgo } from "@/lib/dates";
import type { TeamMember } from "@/server/queries/people";

export interface TeamMemberRow extends TeamMember {
  /** Admin → People edit page, only for people the viewer can manage there (null for members). */
  adminHref: string | null;
}

/**
 * Avatar, name, position, and the Owner badge; a link into Admin → People (with a chevron, so it's clear which
 * names open Admin) only when the viewer can manage this person (never for members).
 */
function Person({ person }: { person: TeamMemberRow }) {
  const content = (
    <>
      <UserChip name={person.name} role={person.role} subteam={person.subteam} className="min-w-0 max-w-full" />
      {person.isAdmin && (
        <span className="shrink-0">
          <OwnerBadge />
        </span>
      )}
    </>
  );
  if (!person.adminHref) return <div className="flex min-h-10 min-w-0 items-center gap-2">{content}</div>;
  return (
    <Link
      href={person.adminHref}
      title={`Manage ${person.name} in Admin → People`}
      className="group flex min-h-10 min-w-0 items-center gap-2 rounded-md"
    >
      {content}
      <ChevronRight className="ml-auto size-4 shrink-0 text-ink-300 group-hover:text-brand-600" aria-hidden />
    </Link>
  );
}

/** A mailto: link. Long addresses wrap (phones) or truncate (table) instead of widening the page. */
function EmailLink({ email, fit, className }: { email: string; fit: "wrap" | "truncate"; className?: string }) {
  return (
    <a
      href={`mailto:${email}`}
      title={`Email ${email}`}
      className={cn("inline-flex min-h-10 max-w-full items-center gap-2 font-medium text-brand-700 hover:underline", className)}
    >
      <Mail className="size-4 shrink-0 text-brand-600" aria-hidden />
      <span className={cn("min-w-0", fit === "wrap" ? "wrap-anywhere" : "truncate")}>{email}</span>
    </a>
  );
}

/** Team members: stacked cards on phones, a table from md up. Read-only apart from the email links. */
export function TeamMemberList({ people, now, timeZone }: { people: TeamMemberRow[]; now: Date; timeZone: string }) {
  return (
    <Card className="overflow-hidden">
      {/* Phones */}
      <ul className="divide-y divide-ink-100 md:hidden">
        {people.map((p) => (
          <li key={p.id} className="px-4 pb-3 pt-2">
            <Person person={p} />
            <div className="flex">
              <EmailLink email={p.email} fit="wrap" className="text-sm" />
            </div>
            {/* Always its own line (lined up with the email), so every card looks the same however long the email is. */}
            <p className="pl-6 text-xs text-ink-500">
              {p.lastSeenAt ? `Seen ${timeAgo(p.lastSeenAt, now, timeZone)}` : "Never signed in"}
            </p>
          </li>
        ))}
      </ul>

      {/* Tablets and up */}
      <table className="hidden w-full table-fixed text-left text-sm md:table">
        <thead className="border-b border-ink-100 bg-ink-50/60 text-xs font-medium uppercase tracking-wide text-ink-500">
          <tr>
            <th scope="col" className="w-[44%] px-3 py-2.5 font-medium lg:px-4">
              Person
            </th>
            <th scope="col" className="w-[38%] px-3 py-2.5 font-medium lg:px-4">
              Email
            </th>
            <th scope="col" className="w-[18%] px-3 py-2.5 text-right font-medium lg:px-4">
              Last seen
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-ink-100">
          {people.map((p) => (
            <tr key={p.id} className={cn(p.adminHref && "transition-colors hover:bg-ink-50")}>
              <td className="px-3 py-2 lg:px-4">
                <Person person={p} />
              </td>
              <td className="px-3 py-2 lg:px-4">
                <EmailLink email={p.email} fit="truncate" />
              </td>
              <td className="truncate px-3 py-2 text-right text-ink-500 lg:px-4">{lastSeenLabel(p.lastSeenAt, now, timeZone)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
