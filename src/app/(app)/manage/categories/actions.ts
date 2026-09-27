"use server";

import { revalidatePath } from "next/cache";
import type { ActionState } from "@/lib/action-state";
import { formDataToObject, runAction } from "@/server/action";
import { getServiceContext } from "@/server/context";
import { createCategory, deleteCategory, moveCategory, renameCategory } from "@/server/services/categories";

// Task categories (Manage → Categories, and "+" on the Task dashboard). Services check permissions.

/** Fields: subteam ("" = whole team), name. */
export async function createCategoryAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(
    async () => {
      const ctx = await getServiceContext();
      await createCategory(ctx, formDataToObject(formData));
      revalidatePath("/", "layout");
      const name = String(formData.get("name") ?? "").replace(/\s+/g, " ").trim();
      return `Added “${name}”.`;
    },
    { formData },
  );
}

/** Fields: categoryId, name. */
export async function renameCategoryAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(
    async () => {
      const ctx = await getServiceContext();
      await renameCategory(ctx, formDataToObject(formData));
      revalidatePath("/", "layout");
    },
    { success: "Renamed.", formData },
  );
}

/** Fields: categoryId. */
export async function deleteCategoryAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(
    async () => {
      const ctx = await getServiceContext();
      await deleteCategory(ctx, formDataToObject(formData));
      revalidatePath("/", "layout");
    },
    { success: "Category deleted." },
  );
}

/** Fields: categoryId, direction ("up" | "down"). */
export async function moveCategoryAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(async () => {
    const ctx = await getServiceContext();
    await moveCategory(ctx, formDataToObject(formData));
    revalidatePath("/", "layout");
  });
}
