import { Children, cloneElement, isValidElement, type ComponentProps, type ReactElement, type ReactNode } from "react";
import { cn } from "@/lib/cn";

const control =
  "block w-full rounded-lg border bg-white px-3 text-sm text-ink-900 shadow-sm placeholder:text-ink-400 transition-colors focus:outline-none focus:ring-2 disabled:bg-ink-50 disabled:text-ink-500";

function border(invalid?: boolean) {
  // Border + focus ring together, so an invalid field stays red while focused (no competing focus colors).
  return invalid
    ? "border-red-400 focus:border-red-500 focus:ring-red-500/25"
    : "border-ink-200 focus:border-brand-500 focus:ring-brand-500/25";
}

export function Input({ className, invalid, ...props }: ComponentProps<"input"> & { invalid?: boolean }) {
  return <input aria-invalid={invalid || undefined} className={cn(control, border(invalid), "h-10", className)} {...props} />;
}

export function Textarea({ className, invalid, ...props }: ComponentProps<"textarea"> & { invalid?: boolean }) {
  return (
    <textarea
      aria-invalid={invalid || undefined}
      className={cn(control, border(invalid), "min-h-24 py-2 leading-relaxed", className)}
      {...props}
    />
  );
}

export function Select({ className, invalid, ...props }: ComponentProps<"select"> & { invalid?: boolean }) {
  return <select aria-invalid={invalid || undefined} className={cn(control, border(invalid), "h-10 pr-8", className)} {...props} />;
}

export function Label({ className, ...props }: ComponentProps<"label">) {
  return <label className={cn("block text-sm font-medium text-ink-800", className)} {...props} />;
}

export function FieldError({ children, id }: { children?: ReactNode; id?: string }) {
  if (!children) return null;
  return (
    <p id={id} className="mt-1 text-sm text-red-600">
      {children}
    </p>
  );
}

/** Adds `hintId` to a single child control's aria-describedby so screen readers announce the hint. */
function withDescription(children: ReactNode, hintId: string | undefined): ReactNode {
  if (!hintId || Children.count(children) !== 1 || !isValidElement(children)) return children;
  const child = children as ReactElement<{ "aria-describedby"?: string }>;
  const existing = child.props["aria-describedby"];
  return cloneElement(child, { "aria-describedby": existing ? `${existing} ${hintId}` : hintId });
}

/** Label + control + hint + error, with consistent spacing. The hint is linked to a single child control automatically. */
export function Field({
  label,
  htmlFor,
  hint,
  error,
  children,
  className,
  optional,
}: {
  label: ReactNode;
  htmlFor: string;
  hint?: ReactNode;
  error?: string;
  children: ReactNode;
  className?: string;
  optional?: boolean;
}) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <Label htmlFor={htmlFor}>
        {label}
        {/* A real space, so screen readers say "Contact name (optional)", not "name(optional)". */}
        {optional && <span className="font-normal text-ink-500"> (optional)</span>}
      </Label>
      {withDescription(children, hint && !error ? `${htmlFor}-hint` : undefined)}
      {hint && !error && (
        <p id={`${htmlFor}-hint`} className="text-xs text-ink-500">
          {hint}
        </p>
      )}
      <FieldError id={`${htmlFor}-error`}>{error}</FieldError>
    </div>
  );
}

/** A checkbox with a label and optional description. */
export function CheckboxField({
  label,
  description,
  className,
  ...props
}: ComponentProps<"input"> & { label: ReactNode; description?: ReactNode }) {
  return (
    <label className={cn("flex cursor-pointer items-start gap-3", className)}>
      <input type="checkbox" className="mt-0.5 size-4 shrink-0 rounded border-ink-300" {...props} />
      <span className="text-sm">
        <span className="font-medium text-ink-800">{label}</span>
        {description && <span className="block text-ink-500">{description}</span>}
      </span>
    </label>
  );
}
