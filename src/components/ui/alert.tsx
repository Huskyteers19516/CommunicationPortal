import { AlertTriangle, CheckCircle2, Info, XCircle } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

type Tone = "info" | "success" | "warning" | "error";

const styles: Record<Tone, { box: string; icon: typeof Info }> = {
  info: { box: "border-sky-200 bg-sky-50 text-sky-900", icon: Info },
  success: { box: "border-brand-200 bg-brand-50 text-brand-900", icon: CheckCircle2 },
  warning: { box: "border-amber-200 bg-amber-50 text-amber-900", icon: AlertTriangle },
  error: { box: "border-red-200 bg-red-50 text-red-900", icon: XCircle },
};

/**
 * A colored message box. It's a live region (`alert` for errors, else `status`); pass `role={null}` when it's
 * shown inside a live region that's always on the page (so a message that appears is announced once).
 */
export function Alert({
  tone = "info",
  title,
  children,
  className,
  role,
}: {
  tone?: Tone;
  title?: ReactNode;
  children?: ReactNode;
  className?: string;
  role?: "status" | "alert" | null;
}) {
  const { box, icon: Icon } = styles[tone];
  return (
    <div role={role === null ? undefined : (role ?? (tone === "error" ? "alert" : "status"))} className={cn("flex gap-3 rounded-lg border px-3.5 py-3 text-sm", box, className)}>
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="min-w-0 space-y-0.5">
        {title && <p className="font-semibold">{title}</p>}
        {children && <div className="leading-relaxed">{children}</div>}
      </div>
    </div>
  );
}
