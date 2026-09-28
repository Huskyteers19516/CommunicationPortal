"use client";

import { CircleCheck, LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { checkInWithTokenAction } from "@/app/(app)/attendance/actions";
import type { ActionState } from "@/lib/action-state";
import { Alert } from "../ui/alert";
import { ButtonLink } from "../ui/button";
import { CheckInPanel } from "./check-in-panel";

const ALREADY: ActionState = { ok: true, message: "You're already checked in ✓" };

/**
 * Sends the scanned check-in once, right after the page opens (a Server Action, so opening or prefetching the
 * link never writes anything by itself). Then says "You're checked in for Regular ✓" (and takes focus), or what
 * went wrong with a way to scan again or type the code. `alreadyCheckedIn` counts only as the page first opened:
 * the refresh after this check-in says I'm on the list, but this still shows its own result.
 */
export function ScanCheckIn({ token, origins, alreadyCheckedIn = false }: { token: string; origins: string[]; alreadyCheckedIn?: boolean }) {
  const [already] = useState(alreadyCheckedIn);
  const [sentResult, setResult] = useState<ActionState>(null);
  const sent = useRef(false);
  const resultRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (already || sent.current) return;
    sent.current = true;
    checkInWithTokenAction(token).then(setResult, () =>
      setResult({ ok: false, message: "Couldn't reach the portal. Check your connection, then scan the code again." }),
    );
  }, [token, already]);

  useEffect(() => {
    if (sentResult) resultRef.current?.focus();
  }, [sentResult]);

  const result = already ? ALREADY : sentResult;

  return (
    <div ref={resultRef} tabIndex={-1} className="space-y-4 focus:outline-none">
      <div role="status" aria-live="polite">
        {result === null ? (
          <p className="flex items-center justify-center gap-2 py-8 text-base text-ink-600">
            <LoaderCircle className="size-5 animate-spin" aria-hidden />
            Checking you in…
          </p>
        ) : result.ok ? (
          <div className="flex flex-col items-center gap-2 py-6 text-center">
            <CircleCheck className="size-16 text-brand-600" aria-hidden />
            <p className="text-xl font-semibold text-ink-900">{result.message}</p>
          </div>
        ) : null}
      </div>
      {result && !result.ok && (
        <>
          <Alert tone="error" title="Not checked in">
            {result.message}
          </Alert>
          <CheckInPanel origins={origins} />
        </>
      )}
      {result?.ok && (
        <div className="flex justify-center">
          <ButtonLink href="/attendance" variant="secondary">
            Go to Attendance
          </ButtonLink>
        </div>
      )}
    </div>
  );
}
