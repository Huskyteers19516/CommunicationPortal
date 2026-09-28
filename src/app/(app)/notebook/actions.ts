"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { ActionState } from "@/lib/action-state";
import { formDataToObject, runAction } from "@/server/action";
import { getServiceContext, type ServiceContext } from "@/server/context";
import { readFormFile } from "@/server/files/upload";
import {
  addNotebookImage,
  clearNotebookEntryVersion,
  createNotebook,
  createNotebookEntry,
  createNotebookPage,
  createStandardNotebooks,
  deleteNotebook,
  deleteNotebookEntry,
  deleteNotebookPage,
  moveNotebook,
  moveNotebookPage,
  removeNotebookImage,
  renameNotebookPage,
  updateNotebook,
  updateNotebookEntry,
} from "@/server/services/notebook";

// Team notebook actions. Every service re-checks permissions and state from the database.

/** An entry save also says which entry it was, so the editor can add the pictures to it next. */
export type EntryActionState = (NonNullable<ActionState> & { entryId?: string }) | null;

/**
 * The buttons and small forms on the notebook pages. The page is refreshed even when the action fails, so a
 * stale page catches up (e.g. a page someone else just deleted).
 */
async function inline(
  formData: FormData,
  service: (ctx: ServiceContext, raw: unknown) => Promise<unknown>,
  success?: string,
): Promise<ActionState> {
  return runAction(
    async () => {
      const ctx = await getServiceContext();
      try {
        await service(ctx, formDataToObject(formData));
      } finally {
        revalidatePath("/", "layout");
      }
    },
    { success, formData },
  );
}

// ---------- notebooks ----------

export async function createNotebookAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(
    async () => {
      const ctx = await getServiceContext();
      const { id } = await createNotebook(ctx, formDataToObject(formData));
      revalidatePath("/", "layout");
      redirect(`/notebook?added=${encodeURIComponent(id)}#notebook-${encodeURIComponent(id)}`);
    },
    { formData },
  );
}

export async function updateNotebookAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(
    async () => {
      const ctx = await getServiceContext();
      const { id } = await updateNotebook(ctx, formDataToObject(formData));
      revalidatePath("/", "layout");
      redirect(`/notebook?saved=${encodeURIComponent(id)}#notebook-${encodeURIComponent(id)}`);
    },
    { formData },
  );
}

/** Delete from the notebook's edit page, then back to the list ("?removed=1" says it's gone). */
export async function deleteNotebookAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(
    async () => {
      const ctx = await getServiceContext();
      await deleteNotebook(ctx, formDataToObject(formData));
      revalidatePath("/", "layout");
      redirect("/notebook?removed=1");
    },
    { formData },
  );
}

export async function moveNotebookAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return inline(formData, moveNotebook);
}

/** One click for the usual notebooks, then back to the list ("?created=1" says they're ready). */
export async function createStandardNotebooksAction(): Promise<ActionState> {
  return runAction(async () => {
    const ctx = await getServiceContext();
    try {
      await createStandardNotebooks(ctx);
    } finally {
      revalidatePath("/", "layout");
    }
    redirect("/notebook?created=1");
  });
}

// ---------- pages ----------

export async function createNotebookPageAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return inline(formData, createNotebookPage, "Page added.");
}

export async function renameNotebookPageAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return inline(formData, renameNotebookPage, "Page renamed.");
}

export async function moveNotebookPageAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return inline(formData, moveNotebookPage);
}

export async function deleteNotebookPageAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return inline(formData, deleteNotebookPage, "Page deleted.");
}

// ---------- entries ----------

export async function createNotebookEntryAction(_prev: ActionState, formData: FormData): Promise<EntryActionState> {
  let entryId: string | undefined;
  const result = await runAction(
    async () => {
      const ctx = await getServiceContext();
      ({ id: entryId } = await createNotebookEntry(ctx, formDataToObject(formData)));
      revalidatePath("/", "layout");
    },
    { success: "Entry saved.", formData },
  );
  return result?.ok ? { ...result, entryId } : result;
}

export async function updateNotebookEntryAction(_prev: ActionState, formData: FormData): Promise<EntryActionState> {
  let entryId: string | undefined;
  const result = await runAction(
    async () => {
      const ctx = await getServiceContext();
      try {
        ({ id: entryId } = await updateNotebookEntry(ctx, formDataToObject(formData)));
      } finally {
        revalidatePath("/", "layout");
      }
    },
    { success: "Changes saved.", formData },
  );
  return result?.ok ? { ...result, entryId } : result;
}

export async function deleteNotebookEntryAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return inline(formData, deleteNotebookEntry, "Entry deleted.");
}

/** Take an old version's text out of an entry's history (fields: editId). */
export async function clearNotebookVersionAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return inline(formData, clearNotebookEntryVersion, "Taken out of the history.");
}

/** Add one picture to an entry (fields: entryId, file). One per request: each can be up to 4 MB. */
export async function addNotebookImageAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(async () => {
    const ctx = await getServiceContext();
    try {
      await addNotebookImage(ctx, { ...formDataToObject(formData), file: await readFormFile(formData) });
    } finally {
      revalidatePath("/", "layout");
    }
  });
}

export async function removeNotebookImageAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return inline(formData, removeNotebookImage);
}
