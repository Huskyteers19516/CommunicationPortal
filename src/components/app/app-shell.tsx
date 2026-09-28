import Link from "next/link";
import type { ReactNode } from "react";
import type { Actor } from "@/server/actor";
import { canAccessManage, canAdminister, canUseSponsorships, canViewEmailLog } from "@/server/permissions";
import type { NavCounts } from "@/server/queries/nav";
import { HuskyMark, Logo } from "../brand/logo";
import { BottomTabs, MobileNav, SidebarNav, SignOutButton } from "./nav-client";
import type { NavItem, NavSection } from "./nav-data";
import { UserChip } from "./user-chip";

export function buildNav(actor: Actor, counts: NavCounts): { sections: NavSection[]; tabs: NavItem[] } {
  const staff = canAccessManage(actor);
  const admin = canAdminister(actor);
  const questionsCount = staff ? counts.openQuestions + counts.answeredForMe : counts.answeredForMe;

  const sections: NavSection[] = [
    {
      items: [
        { href: "/today", label: "Today", icon: "today" },
        { href: "/my-tasks", label: "My tasks", icon: "myTasks" },
        { href: "/tasks", label: "Task dashboard", icon: "dashboard" },
        { href: "/attendance", label: "Attendance", icon: "attendance" },
        { href: "/calendar", label: "Team calendar", icon: "calendar" },
        { href: "/questions", label: "Questions", icon: "questions", count: questionsCount },
      ],
    },
    {
      title: "Team",
      items: [
        { href: "/updates", label: "Meeting updates", icon: "updates" },
        { href: "/notebook", label: "Team notebook", icon: "notebook" },
        { href: "/strategy", label: "Strategy", icon: "strategy" },
        { href: "/parts", label: "Parts queue", icon: "parts" },
        { href: "/orders", label: "Order list", icon: "orders" },
        { href: "/resources", label: "Resources", icon: "resources", count: counts.pendingResources },
        { href: "/posters", label: "Posters", icon: "posters" },
      ],
    },
    {
      title: "Business",
      items: [
        { href: "/fundraising", label: "Fundraising", icon: "fundraising" },
        ...(canUseSponsorships(actor) ? [{ href: "/sponsors", label: "Sponsorships", icon: "sponsors" } satisfies NavItem] : []),
      ],
    },
  ];
  if (staff) {
    sections.push({
      title: "Manage",
      items: [
        { href: "/manage", label: "Overview", icon: "overview", exact: true },
        { href: "/manage/tasks", label: "Tasks", icon: "tasks" },
        { href: "/manage/review", label: "Review", icon: "review", count: counts.reviewQueue },
        { href: "/manage/progress", label: "Progress", icon: "progress" },
      ],
    });
  }
  if (admin) {
    sections.push({
      title: "Admin",
      items: [
        { href: "/admin", label: "Approvals", icon: "approvals", count: counts.pendingApprovals, exact: true },
        { href: "/admin/users", label: "People", icon: "users" },
        // Owners only (subjects can reveal other subteams' private details).
        ...(canViewEmailLog(actor) ? [{ href: "/admin/emails", label: "Email log", icon: "emails" } satisfies NavItem] : []),
      ],
    });
  }
  sections.push({ items: [{ href: "/settings", label: "Settings", icon: "settings" }] });

  const tabs: NavItem[] = [
    { href: "/today", label: "Today", icon: "today" },
    { href: "/my-tasks", label: "My tasks", icon: "myTasks" },
    { href: "/tasks", label: "Dashboard", icon: "dashboard" },
    { href: "/questions", label: "Questions", icon: "questions", count: questionsCount },
    ...(staff ? [{ href: "/manage/review", label: "Review", icon: "review", count: counts.reviewQueue } satisfies NavItem] : []),
  ];
  return { sections, tabs };
}

export function AppShell({ actor, counts, children }: { actor: Actor; counts: NavCounts; children: ReactNode }) {
  const { sections, tabs } = buildNav(actor, counts);
  return (
    <div className="min-h-dvh">
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col border-r border-ink-200 bg-white lg:flex">
        <div className="px-5 pb-4 pt-5">
          <Link href="/today" aria-label="Home">
            <Logo size="sm" />
          </Link>
        </div>
        <div className="flex-1 overflow-y-auto px-3 pb-4">
          <SidebarNav sections={sections} />
        </div>
        <div className="space-y-1 border-t border-ink-100 p-3">
          <Link href="/settings" className="block rounded-lg px-2 py-2 hover:bg-ink-50">
            <UserChip name={actor.name} role={actor.role} subteam={actor.subteam} />
          </Link>
          <SignOutButton />
        </div>
      </aside>

      {/* Mobile top bar */}
      <header className="sticky top-0 z-30 flex items-center justify-between border-b border-ink-200 bg-white/95 px-4 py-2 backdrop-blur lg:hidden">
        <Link href="/today" aria-label="Home" className="flex items-center gap-2">
          <HuskyMark className="size-8" />
          <span className="font-display text-lg font-bold uppercase tracking-wide text-brand-500">Huskyteers</span>
        </Link>
        <MobileNav
          sections={sections}
          header={<UserChip name={actor.name} role={actor.role} subteam={actor.subteam} size="sm" />}
        />
      </header>

      <main className="px-4 pb-28 pt-6 sm:px-6 lg:ml-64 lg:px-10 lg:pb-12 lg:pt-10">
        <div className="mx-auto w-full max-w-5xl">{children}</div>
      </main>

      <BottomTabs items={tabs} />
    </div>
  );
}
