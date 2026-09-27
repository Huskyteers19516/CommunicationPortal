import Link from "next/link";
import type { ComponentProps } from "react";
import { cn } from "@/lib/cn";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "success";
/** `icon`: a 40×40 square holding just an icon — give it an aria-label. */
export type ButtonSize = "sm" | "md" | "lg" | "icon";

const base =
  "inline-flex items-center justify-center rounded-lg font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60 whitespace-nowrap select-none";

const variants: Record<ButtonVariant, string> = {
  primary: "bg-brand-600 text-white shadow-sm hover:bg-brand-700 active:bg-brand-800",
  secondary: "bg-white text-ink-800 border border-ink-200 shadow-sm hover:bg-ink-50 active:bg-ink-100",
  ghost: "text-ink-700 hover:bg-ink-100 active:bg-ink-200",
  danger: "bg-red-600 text-white shadow-sm hover:bg-red-700 active:bg-red-800",
  success: "bg-brand-700 text-white shadow-sm hover:bg-brand-800 active:bg-brand-900",
};

const sizes: Record<ButtonSize, string> = {
  sm: "h-8 gap-2 text-sm",
  md: "h-10 gap-2 text-sm",
  lg: "h-12 gap-2 text-base",
  // A tighter gap so the pending spinner still fits next to the icon.
  icon: "size-10 shrink-0 gap-1 text-sm",
};

/** Kept apart from `sizes` so a caller's own padding can replace it (see below). */
const paddings: Record<ButtonSize, string> = {
  sm: "px-3",
  md: "px-4",
  lg: "px-5",
  icon: "p-0",
};

/**
 * Tailwind settles conflicting utilities by their order in the stylesheet, not in the class list, so a
 * caller's "px-3" next to the size's "px-4" would be silently ignored. When `className` brings its own
 * (unprefixed) `p-*` / `px-*`, the size's padding is left out. Responsive ones (`sm:px-3`) already win.
 */
const OWN_PADDING = /(?:^|\s)px?-\S/;

export function buttonClasses(variant: ButtonVariant = "primary", size: ButtonSize = "md", className?: string) {
  return cn(base, variants[variant], sizes[size], !(className && OWN_PADDING.test(className)) && paddings[size], className);
}

export function Button({
  variant = "primary",
  size = "md",
  className,
  type = "button",
  ...props
}: ComponentProps<"button"> & { variant?: ButtonVariant; size?: ButtonSize }) {
  return <button type={type} className={buttonClasses(variant, size, className)} {...props} />;
}

export function ButtonLink({
  variant = "primary",
  size = "md",
  className,
  ...props
}: ComponentProps<typeof Link> & { variant?: ButtonVariant; size?: ButtonSize }) {
  return <Link className={buttonClasses(variant, size, className)} {...props} />;
}
