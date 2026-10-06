"use server";

import { revalidatePath } from "next/cache";
import type { ActionState } from "@/lib/action-state";
import { formDataToObject, runAction } from "@/server/action";
import { getCurrentSessionTokenHash } from "@/server/auth/session";
import { getServiceContext } from "@/server/context";
import { scheduleFileCleanup } from "@/server/files/cleanup";
import { readFormFile } from "@/server/files/upload";
import {
  changePassword,
  signOutOtherDevices,
  updateNotificationPrefs,
  updateProfile,
  updatePublicProgressVisibility,
} from "@/server/services/settings";
import { removeUserPhoto, updatePhotoVisibility, uploadUserPhoto } from "@/server/services/user-photos";

export async function updateProfileAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(
    async () => {
      const ctx = await getServiceContext();
      const { photoHeld } = await updateProfile(ctx, formDataToObject(formData));
      revalidatePath("/", "layout");
      if (photoHeld) return "Profile saved. Your photo is off the team website until a leader checks your new name (My photo, below).";
    },
    { success: "Profile saved.", formData },
  );
}

export async function updateNotificationPrefsAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(
    async () => {
      const ctx = await getServiceContext();
      await updateNotificationPrefs(ctx, formDataToObject(formData));
      revalidatePath("/", "layout");
    },
    { success: "Email preferences saved.", formData },
  );
}

export async function updatePublicProgressVisibilityAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(async () => {
    const ctx = await getServiceContext();
    const { show } = await updatePublicProgressVisibility(ctx, formDataToObject(formData));
    revalidatePath("/", "layout");
    return show ? "You're shown on the team website." : "You're no longer listed on the team website.";
  });
}

/** Settings → My photo: save (or replace) your photo, made square and small by the browser. */
export async function uploadMyPhotoAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(async () => {
    const ctx = await getServiceContext();
    const { replaced } = await uploadUserPhoto(ctx, { file: await readFormFile(formData) });
    if (replaced) scheduleFileCleanup(); // the old photo's file
    revalidatePath("/", "layout");
    return replaced ? "Photo replaced." : "Photo saved.";
  });
}

/** Settings → My photo: remove your photo (from the portal and the team website). */
export async function removeMyPhotoAction(_prev: ActionState, _formData: FormData): Promise<ActionState> {
  void _formData;
  return runAction(async () => {
    const ctx = await getServiceContext();
    await removeUserPhoto(ctx, {});
    scheduleFileCleanup();
    revalidatePath("/", "layout");
    return "Photo removed. Your initials show instead.";
  });
}

/** Settings → My photo: "Show my photo in the portal" / "… on the team website". */
export async function updatePhotoVisibilityAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(async () => {
    const ctx = await getServiceContext();
    const { which, show, held } = await updatePhotoVisibility(ctx, formDataToObject(formData));
    revalidatePath("/", "layout");
    if (which === "portal") return show ? "Your photo shows in the portal." : "The team sees your initials in the portal now.";
    if (held) return "Switched on. Your photo goes on the team website once someone who manages your account allows it.";
    return show
      ? "Your photo goes on the team website within a few minutes."
      : "Your photo comes off the team website within a few minutes.";
  });
}

export async function changePasswordAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(
    async () => {
      const ctx = await getServiceContext();
      const keepSessionTokenHash = await getCurrentSessionTokenHash();
      await changePassword(ctx, formDataToObject(formData), { keepSessionTokenHash });
      revalidatePath("/", "layout");
    },
    { success: "Password updated. Other devices were signed out.", formData },
  );
}

export async function signOutOtherDevicesAction(_prev: ActionState, _formData: FormData): Promise<ActionState> {
  void _formData;
  return runAction(async () => {
    const ctx = await getServiceContext();
    const keepSessionTokenHash = await getCurrentSessionTokenHash();
    const { count } = await signOutOtherDevices(ctx, { keepSessionTokenHash });
    revalidatePath("/", "layout");
    if (count === 0) return "You weren't signed in anywhere else. Only this device is signed in.";
    return `Signed out of ${count} other ${count === 1 ? "device" : "devices"}. Only this device is signed in now.`;
  });
}
