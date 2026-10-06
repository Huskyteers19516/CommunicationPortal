import "server-only";
// Server components' avatars with members' photos: they look the photo up by user id in getPortalPhotoMap() (one read
// per page render, however many avatars it draws — src/server/queries/user-photos.ts) and draw the client-safe Avatar
// / UserChip with it. Client components get photo ids in their props instead (photoIdsFor) and use Avatar directly.
import type { ComponentProps } from "react";
import { getPortalPhotoMap } from "@/server/queries/user-photos";
import { Avatar, type AvatarProps } from "../ui/avatar";
import { UserChip } from "./user-chip";

async function photoFor(userId: string | null | undefined): Promise<string | null> {
  if (!userId) return null;
  return (await getPortalPhotoMap()).get(userId) ?? null;
}

/** Avatar with the person's photo when they show one in the portal (else initials). `userId` null: initials. */
export async function UserAvatar({ userId, ...props }: Omit<AvatarProps, "photoId"> & { userId: string | null | undefined }) {
  return <Avatar {...props} photoId={await photoFor(userId)} />;
}

/** UserChip with the person's photo when they show one in the portal (else initials). */
export async function UserChipWithPhoto({
  userId,
  ...props
}: Omit<ComponentProps<typeof UserChip>, "photoId"> & { userId: string | null | undefined }) {
  return <UserChip {...props} photoId={await photoFor(userId)} />;
}
