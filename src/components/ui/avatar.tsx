import { cn } from "@/lib/cn";
import { portalPhotoPath } from "@/lib/user-photos";
import { AvatarPhoto } from "./avatar-photo";

const palette = [
  "bg-brand-100 text-brand-800",
  "bg-sky-100 text-sky-800",
  "bg-amber-100 text-amber-800",
  "bg-violet-100 text-violet-800",
  "bg-rose-100 text-rose-800",
  "bg-teal-100 text-teal-800",
];

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : (parts[0] ?? "?").slice(0, 2);
  return letters.toUpperCase();
}

function hash(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export interface AvatarProps {
  name: string;
  size?: "sm" | "md" | "lg";
  className?: string;
  /**
   * The person's photo (UserPhoto id) when they show one in the portal (getPortalPhotoMap; server components use
   * UserAvatar from components/app/user-avatar.tsx, which looks it up). Null/absent: their initials.
   */
  photoId?: string | null;
}

/**
 * A person's round avatar: their photo, or their initials on a color picked from their name. Decorative (the name is
 * always shown next to it), so it's hidden from screen readers. The photo covers the initials inside the same fixed
 * circle — nothing moves when it loads, and if it can't be loaded (replaced, removed, or hidden since the page was
 * drawn) it hides itself and the initials show (AvatarPhoto, a small client component: this one stays usable from server
 * and client components alike).
 */
export function Avatar({ name, size = "md", className, photoId }: AvatarProps) {
  const dims = { sm: "size-7 text-[11px]", md: "size-9 text-xs", lg: "size-12 text-sm" }[size];
  return (
    <span
      aria-hidden
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full font-semibold",
        dims,
        palette[hash(name) % palette.length],
        className,
      )}
    >
      {initials(name)}
      {photoId && <AvatarPhoto key={photoId} src={portalPhotoPath(photoId)} className="absolute inset-0 size-full object-cover" />}
    </span>
  );
}
