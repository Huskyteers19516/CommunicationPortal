import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { WebsiteEditor } from "@/components/admin/website-editor/website-editor";
import { PageHeader } from "@/components/ui/page-header";
import { requireAdminUser } from "@/server/auth/session";
import { env } from "@/server/env";
import { getSiteContentAdminView } from "@/server/queries/site-content";

export const metadata: Metadata = { title: "Website Coding" };

/**
 * Admin → Website Coding: the team website in an editor frame, where everyone with admin access changes its text,
 * links, and pictures (src/components/admin/website-editor). See "Website Coding" in docs/CONVENTIONS.md.
 */
export default async function WebsiteCodingPage() {
  const actor = await requireAdminUser();
  const view = await getSiteContentAdminView(actor);
  if (!view) notFound();
  return (
    <>
      <PageHeader eyebrow="Admin" title="Website Coding" description="Click anything on the team website to change it — no code needed." />
      <WebsiteEditor siteUrl={env.websiteEditorUrl} entries={view.entries} edits={view.edits} timeZone={env.teamTimezone} />
    </>
  );
}
