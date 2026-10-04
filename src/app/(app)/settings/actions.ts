"use server";

import { revalidatePath } from "next/cache";
import type { ActionState } from "@/lib/action-state";
import { formDataToObject, runAction } from "@/server/action";
import { getCurrentSessionTokenHash } from "@/server/auth/session";
import { getServiceContext } from "@/server/context";
import {
  changePassword,
  signOutOtherDevices,
  updateNotificationPrefs,
  updateProfile,
  updatePublicProgressVisibility,
} from "@/server/services/settings";

export async function updateProfileAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(
    async () => {
      const ctx = await getServiceContext();
      await updateProfile(ctx, formDataToObject(formData));
      revalidatePath("/", "layout");
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
