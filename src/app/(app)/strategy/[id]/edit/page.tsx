import { Trash2 } from "lucide-react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { StrategyForm } from "@/components/strategy/strategy-form";
import { ActionForm } from "@/components/tasks/action-form";
import { BackLink } from "@/components/tasks/back-link";
import { PageHeader } from "@/components/ui/page-header";
import { strategyRemoveQuestion } from "@/lib/strategy";
import { requireActiveUser } from "@/server/auth/session";
import { getStrategyForEdit } from "@/server/queries/strategy";
import { deleteStrategyAction, updateStrategyAction } from "../../actions";

export const metadata: Metadata = { title: "Edit strategy" };

/** Whoever added the strategy, and everyone with admin access. Everyone else: 404. */
export default async function EditStrategyPage({ params }: PageProps<"/strategy/[id]/edit">) {
  const actor = await requireActiveUser();
  const { id } = await params;
  const s = await getStrategyForEdit(actor, id);
  if (!s) notFound();

  return (
    <>
      <BackLink href={`/strategy/${s.id}`}>
        {/* A fixed cap: the back link sizes to its text, so a long title would otherwise widen the page. */}
        <span className="max-w-56 truncate sm:max-w-lg">{s.title}</span>
      </BackLink>
      <PageHeader
        title="Edit strategy"
        description={<span className="wrap-anywhere">{s.title}</span>}
        actions={
          <ActionForm
            action={deleteStrategyAction}
            fields={{ strategyId: s.id }}
            variant="secondary"
            confirm={strategyRemoveQuestion(s.title, s.files.length)}
            pendingText="Removing…"
            aria-label={`Remove ${s.title}`}
          >
            <Trash2 className="size-4" aria-hidden />
            Remove
          </ActionForm>
        }
      />
      <div className="max-w-2xl">
        <StrategyForm
          action={updateStrategyAction}
          submitLabel="Save changes"
          cancelHref={`/strategy/${s.id}`}
          initial={{
            id: s.id,
            title: s.title,
            kind: s.kind,
            description: s.description,
            link: s.link,
            currentFiles: s.files.map((f) => ({ id: f.id, filename: f.filename, size: f.size, kind: f.kind })),
            team: s.team ? { id: "", label: `${s.team.number} · ${s.team.name}` } : null,
          }}
        />
      </div>
    </>
  );
}
