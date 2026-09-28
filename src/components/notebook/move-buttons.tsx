"use client";

import { ArrowDown, ArrowUp } from "lucide-react";
import { type RefObject, useActionState, useEffect, useRef } from "react";
import { type ActionState, initialActionState } from "@/lib/action-state";
import { Button } from "../ui/button";
import { SubmitButton } from "../ui/submit-button";
import type { FormAction } from "../tasks/types";

const OFFLINE_MESSAGE = "Couldn't reach the server. Check your connection and try again.";

type Direction = "up" | "down";

/**
 * Up / down arrows for a notebook or a page. Both post to `action` with `fields` + `direction`; the result comes
 * back together with the list in its new order. Focus stays on the arrow that was used (or the other one once the
 * item reaches the top or bottom), and `onMessage` reports what happened for the list's status line.
 */
export function MoveButtons({
  action,
  fields,
  name,
  isFirst,
  isLast,
  onMessage,
}: {
  action: FormAction;
  fields: Record<string, string>;
  /** What moves, for labels and messages: "Intake". */
  name: string;
  isFirst: boolean;
  isLast: boolean;
  onMessage: (message: string) => void;
}) {
  const upRef = useRef<HTMLButtonElement>(null);
  const downRef = useRef<HTMLButtonElement>(null);
  const lastMove = useRef<Direction | null>(null);
  const handled = useRef<ActionState>(null);

  const [state, formAction] = useActionState(async (prev: ActionState, formData: FormData): Promise<ActionState> => {
    const direction: Direction = formData.get("direction") === "up" ? "up" : "down";
    lastMove.current = direction;
    let result: ActionState;
    try {
      result = await action(prev, formData);
    } catch {
      result = { ok: false, message: OFFLINE_MESSAGE, nonce: Date.now() };
    }
    onMessage(result?.ok ? `Moved “${name}” ${direction}.` : (result?.message ?? OFFLINE_MESSAGE));
    return result;
  }, initialActionState);

  useEffect(() => {
    if (!state?.ok || handled.current === state) return;
    handled.current = state;
    const target = lastMove.current === "up" ? (isFirst ? downRef : upRef) : isLast ? upRef : downRef;
    target.current?.focus();
  }, [state, isFirst, isLast]);

  return (
    <div className="flex shrink-0 items-center">
      <MoveButton direction="up" fields={fields} name={name} disabled={isFirst} action={formAction} buttonRef={upRef} />
      <MoveButton direction="down" fields={fields} name={name} disabled={isLast} action={formAction} buttonRef={downRef} />
    </div>
  );
}

function MoveButton({
  direction,
  fields,
  name,
  disabled,
  action,
  buttonRef,
}: {
  direction: Direction;
  fields: Record<string, string>;
  name: string;
  disabled: boolean;
  action: (formData: FormData) => void;
  buttonRef: RefObject<HTMLButtonElement | null>;
}) {
  const Icon = direction === "up" ? ArrowUp : ArrowDown;
  const label = `Move ${name} ${direction}`;
  if (disabled) {
    return (
      <Button ref={buttonRef} variant="ghost" size="icon" disabled aria-label={label}>
        <Icon className="size-4" aria-hidden />
      </Button>
    );
  }
  return (
    <form action={action} className="inline-flex">
      {Object.entries(fields).map(([key, value]) => (
        <input key={key} type="hidden" name={key} value={value} />
      ))}
      <input type="hidden" name="direction" value={direction} />
      <SubmitButton ref={buttonRef} variant="ghost" size="icon" aria-label={label}>
        <Icon className="size-4" aria-hidden />
      </SubmitButton>
    </form>
  );
}
