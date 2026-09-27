"use client";

import { useEffect, useRef, useState } from "react";
import type { Subteam } from "@/generated/prisma/enums";
import { CardBody } from "../ui/card";
import { AddCategoryForm } from "./add-category-form";
import { CategoryRow } from "./category-row";

/** How long a confirmation ("Added “Intake”.") stays on screen. */
const MESSAGE_MS = 6000;

/**
 * One subteam's categories on Manage → Categories, plus the add form. Owns the status line (the
 * latest add / rename / move / delete) and moves focus on after a delete: to the next row's "Rename",
 * or to the add field when the last row went.
 */
export function CategoryList({
  subteam,
  label,
  categories,
}: {
  /** "" = whole team. */
  subteam: "" | Subteam;
  label: string;
  categories: { id: string; name: string; taskCount: number }[];
}) {
  const [message, setMessage] = useState("");
  const listRef = useRef<HTMLUListElement>(null);
  const addInputRef = useRef<HTMLInputElement>(null);
  const focusAfterDelete = useRef<{ id: string; index: number } | null>(null);

  // A newer action replaces the message; otherwise it clears itself so it can't go stale
  // (e.g. "Added “X”." after X was renamed).
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(""), MESSAGE_MS);
    return () => clearTimeout(timer);
  }, [message]);

  useEffect(() => {
    const pending = focusAfterDelete.current;
    if (!pending || categories.some((c) => c.id === pending.id)) return;
    focusAfterDelete.current = null;
    const renameButtons = listRef.current?.querySelectorAll<HTMLButtonElement>("[data-rename]");
    (renameButtons?.[pending.index] ?? addInputRef.current)?.focus();
  }, [categories]);

  return (
    <>
      {categories.length === 0 ? (
        <p className="px-4 py-4 text-sm text-ink-500 sm:px-5">No categories yet. Tasks show up under “Other tasks” until you add some.</p>
      ) : (
        <ul ref={listRef} className="divide-y divide-ink-100" aria-label={`${label} categories`}>
          {categories.map((category, i) => (
            <li key={category.id} className="px-4 py-2 sm:px-5">
              <CategoryRow
                category={category}
                isFirst={i === 0}
                isLast={i === categories.length - 1}
                onMessage={setMessage}
                onDeleted={(text) => {
                  focusAfterDelete.current = { id: category.id, index: i };
                  setMessage(text);
                }}
              />
            </li>
          ))}
        </ul>
      )}
      <CardBody className="border-t border-ink-100">
        <AddCategoryForm subteam={subteam} listLabel={label} focusAfterAdd inputRef={addInputRef} onAdded={setMessage} />
        {/* Always rendered so screen readers announce each change. */}
        <p role="status" className="mt-1.5 text-sm text-brand-700 empty:mt-0">
          {message}
        </p>
      </CardBody>
    </>
  );
}
