"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  APPROVED_MESSAGE,
  DISCORD_TEST_MESSAGES,
  REJECTED_MESSAGE,
  RESET_LINK_OWNER_ONLY,
  type ResetLinkState,
  TEST_EMAIL_MESSAGES,
} from "@/components/admin/messages";
import type { ActionState } from "@/lib/action-state";
import { formDataToObject, runAction } from "@/server/action";
import { getServiceContext } from "@/server/context";
import { getTransport } from "@/server/email/transport";
import { ConflictError } from "@/server/errors";
import {
  cleanUpFileStorage,
  cleanUpMessage,
  connectionTestMessage,
  moveFilesToObjectStorage,
  moveResultMessage,
  testFileStorage,
} from "@/server/services/file-storage";
import {
  approveUser,
  deleteUser,
  rejectUser,
  revokeSessions,
  sendDiscordTest,
  sendPasswordResetLink,
  sendTestEmail,
  updateUser,
} from "@/server/services/admin";

export async function approveUserAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(
    async () => {
      const ctx = await getServiceContext();
      await approveUser(ctx, formDataToObject(formData));
      revalidatePath("/", "layout");
    },
    { success: APPROVED_MESSAGE, formData },
  );
}

export async function rejectUserAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(
    async () => {
      const ctx = await getServiceContext();
      await rejectUser(ctx, formDataToObject(formData));
      revalidatePath("/", "layout");
    },
    { success: REJECTED_MESSAGE, formData },
  );
}

export async function updateUserAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(
    async () => {
      const ctx = await getServiceContext();
      await updateUser(ctx, formDataToObject(formData));
      revalidatePath("/", "layout");
    },
    { success: "Changes saved.", formData },
  );
}

/** Creates a one-time reset link, emails it when email is set up, and hands it to the admin once. */
export async function sendPasswordResetAction(_prev: ResetLinkState, formData: FormData): Promise<ResetLinkState> {
  const out: { resetUrl?: string | null } = {};
  const state = await runAction(
    async () => {
      const ctx = await getServiceContext();
      out.resetUrl = (await sendPasswordResetLink(ctx, formDataToObject(formData))).resetUrl;
      revalidatePath("/", "layout");
    },
    { success: "Reset link created.", formData },
  );
  if (!state?.ok) return state;
  // The email itself goes out after the response; without a transport it is only logged.
  const emailed = getTransport() !== null;
  // Only owners get the link back; everyone else relies on the email.
  if (!out.resetUrl) {
    return emailed
      ? { ...state, message: "A reset link is on its way to their email.", emailed }
      : { ok: false, message: RESET_LINK_OWNER_ONLY, nonce: state.nonce };
  }
  return { ...state, resetUrl: out.resetUrl, emailed };
}

export async function revokeSessionsAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(
    async () => {
      const ctx = await getServiceContext();
      const { count } = await revokeSessions(ctx, formDataToObject(formData));
      revalidatePath("/", "layout");
      return count === 0 ? "They weren't signed in anywhere." : `Signed out of ${count} device${count === 1 ? "" : "s"}.`;
    },
    { formData },
  );
}

export async function deleteUserAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(
    async () => {
      const ctx = await getServiceContext();
      await deleteUser(ctx, formDataToObject(formData));
      revalidatePath("/", "layout");
      redirect("/admin/users?deleted=1");
    },
    { formData },
  );
}

export async function sendTestEmailAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(
    async () => {
      const ctx = await getServiceContext();
      const status = await sendTestEmail(ctx);
      revalidatePath("/", "layout");
      if (status === "FAILED") throw new ConflictError(TEST_EMAIL_MESSAGES.FAILED);
      return TEST_EMAIL_MESSAGES[status];
    },
    { formData },
  );
}

export async function sendDiscordTestAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(
    async () => {
      const ctx = await getServiceContext();
      const status = await sendDiscordTest(ctx);
      revalidatePath("/", "layout");
      if (status === "FAILED") throw new ConflictError(DISCORD_TEST_MESSAGES.FAILED);
      return DISCORD_TEST_MESSAGES[status];
    },
    { formData },
  );
}

// ---------- File storage (owners; Admin → Approvals → File storage) ----------

/** Saves, reads back, and deletes a tiny file in Cloudflare R2. */
export async function testFileStorageAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(
    async () => {
      const ctx = await getServiceContext();
      const result = await testFileStorage(ctx);
      const message = connectionTestMessage(result);
      if (!result.ok) throw new ConflictError(message);
      return message;
    },
    { formData },
  );
}

/** Moves a batch of files from the database to Cloudflare R2 (click again to continue). */
export async function moveFilesToObjectStorageAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(
    async () => {
      const ctx = await getServiceContext();
      try {
        const result = await moveFilesToObjectStorage(ctx);
        const message = moveResultMessage(result);
        if (result.moved === 0 && result.error) throw new ConflictError(message);
        return message;
      } finally {
        revalidatePath("/admin");
      }
    },
    { formData },
  );
}

/** Deletes waiting R2 objects of removed files. */
export async function cleanUpFileStorageAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(
    async () => {
      const ctx = await getServiceContext();
      try {
        const result = await cleanUpFileStorage(ctx);
        const message = cleanUpMessage(result);
        if (result.deleted + result.kept === 0 && result.error) throw new ConflictError(message);
        return message;
      } finally {
        revalidatePath("/admin");
      }
    },
    { formData },
  );
}
