import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { NotebookPrintView } from "@/components/notebook/print-view";
import { requireActiveUser } from "@/server/auth/session";
import { env } from "@/server/env";
import { getNotebookExport } from "@/server/queries/notebook";

export const metadata: Metadata = { title: "Print notebook page" };
// Per-user and always current; never prerender.
export const dynamic = "force-dynamic";

/** One notebook page laid out for printing or saving as a PDF (outside the app's menus). Every ACTIVE person. */
export default async function PrintNotebookPagePage({ params }: PageProps<"/notebook/print/p/[pageId]">) {
  const actor = await requireActiveUser();
  const { pageId } = await params;
  const data = await getNotebookExport(actor, { pageId });
  if (!data) notFound();
  return <NotebookPrintView data={data} timeZone={env.teamTimezone} now={new Date()} backHref={`/notebook/p/${encodeURIComponent(pageId)}`} />;
}
