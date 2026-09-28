"use client";

import { CircleCheck, KeyRound, ScanLine } from "lucide-react";
import { useActionState, useEffect, useId, useRef, useState } from "react";
import { checkInWithCodeAction } from "@/app/(app)/attendance/actions";
import { type ActionState, initialActionState } from "@/lib/action-state";
import { cn } from "@/lib/cn";
import { Alert } from "../ui/alert";
import { Button } from "../ui/button";
import { Field, Input } from "../ui/field";
import { SubmitButton } from "../ui/submit-button";
import { QrScanner } from "./qr-scanner";

/**
 * The typed-code fallback: 6 digits from the screen. Keeps what was typed after an error and focuses it; on
 * success the message shows (and takes focus) here, and `onCheckedIn` hears about it.
 */
export function CodeEntryForm({ autoFocus = false, onCheckedIn }: { autoFocus?: boolean; onCheckedIn?: (message: string) => void }) {
  const [code, setCode] = useState("");
  const [state, formAction] = useActionState(async (prev: ActionState, formData: FormData) => {
    const result = await checkInWithCodeAction(prev, formData);
    if (result?.ok) {
      setCode("");
      onCheckedIn?.(result.message ?? "You're checked in ✓");
    }
    return result;
  }, initialActionState);
  const inputRef = useRef<HTMLInputElement>(null);
  const successRef = useRef<HTMLDivElement>(null);
  const id = useId();
  const error = state && !state.ok ? (state.fieldErrors?.code ?? state.message) : undefined;

  useEffect(() => {
    if (!state) return;
    (state.ok ? successRef : inputRef).current?.focus();
  }, [state]);

  return (
    <form action={formAction} noValidate className="space-y-3">
      <div className="flex flex-wrap items-start gap-2">
        <Field label="Code on the screen" htmlFor={`${id}-code`} error={error} className="min-w-0 flex-1 basis-40 sm:max-w-56">
          <Input
            ref={inputRef}
            id={`${id}-code`}
            name="code"
            value={code}
            onChange={(e) => setCode(e.currentTarget.value.replace(/[^\d\s-]/g, "").slice(0, 7))}
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="6 digits"
            autoFocus={autoFocus}
            invalid={!!error}
            aria-describedby={error ? `${id}-code-error` : undefined}
            className="font-mono text-lg tracking-widest"
          />
        </Field>
        <SubmitButton pendingText="Checking…" className="mt-[1.625rem]">
          Check in
        </SubmitButton>
      </div>
      <div ref={successRef} tabIndex={-1} role="status" className="rounded-lg focus:outline-none">
        {state?.ok && (
          <Alert tone="success" role={null}>
            {state.message}
          </Alert>
        )}
      </div>
    </form>
  );
}

/**
 * "Scan QR code" (the in-app camera scanner) with "Enter code" as the fallback. `origins`: the sites whose
 * attendance links the scanner follows (the configured app URL; the page's own origin is added by the scanner).
 * `done` (I'm checked in to every open session) swaps the buttons for "You're checked in ✓"; when that happens
 * right after typing the code, the message takes focus so keyboard users aren't dropped on <body>.
 */
export function CheckInPanel({
  origins,
  className,
  size = "lg",
  scanLabel = "Scan QR code",
  done = false,
  doneText = "You're checked in ✓",
}: {
  origins: string[];
  className?: string;
  size?: "md" | "lg";
  scanLabel?: string;
  done?: boolean;
  doneText?: string;
}) {
  const [mode, setMode] = useState<"none" | "scan" | "code">("none");
  const [justCheckedIn, setJustCheckedIn] = useState<string | null>(null);
  const scanButtonRef = useRef<HTMLButtonElement>(null);
  const doneRef = useRef<HTMLDivElement>(null);
  const wasDone = useRef(done);

  useEffect(() => {
    if (done && !wasDone.current) doneRef.current?.focus();
    wasDone.current = done;
  }, [done]);

  return (
    <div className={cn("space-y-4", className)}>
      <div ref={doneRef} tabIndex={-1} role="status" className="rounded-lg focus:outline-none [&:empty]:hidden">
        {done && (
          <p className="flex items-center gap-2 rounded-lg bg-brand-50 px-3 py-2 text-sm font-medium text-brand-800">
            <CircleCheck className="size-5 shrink-0" aria-hidden />
            {justCheckedIn ?? doneText}
          </p>
        )}
      </div>
      {!done && (
        <>
          <div className="flex flex-wrap gap-2">
            <Button
              ref={scanButtonRef}
              size={size}
              aria-expanded={mode === "scan"}
              onClick={() => setMode(mode === "scan" ? "none" : "scan")}
              className="flex-1 sm:flex-none"
            >
              <ScanLine className="size-5" aria-hidden />
              {scanLabel}
            </Button>
            <Button
              size={size}
              variant="secondary"
              aria-expanded={mode === "code"}
              onClick={() => setMode(mode === "code" ? "none" : "code")}
              className="flex-1 sm:flex-none"
            >
              <KeyRound className="size-5" aria-hidden />
              Enter code
            </Button>
          </div>
          {mode === "scan" && (
            <QrScanner
              origins={origins}
              onClose={() => {
                setMode("none");
                requestAnimationFrame(() => scanButtonRef.current?.focus());
              }}
              onUseCode={() => setMode("code")}
            />
          )}
          {mode === "code" && <CodeEntryForm autoFocus onCheckedIn={setJustCheckedIn} />}
        </>
      )}
    </div>
  );
}
