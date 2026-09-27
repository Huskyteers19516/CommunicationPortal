import "server-only";
// Task categories for the task form (pick one) and Manage → Categories (rename / reorder / delete).

import type { Subteam } from "@/generated/prisma/enums";
import { SUBTEAMS } from "@/lib/constants";
import type { Actor } from "../actor";
import { type Db, prisma } from "../db";
import { canCreateTask, canManageCategories, isStaff } from "../permissions";
import { type BoardSectionKey, sectionKeyOf, sectionLabel } from "./board";

type ActorLike = Pick<Actor, "id" | "role" | "subteam" | "isAdmin">;

export interface CategoryOption {
  id: string;
  name: string;
}

/**
 * Categories keyed by the task form's subteam value ("" = whole team), for every subteam the actor can
 * create tasks in, in display order. Subteams without categories map to an empty list.
 */
export type TaskFormCategories = Partial<Record<"" | Subteam, CategoryOption[]>>;

const ALL_LISTS: (Subteam | null)[] = [...SUBTEAMS, null];

export async function getTaskFormCategories(actor: ActorLike, db: Db = prisma): Promise<TaskFormCategories> {
  if (!isStaff(actor)) return {};
  const lists = ALL_LISTS.filter((s) => canCreateTask(actor, s));
  if (lists.length === 0) return {};
  const rows = await db.taskCategory.findMany({
    where: { OR: lists.map((subteam) => ({ subteam })) },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    select: { id: true, name: true, subteam: true },
  });
  const out: TaskFormCategories = {};
  for (const s of lists) out[s ?? ""] = [];
  for (const r of rows) out[r.subteam ?? ""]?.push({ id: r.id, name: r.name });
  return out;
}

export interface ManagedCategory {
  id: string;
  name: string;
  /** Tasks sorted under it (any due date). */
  taskCount: number;
}

export interface ManagedCategoryList {
  key: BoardSectionKey;
  subteam: Subteam | null;
  label: string;
  categories: ManagedCategory[];
}

/** One list per subteam the actor manages categories for (leaders: their own; all-scope: every subteam + whole team). */
export async function getManagedCategoryLists(actor: ActorLike, db: Db = prisma): Promise<ManagedCategoryList[]> {
  if (!isStaff(actor)) return [];
  const lists = ALL_LISTS.filter((s) => canManageCategories(actor, s));
  if (lists.length === 0) return [];
  const rows = await db.taskCategory.findMany({
    where: { OR: lists.map((subteam) => ({ subteam })) },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    select: { id: true, name: true, subteam: true, _count: { select: { tasks: true } } },
  });
  return lists.map((subteam) => {
    const key = sectionKeyOf(subteam);
    return {
      key,
      subteam,
      label: sectionLabel(key),
      categories: rows.filter((r) => r.subteam === subteam).map((r) => ({ id: r.id, name: r.name, taskCount: r._count.tasks })),
    };
  });
}
