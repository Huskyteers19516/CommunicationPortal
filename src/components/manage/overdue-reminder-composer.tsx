"use client";

import { Check, Copy, Mail } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { cn } from "@/lib/cn";
import { type OverdueReminderText, reminderMailto } from "@/lib/overdue-reminder";
import { Button } from "../ui/button";
import { Input, Textarea } from "../ui/field";

type Status = { ok: boolean; text: string } | null;

/** Copies text to the clipboard and says so next to the button for a few seconds. */
function useCopy() {
  const [status, setStatus] = useState<Status>(null);
  useEffect(() => {
    if (!status) return;
    const timer = setTimeout(() => setStatus(null), 4000);
    return () => clearTimeout(timer);
  }, [status]);
  /**
   * Where the Clipboard API is off-limits (some in-app browsers), `field` is selected and the older copy command
   * tried; if that fails too, the text stays selected, ready to copy by hand.
   */
  const copy = async (text: string, what: string, field: HTMLInputElement | HTMLTextAreaElement | null) => {
    try {
      await navigator.clipboard.writeText(text);
      setStatus({ ok: true, text: `${what} copied.` });
      return;
    } catch {
      // fall through
    }
    field?.focus();
    field?.select();
    let copied = false;
    try {
      copied = document.execCommand("copy");
    } catch {
      // not supported
    }
    setStatus(
      copied
        ? { ok: true, text: `${what} copied.` }
        : { ok: false, text: "Couldn't copy here — it's selected in the box, copy it from there." },
    );
  };
  return { status, copy };
}

/** One labelled, copyable box: a read-only line, or the message (editable when `onChange` is given). */
function CopyBox({
  label,
  what,
  hint,
  value,
  onChange,
}: {
  label: string;
  /** What gets copied, for the status line ("Recipients copied."). */
  what: string;
  hint?: string;
  value: string;
  onChange?: (value: string) => void;
}) {
  const id = useId();
  const { status, copy } = useCopy();
  return (
    <div>
      <div className="mb-1.5 flex items-end justify-between gap-3">
        <div className="min-w-0">
          <label htmlFor={id} className="text-sm font-medium text-ink-800">
            {label}
          </label>
          {hint && (
            <p id={`${id}-hint`} className="text-xs text-ink-500">
              {hint}
            </p>
          )}
        </div>
        <Button variant="secondary" className="shrink-0" aria-label={`Copy ${what.toLowerCase()}`} onClick={() => copy(value, what, document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement | null)}>
          {status?.ok ? <Check className="size-4 text-brand-600" aria-hidden /> : <Copy className="size-4" aria-hidden />}
          Copy
        </Button>
      </div>
      {onChange ? (
        <Textarea
          id={id}
          aria-describedby={hint ? `${id}-hint` : undefined}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          rows={Math.min(24, value.split("\n").length + 1)}
          className="font-mono text-[13px]"
        />
      ) : (
        <Input
          id={id}
          aria-describedby={hint ? `${id}-hint` : undefined}
          readOnly
          value={value}
          onFocus={(e) => e.currentTarget.select()}
        />
      )}
      {/* Room kept for the line, so the boxes below don't jump when it appears. */}
      <p role="status" className={cn("mt-1 min-h-4 text-xs", status?.ok ? "text-brand-700" : "text-red-700")}>
        {status?.text}
      </p>
    </div>
  );
}

/**
 * The reminder, ready to paste into an email: recipients, subject, and the message (which can be tweaked first).
 * "Open in email app" fills all three in at once when the message is short enough for a mailto: link. Key it by the
 * text so new data starts from the new text.
 */
export function OverdueReminderComposer({ reminder }: { reminder: OverdueReminderText }) {
  const [body, setBody] = useState(reminder.body);
  const mailto = reminderMailto({ ...reminder, body });
  return (
    <div className="space-y-3">
      <CopyBox label="To" what="Recipients" hint="Everyone listed below. Paste into To (or Bcc)." value={reminder.recipients} />
      <CopyBox label="Subject" what="Subject" value={reminder.subject} />
      <CopyBox label="Message" what="Message" hint="Edit it here if you like — Copy takes what's in the box." value={body} onChange={setBody} />
      {mailto ? (
        <a href={mailto} className="inline-flex h-10 items-center gap-2 text-sm font-medium text-brand-700 hover:underline">
          <Mail className="size-4" aria-hidden />
          Open in email app
        </a>
      ) : (
        <p className="text-xs text-ink-500">Too long to open in an email app directly — copy and paste the three parts instead.</p>
      )}
    </div>
  );
}
