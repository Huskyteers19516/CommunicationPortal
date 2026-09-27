"use client";

import { FolderPlus, Plus, Settings2 } from "lucide-react";
import Link from "next/link";
import { useId, useRef, useState } from "react";
import type { Subteam } from "@/generated/prisma/enums";
import { cn } from "@/lib/cn";
import { AddCategoryForm } from "../categories/add-category-form";
import { ButtonLink } from "../ui/button";

const iconButton =
  "inline-flex h-10 shrink-0 items-center justify-center gap-1.5 rounded-lg text-sm font-medium text-ink-600 transition-colors hover:bg-white hover:text-brand-700";

/**
 * A dashboard section's heading. Managers also get a row of controls: "Category" (add one inline),
 * a link to manage the categories, and "New task". Focus moves into the form when it opens and back
 * to "Category" when it closes.
 *
 * `reserveControlsRow`: in the 3-column layout, sections without controls keep an empty row of the
 * same height on wide screens so every column's first category lines up.
 */
export function BoardSectionHeader({
  headingId,
  sectionKey,
  label,
  taskCount,
  canManage,
  reserveControlsRow = false,
}: {
  headingId: string;
  /** "BUILD" / "TEAM"… */
  sectionKey: Subteam | "TEAM";
  label: string;
  taskCount: number;
  canManage: boolean;
  reserveControlsRow?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const addRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const subteamValue: "" | Subteam = sectionKey === "TEAM" ? "" : sectionKey;

  function close() {
    setOpen(false);
    // Focus "Category" again once the form is gone.
    requestAnimationFrame(() => addRef.current?.focus());
  }

  function toggle() {
    if (open) return close();
    setAnnouncement("");
    setOpen(true);
  }

  return (
    <div>
      <h2 id={headingId} className="flex min-h-10 min-w-0 items-center text-base font-semibold text-ink-900">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="truncate">{label}</span>
          <span className="shrink-0 text-sm font-normal tabular-nums text-ink-500">
            {taskCount} {taskCount === 1 ? "task" : "tasks"}
          </span>
        </span>
      </h2>
      {canManage ? (
        <>
          <div className="-ml-2.5 mt-1 flex flex-wrap items-center gap-1">
            <button
              ref={addRef}
              type="button"
              aria-expanded={open}
              aria-controls={open ? panelId : undefined}
              aria-label={`Add a category to ${label}`}
              title={open ? "Close" : "Add a category"}
              onClick={toggle}
              className={cn(iconButton, "px-2.5", open && "bg-white text-brand-700 ring-1 ring-inset ring-ink-200")}
            >
              <FolderPlus className="size-4" aria-hidden />
              Category
            </button>
            <Link
              href={`/manage/categories#${sectionKey}`}
              aria-label={`Manage ${label} categories`}
              title="Manage categories"
              className={cn(iconButton, "w-10")}
            >
              <Settings2 className="size-5" aria-hidden />
            </Link>
            <ButtonLink href={`/manage/tasks/new?subteam=${sectionKey}`} variant="secondary" className="ml-auto">
              <Plus className="size-4" aria-hidden />
              New task
            </ButtonLink>
          </div>
          <p role="status" className="sr-only">
            {announcement}
          </p>
          {open && (
            <div id={panelId} className="mt-2 rounded-lg border border-ink-200 bg-white p-3">
              <AddCategoryForm
                subteam={subteamValue}
                listLabel={label}
                autoFocus
                onCancel={close}
                onAdded={(message) => {
                  setAnnouncement(message);
                  close();
                }}
              />
            </div>
          )}
        </>
      ) : (
        reserveControlsRow && <div aria-hidden className="mt-1 hidden h-10 xl:block" />
      )}
    </div>
  );
}
