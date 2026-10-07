"use client";

// The editable spots of the page shown in the editor frame (grouped by where they sit, searchable, "Edited" when a
// saved value replaces the website's own), and the editor for the one picked — here or by clicking it in the frame.
import { Image as ImageIcon, Link2, MousePointerClick, Search, Type } from "lucide-react";
import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/field";
import { cn } from "@/lib/cn";
import { type SiteSlot, type SiteSlotKind, siteSlotGroup } from "@/lib/public-site-content";
import type { SiteContentEntry } from "@/server/queries/site-content";
import { SlotEditor } from "./slot-editor";

const KIND_ICON: Record<SiteSlotKind, typeof Type> = { text: Type, link: Link2, image: ImageIcon };
const KIND_LABEL: Record<SiteSlotKind, string> = { text: "Text", link: "Link", image: "Picture" };

export function SlotPanel({
  page,
  entries,
  selectedKey,
  onSelect,
  siteUrl,
}: {
  /** The page shown in the frame, once it said it's ready. */
  page: { path: string; slots: SiteSlot[] } | null;
  entries: SiteContentEntry[];
  selectedKey: string | null;
  onSelect: (key: string) => void;
  siteUrl: string;
}) {
  const [query, setQuery] = useState("");
  const byKey = useMemo(() => new Map(entries.map((e) => [e.key, e])), [entries]);
  const slots = useMemo(() => page?.slots ?? [], [page]);
  const selected = selectedKey ? (slots.find((s) => s.key === selectedKey) ?? null) : null;

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const shown = q
      ? slots.filter((s) => s.label.toLowerCase().includes(q) || s.key.includes(q) || s.defaultValue.toLowerCase().includes(q))
      : slots;
    const out = new Map<string, SiteSlot[]>();
    for (const s of shown) {
      const g = siteSlotGroup(s.key);
      const list = out.get(g);
      if (list) list.push(s);
      else out.set(g, [s]);
    }
    return [...out.entries()];
  }, [slots, query]);

  const editedHere = slots.filter((s) => byKey.has(s.key)).length;

  return (
    <div className="space-y-4 xl:sticky xl:top-4">
      <Card>
        <CardHeader
          title={selected ? selected.label : "Pick something to change"}
          description={selected ? `${KIND_LABEL[selected.kind]} · ${selected.key}` : "Click it in the website, or choose it from the list below."}
        />
        <CardBody>
          {selected ? (
            <SlotEditor key={selected.key} slot={selected} entry={byKey.get(selected.key) ?? null} siteUrl={siteUrl} pagePath={page?.path ?? "/"} />
          ) : (
            <EmptyState
              icon={MousePointerClick}
              title="Nothing picked yet"
              description="Everything outlined on the website can be changed: text, links, and pictures."
              className="py-6"
            />
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="On this page"
          description={
            page
              ? `${slots.length} ${slots.length === 1 ? "spot" : "spots"} you can change${editedHere > 0 ? ` · ${editedHere} changed` : ""}`
              : "Waiting for the website…"
          }
        />
        <div className="space-y-3 px-4 py-3 sm:px-5">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-400" aria-hidden />
            <label htmlFor="slot-search" className="sr-only">
              Search this page&apos;s spots
            </label>
            <Input
              id="slot-search"
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search text, links, pictures…"
              className="pl-9"
            />
          </div>
          {groups.length === 0 ? (
            <p className="py-4 text-center text-sm text-ink-500">
              {!page ? "The list fills in once the website has loaded." : query ? "Nothing on this page matches." : "This page has nothing to change yet."}
            </p>
          ) : (
            <div className="max-h-[32rem] space-y-4 overflow-y-auto pr-1">
              {groups.map(([group, list]) => (
                <section key={group} aria-label={group}>
                  <h3 className="mb-1 text-xs font-semibold uppercase tracking-wider text-ink-500 wrap-anywhere">{group}</h3>
                  <ul className="space-y-1">
                    {list.map((s) => {
                      const Icon = KIND_ICON[s.kind];
                      const active = s.key === selectedKey;
                      return (
                        <li key={s.key}>
                          <button
                            type="button"
                            onClick={() => onSelect(s.key)}
                            aria-current={active || undefined}
                            className={cn(
                              "flex min-h-10 w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm",
                              active ? "bg-brand-50 text-brand-900 ring-1 ring-brand-200" : "text-ink-800 hover:bg-ink-50",
                            )}
                          >
                            <Icon className="size-4 shrink-0 text-ink-400" aria-label={KIND_LABEL[s.kind]} />
                            <span className="min-w-0 flex-1 truncate">{s.label}</span>
                            {byKey.has(s.key) && <Badge tone="brand">Edited</Badge>}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}
