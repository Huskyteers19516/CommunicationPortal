"use client";

import { useCallback, useState } from "react";
import { cn } from "@/lib/cn";

/**
 * Whether an <img> finished without a picture — a 404 (the photo was replaced, removed, or hidden after the page was
 * drawn), or the sign-in page instead of the photo. A picture that's still loading (or not started: lazy) isn't.
 */
export function imageFailed(img: Pick<HTMLImageElement, "complete" | "naturalWidth">): boolean {
  return img.complete && img.naturalWidth === 0;
}

/**
 * A member's photo laid over what's under it (Avatar's initials, the Settings preview's initials). If it can't be
 * loaded it's hidden (`invisible`, so no broken-picture icon covers the initials), also when that happened before the
 * page's script started (checked once it's on the page); it shows again if it loads after all. Same box either way, so
 * nothing moves. `alt=""` by default (the name is always next to it). Remount it per photo (`key`).
 */
export function AvatarPhoto({
  src,
  alt = "",
  className,
  lazy = true,
}: {
  src: string;
  alt?: string;
  className?: string;
  /** Off-screen avatars load when scrolled near. */
  lazy?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  // An error before hydration fires no onError: look once it's on the page.
  const ref = useCallback((img: HTMLImageElement | null) => {
    if (img && imageFailed(img)) setFailed(true);
  }, []);
  return (
    // eslint-disable-next-line @next/next/no-img-element -- an uploaded photo served by our own route (immutable)
    <img
      ref={ref}
      src={src}
      alt={alt}
      loading={lazy ? "lazy" : undefined}
      decoding="async"
      draggable={false}
      data-failed={failed ? "" : undefined}
      className={cn(className, failed && "invisible")}
      onError={() => setFailed(true)}
      onLoad={() => setFailed(false)}
    />
  );
}
