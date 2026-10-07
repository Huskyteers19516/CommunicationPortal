"use client";

import { Check, Copy, FileDown, FileText } from "lucide-react";
import { useEffect, useState } from "react";
import {
  keyPointsToClipboardText,
  type RecapExport,
  recapFileBase,
  recapToMarkdown,
  recapToPlainText,
} from "@/lib/meeting-recorder/export";
import { Button } from "../ui/button";
import { saveFile } from "./save-file";

/** How long "Copied" stays. */
const COPIED_MS = 2500;

/**
 * Exports of a recap for everyone who reads it, built in the browser from what the page shows: **Copy key points**
 * ("- [12:30] …" lines; only when there are some), **Download .md** (title, details, key points, transcript), and
 * **Download transcript .txt** (only when there's a transcript). Files are named "<title> <date>".
 */
export function MeetingRecapExports({ recap }: { recap: RecapExport }) {
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const keyPoints = keyPointsToClipboardText(recap.keyPoints);
  const hasTranscript = recap.transcript.trim() !== "";
  const base = recapFileBase(recap.title, recap.meetingDate);

  useEffect(() => {
    if (!status?.ok) return;
    const timer = setTimeout(() => setStatus(null), COPIED_MS);
    return () => clearTimeout(timer);
  }, [status]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(keyPoints);
      setStatus({ ok: true, text: "Key points copied." });
    } catch {
      setStatus({ ok: false, text: "Couldn't copy here. Select the key points on the page and copy them instead." });
    }
  }

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap gap-2">
        {keyPoints && (
          <Button variant="secondary" onClick={copy}>
            {status?.ok ? <Check className="size-4 text-brand-600" aria-hidden /> : <Copy className="size-4" aria-hidden />}
            Copy key points
          </Button>
        )}
        <Button
          variant="secondary"
          onClick={() => saveFile(new Blob([recapToMarkdown(recap)], { type: "text/markdown;charset=utf-8" }), `${base}.md`)}
        >
          <FileDown className="size-4" aria-hidden />
          Download .md
        </Button>
        {hasTranscript && (
          <Button
            variant="secondary"
            onClick={() => saveFile(new Blob([recapToPlainText(recap)], { type: "text/plain;charset=utf-8" }), `${base} transcript.txt`)}
          >
            <FileText className="size-4" aria-hidden />
            Download transcript .txt
          </Button>
        )}
      </div>
      {/* Always on the page, so screen readers announce what happened. */}
      <p role="status" className={status?.ok === false ? "text-sm text-red-600" : "text-sm text-brand-700"}>
        {status?.text}
      </p>
    </div>
  );
}
