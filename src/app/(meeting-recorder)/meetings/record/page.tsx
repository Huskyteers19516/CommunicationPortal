import { ArrowLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { HuskyMark } from "@/components/brand/logo";
import { MeetingRecorderApp } from "@/components/meetings/recorder/meeting-recorder-app";
import { requireActiveUser } from "@/server/auth/session";
import { env } from "@/server/env";
import { getMeetingRecorderSetup } from "@/server/queries/meeting-recaps";

export const metadata: Metadata = { title: "Record a meeting" };
// Per-user and always current; never prerender.
export const dynamic = "force-dynamic";

/**
 * The meeting recorder (people with admin access; everyone else goes to the list): outside the app's frame, so
 * nothing on the page can navigate away by accident while a meeting is recorded, and so it starts from a clean page
 * load (RecorderLink is a plain <a>). The header's link back asks first while something isn't saved.
 */
export default async function RecordMeetingPage() {
  const actor = await requireActiveUser();
  const setup = await getMeetingRecorderSetup(actor);
  if (!setup) redirect("/meetings");

  return (
    <div className="min-h-dvh">
      <header className="border-b border-ink-200 bg-white">
        <div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-3 px-4 py-2 sm:px-6">
          <span className="flex items-center gap-2">
            <HuskyMark className="size-8" />
            <span className="font-display text-lg font-bold uppercase tracking-wide text-brand-500">Huskyteers</span>
          </span>
          {/* While something isn't saved, the recorder asks before this (or any) link leaves the page. */}
          <Link
            href="/meetings"
            className="-mr-2 inline-flex h-10 items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-ink-600 hover:bg-ink-100 hover:text-ink-900"
          >
            <ArrowLeft className="size-4" aria-hidden />
            Meeting recaps
          </Link>
        </div>
      </header>
      <main className="mx-auto w-full max-w-3xl px-4 pb-16 pt-6 sm:px-6">
        <MeetingRecorderApp categories={setup.categories} roster={setup.roster} today={setup.today} timeZone={env.teamTimezone} />
      </main>
    </div>
  );
}
