"use client";

import { CornerDownLeft, CircleArrowRight, Plus, Search, type LucideIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/cn";
import { CountBubble } from "../ui/badge";
import { INDICATOR_MOTION, useSlidingIndicator } from "../ui/sliding-indicator";
import { ICONS } from "./nav-client";
import type { NavAction, NavSection } from "./nav-data";

/** Fired by the sidebar / header buttons; the one CommandPalette in the shell listens. */
const OPEN_EVENT = "command-palette:open";

interface Command {
  key: string;
  href: string;
  label: string;
  group: "Go to" | "Create";
  /** Where it lives ("Team", "Strategy"…), shown on the right and searchable. */
  hint?: string;
  icon: LucideIcon;
  count?: number;
  keywords?: string;
}

function buildCommands(sections: NavSection[], actions: NavAction[]): Command[] {
  const pages: Command[] = sections.flatMap((section) =>
    section.items.flatMap((item) => [
      { key: item.href, href: item.href, label: item.label, group: "Go to" as const, hint: section.title, icon: ICONS[item.icon], count: item.count },
      // A sub-page at the parent's own URL is the parent itself; list only the others.
      ...(item.children ?? [])
        .filter((c) => c.href !== item.href)
        .map((c) => ({ key: c.href, href: c.href, label: c.label, group: "Go to" as const, hint: item.label, icon: CircleArrowRight })),
    ]),
  );
  const creates: Command[] = actions.map((a) => ({
    key: `new:${a.href}`,
    ...a,
    keywords: `new add create ${a.keywords ?? ""}`,
    group: "Create" as const,
    icon: Plus,
  }));
  return [...pages, ...creates];
}

/** Every word typed must appear somewhere; labels that start with the query come first, then word starts. */
function filterCommands(commands: Command[], query: string): Command[] {
  const q = query.trim().toLowerCase();
  if (!q) return commands;
  const words = q.split(/\s+/);
  const rank = (c: Command) => {
    const label = c.label.toLowerCase();
    if (label.startsWith(q)) return 0;
    if (label.split(/\s+/).some((w) => w.startsWith(words[0]))) return 1;
    return 2;
  };
  return commands
    .filter((c) => {
      const text = `${c.label} ${c.hint ?? ""} ${c.keywords ?? ""} ${c.group}`.toLowerCase();
      return words.every((w) => text.includes(w));
    })
    .map((c, i) => ({ c, i, r: rank(c) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map(({ c }) => c);
}

const noSubscribe = () => () => {};
/** "⌘K" on Apple devices, "Ctrl K" elsewhere; null while server-rendering. */
function useShortcutLabel() {
  return useSyncExternalStore(
    noSubscribe,
    () => (/Mac|iPhone|iPad/.test(navigator.platform) ? "⌘K" : "Ctrl K"),
    () => null,
  );
}

/** Opens the palette: a search field in the sidebar, an icon in the mobile header. */
export function CommandPaletteButton({ variant, className }: { variant: "field" | "icon"; className?: string }) {
  const shortcut = useShortcutLabel();
  const open = () => window.dispatchEvent(new Event(OPEN_EVENT));
  if (variant === "icon") {
    return (
      <button
        type="button"
        onClick={open}
        aria-label="Search pages and actions"
        aria-haspopup="dialog"
        className={cn("inline-flex size-10 items-center justify-center rounded-lg text-ink-700 hover:bg-ink-100", className)}
      >
        <Search className="size-5" aria-hidden />
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={open}
      aria-haspopup="dialog"
      className={cn(
        "flex h-10 w-full items-center gap-2 rounded-lg border border-ink-200 bg-ink-50 px-3 text-sm text-ink-500 transition-colors hover:border-ink-300 hover:bg-white",
        className,
      )}
    >
      <Search className="size-4 shrink-0" aria-hidden />
      <span className="flex-1 text-left">Jump to…</span>
      {shortcut && (
        <kbd className="rounded border border-ink-200 bg-white px-1.5 font-sans text-[11px] font-medium leading-5 text-ink-500">
          {shortcut}
        </kbd>
      )}
    </button>
  );
}

/**
 * ⌘K / Ctrl+K anywhere: type to find a page (sub-pages included) or a create action, ↑↓ to move, Enter to go.
 * The highlight slides between results like the sidebar's.
 */
export function CommandPalette({ sections, actions }: { sections: NavSection[]; actions: NavAction[] }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    const onOpen = () => setOpen(true);
    document.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => {
      document.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN_EVENT, onOpen);
    };
  }, []);

  if (!open) return null;
  return createPortal(<PaletteDialog sections={sections} actions={actions} onClose={() => setOpen(false)} />, document.body);
}

function PaletteDialog({ sections, actions, onClose }: { sections: NavSection[]; actions: NavAction[]; onClose: () => void }) {
  const router = useRouter();
  const id = useId();
  const commands = useMemo(() => buildCommands(sections, actions), [sections, actions]);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const results = useMemo(() => filterCommands(commands, query), [commands, query]);
  // The picked row while it's still in the results; otherwise the top one.
  const activeKey = results.some((c) => c.key === picked) ? picked : (results[0]?.key ?? null);
  const { containerRef, indicatorRef } = useSlidingIndicator<HTMLUListElement, HTMLSpanElement>(activeKey);
  const rootRef = useRef<HTMLDivElement>(null);

  // Modal: the page behind can't be reached (focus, screen readers) or scrolled; focus goes back where it was.
  useEffect(() => {
    const returnTo = document.activeElement as HTMLElement | null;
    const background = [...document.body.children].filter((el) => !el.contains(rootRef.current) && !el.hasAttribute("inert"));
    background.forEach((el) => el.setAttribute("inert", ""));
    document.body.style.overflow = "hidden";
    return () => {
      background.forEach((el) => el.removeAttribute("inert"));
      document.body.style.overflow = "";
      returnTo?.focus?.();
    };
  }, []);

  // Keep the highlighted row in view while arrowing through a long list.
  useEffect(() => {
    if (!activeKey) return;
    document.getElementById(`${id}-${activeKey}`)?.scrollIntoView({ block: "nearest" });
  }, [activeKey, id]);

  const go = (c: Command) => {
    onClose();
    router.push(c.href);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const index = results.findIndex((c) => c.key === activeKey);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!results.length) return;
      const step = e.key === "ArrowDown" ? 1 : -1;
      setPicked(results[(index + step + results.length) % results.length].key);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (results[index]) go(results[index]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "Tab") {
      e.preventDefault(); // the field is the only stop
    }
  };

  const groups = (["Go to", "Create"] as const)
    .map((g) => ({ g, items: results.filter((c) => c.group === g) }))
    .filter((x) => x.items.length > 0);

  return (
    <div ref={rootRef} className="fixed inset-0 z-[60] flex items-start justify-center px-4 pt-[12vh]" role="dialog" aria-modal="true" aria-label="Command palette">
      <div className="absolute inset-0 bg-ink-900/40 motion-safe:animate-fade-in" onClick={onClose} aria-hidden />
      <div className="relative flex max-h-[min(32rem,76vh)] w-full max-w-lg flex-col overflow-hidden rounded-2xl bg-white shadow-2xl ring-1 ring-ink-900/10 motion-safe:animate-pop-in">
        <div className="flex items-center gap-3 border-b border-ink-100 px-4">
          <Search className="size-5 shrink-0 text-ink-400" aria-hidden />
          <input
            autoFocus
            role="combobox"
            aria-expanded="true"
            aria-controls={`${id}-list`}
            aria-activedescendant={activeKey ? `${id}-${activeKey}` : undefined}
            aria-autocomplete="list"
            aria-label="Search pages and actions"
            placeholder="Search pages and actions…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPicked(null);
            }}
            onKeyDown={onKeyDown}
            className="h-14 flex-1 bg-transparent text-base text-ink-900 outline-none placeholder:text-ink-400"
          />
          <kbd className="hidden rounded border border-ink-200 px-1.5 font-sans text-[11px] font-medium leading-5 text-ink-500 sm:block">Esc</kbd>
        </div>

        <ul ref={containerRef} id={`${id}-list`} role="listbox" aria-label="Results" className="group relative flex-1 overflow-y-auto overscroll-contain p-2">
          <span ref={indicatorRef} aria-hidden className={cn("pointer-events-none absolute left-0 top-0 rounded-lg bg-brand-50 opacity-0", INDICATOR_MOTION)} />
          {groups.length === 0 && <li className="px-3 py-10 text-center text-sm text-ink-500">Nothing matches “{query.trim()}”.</li>}
          {groups.map(({ g, items }) => (
            <li key={g} role="presentation">
              <p className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-ink-500" aria-hidden>
                {g}
              </p>
              <ul role="group" aria-label={g}>
                {items.map((c) => {
                  const active = c.key === activeKey;
                  const Icon = c.icon;
                  return (
                    <li
                      key={c.key}
                      id={`${id}-${c.key}`}
                      role="option"
                      aria-selected={active}
                      data-indicator-key={c.key}
                      onMouseMove={() => !active && setPicked(c.key)}
                      onClick={() => go(c)}
                      className={cn(
                        "relative flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 text-sm",
                        active ? "bg-brand-50 text-brand-800 group-data-[indicator=on]:bg-transparent" : "text-ink-700",
                      )}
                    >
                      <Icon className={cn("size-[18px] shrink-0", active ? "text-brand-600" : "text-ink-400")} aria-hidden />
                      <span className="flex-1 truncate font-medium">{c.label}</span>
                      <CountBubble count={c.count ?? 0} />
                      {c.hint && <span className="shrink-0 text-xs text-ink-400">{c.hint}</span>}
                      <CornerDownLeft className={cn("size-4 shrink-0 text-brand-500", !active && "invisible")} aria-hidden />
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
