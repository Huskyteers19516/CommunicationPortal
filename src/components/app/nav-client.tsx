"use client";

import {
  BadgeCheck,
  BookMarked,
  ChartColumn,
  ClipboardList,
  FolderKanban,
  HandCoins,
  LayoutDashboard,
  ListChecks,
  LogOut,
  Mail,
  Menu,
  MessageCircleQuestionMark,
  Printer,
  Settings,
  SquareKanban,
  UserCheck,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { logoutAction } from "@/server/auth/actions";
import { cn } from "@/lib/cn";
import { CountBubble } from "../ui/badge";
import type { NavIcon, NavItem, NavSection } from "./nav-data";

const ICONS: Record<NavIcon, LucideIcon> = {
  today: ListChecks,
  myTasks: ClipboardList,
  dashboard: SquareKanban,
  parts: Printer,
  sponsors: HandCoins,
  questions: MessageCircleQuestionMark,
  resources: BookMarked,
  overview: LayoutDashboard,
  tasks: FolderKanban,
  review: BadgeCheck,
  progress: ChartColumn,
  approvals: UserCheck,
  users: Users,
  emails: Mail,
  settings: Settings,
};

function isActive(pathname: string, item: NavItem) {
  if (item.exact) return pathname === item.href;
  return pathname === item.href || pathname.startsWith(item.href + "/");
}

function NavLinks({ sections, onNavigate }: { sections: NavSection[]; onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <nav className="space-y-6" aria-label="Main">
      {sections.map((section, i) => (
        <div key={section.title ?? i}>
          {section.title && (
            <p className="mb-1.5 px-3 text-[11px] font-semibold uppercase tracking-wider text-ink-500">{section.title}</p>
          )}
          <ul className="space-y-0.5">
            {section.items.map((item) => {
              const Icon = ICONS[item.icon];
              const active = isActive(pathname, item);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={onNavigate}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                      active ? "bg-brand-50 text-brand-800" : "text-ink-600 hover:bg-ink-50 hover:text-ink-900",
                    )}
                  >
                    <Icon className={cn("size-[18px] shrink-0", active ? "text-brand-600" : "text-ink-400")} aria-hidden />
                    <span className="flex-1 truncate">{item.label}</span>
                    <CountBubble count={item.count ?? 0} />
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

export function SignOutButton({ className }: { className?: string }) {
  return (
    <form action={logoutAction}>
      <button
        type="submit"
        className={cn(
          "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-ink-600 transition-colors hover:bg-ink-50 hover:text-ink-900",
          className,
        )}
      >
        <LogOut className="size-[18px] text-ink-400" aria-hidden />
        Sign out
      </button>
    </form>
  );
}

/** Desktop sidebar navigation. */
export function SidebarNav({ sections }: { sections: NavSection[] }) {
  return <NavLinks sections={sections} />;
}

/**
 * Mobile: hamburger button + slide-over drawer.
 * The drawer is portalled to <body>: the sticky header uses backdrop-blur, which would otherwise
 * become the containing block for `position: fixed` and squeeze the drawer to the header's height.
 */
export function MobileNav({ sections, header }: { sections: NavSection[]; header: React.ReactNode }) {
  // Remember which page the drawer was opened on; navigating anywhere else closes it.
  const pathname = usePathname();
  const [openedOn, setOpenedOn] = useState<string | null>(null);
  const open = openedOn === pathname;
  const setOpen = (value: boolean) => setOpenedOn(value ? pathname : null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const wasOpen = useRef(false);

  useEffect(() => {
    if (!open) {
      // Return focus to the menu button when the drawer closes (not on first render).
      if (wasOpen.current) triggerRef.current?.focus();
      wasOpen.current = false;
      return;
    }
    wasOpen.current = true;
    closeRef.current?.focus();
    const background = [document.querySelector("main"), document.querySelector("header"), document.querySelector('nav[aria-label="Quick"]')];
    background.forEach((el) => el?.setAttribute("inert", ""));
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenedOn(null);
      if (e.key !== "Tab" || !panelRef.current) return;
      // Keep Tab inside the drawer.
      const focusable = panelRef.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled])');
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
      background.forEach((el) => el?.removeAttribute("inert"));
    };
  }, [open]);
  const total = sections.flatMap((s) => s.items).reduce((n, i) => n + (i.count ?? 0), 0);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(true)}
        className="relative -mr-2 inline-flex size-10 items-center justify-center rounded-lg text-ink-700 hover:bg-ink-100"
        aria-label="Open menu"
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        <Menu className="size-6" aria-hidden />
        {total > 0 && <span className="absolute right-1.5 top-1.5 size-2.5 rounded-full bg-brand-500 ring-2 ring-white" />}
      </button>
      {open &&
        createPortal(
          <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="Menu">
            <div className="absolute inset-0 bg-ink-900/40" onClick={() => setOpen(false)} aria-hidden />
            <div ref={panelRef} className="absolute inset-y-0 right-0 flex w-[min(20rem,85vw)] flex-col bg-white shadow-xl">
              <div className="flex items-center justify-between gap-2 border-b border-ink-100 px-4 py-3">
                <div className="min-w-0">{header}</div>
                <button
                  ref={closeRef}
                  type="button"
                  onClick={() => setOpen(false)}
                  className="inline-flex size-10 shrink-0 items-center justify-center rounded-lg text-ink-600 hover:bg-ink-100"
                  aria-label="Close menu"
                >
                  <X className="size-5" aria-hidden />
                </button>
              </div>
              <div className="flex-1 overflow-y-auto px-3 py-4">
                <NavLinks sections={sections} onNavigate={() => setOpen(false)} />
              </div>
              <div className="border-t border-ink-100 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
                <SignOutButton />
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

/** Mobile bottom tab bar with the most-used destinations. */
export function BottomTabs({ items }: { items: NavItem[] }) {
  const pathname = usePathname();
  return (
    <nav
      aria-label="Quick"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-ink-200 bg-white/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden"
    >
      <ul className="mx-auto flex max-w-md">
        {items.map((item) => {
          const Icon = ICONS[item.icon];
          const active = isActive(pathname, item);
          return (
            <li key={item.href} className="flex-1">
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "relative flex flex-col items-center gap-0.5 py-2 text-[11px] font-medium",
                  active ? "text-brand-700" : "text-ink-500",
                )}
              >
                <Icon className="size-5" aria-hidden />
                {item.label}
                {!!item.count && (
                  <span className="absolute left-1/2 top-1 ml-2.5">
                    <CountBubble count={item.count} className="min-w-4 px-1 text-[10px] leading-4" />
                  </span>
                )}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
