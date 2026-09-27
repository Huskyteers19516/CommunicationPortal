import { ChevronLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { AskQuestionForm } from "@/components/questions/ask-question-form";
import { Card, CardBody } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { isSubteamLeaderRole } from "@/lib/constants";
import { todayInTimezone } from "@/lib/dates";
import { requireActiveUser } from "@/server/auth/session";
import { env } from "@/server/env";
import { discordWebhookUrl } from "@/server/notifications/discord";
import { getAskAboutTask, getAskTaskOptions, getRecipientOptions } from "@/server/queries/questions";
import { askQuestionAction } from "../actions";

export const metadata: Metadata = { title: "Ask a question" };

export default async function NewQuestionPage({ searchParams }: PageProps<"/questions/new">) {
  const actor = await requireActiveUser();
  const sp = await searchParams;
  const rawTaskId = Array.isArray(sp.taskId) ? sp.taskId[0] : sp.taskId;
  const today = todayInTimezone(env.teamTimezone);

  const [recipientGroups, tasks, aboutTask] = await Promise.all([
    getRecipientOptions(actor),
    // ?taskId= may be any task (asked about from the Task dashboard), not just the actor's own.
    getAskTaskOptions(actor, { today, includeTaskId: rawTaskId }),
    getAskAboutTask(actor, rawTaskId),
  ]);
  // Only prefill a task that is actually one of the actor's options.
  const defaultTaskId = rawTaskId && tasks.some((t) => t.taskId === rawTaskId) ? rawTaskId : null;
  const about = aboutTask && aboutTask.id === defaultTaskId ? aboutTask : null;
  const backHref = about ? `/tasks/${about.id}` : "/questions";

  return (
    <div className="mx-auto w-full max-w-2xl">
      <Link
        href={backHref}
        className="-ml-2 mb-2 inline-flex h-10 items-center gap-1 rounded-lg px-2 text-sm font-medium text-ink-500 hover:bg-ink-100 hover:text-ink-800"
      >
        <ChevronLeft className="size-4" aria-hidden />
        {about ? "Back to task" : "Questions"}
      </Link>
      <PageHeader title="Ask a question" description="Your leaders get an email and answer right here." />
      <Card>
        <CardBody>
          <AskQuestionForm
            action={askQuestionAction}
            actorSubteam={actor.subteam}
            actorIsLeader={isSubteamLeaderRole(actor.role)}
            actorIsCaptain={actor.role === "CAPTAIN"}
            recipientGroups={recipientGroups}
            tasks={tasks}
            defaultTaskId={defaultTaskId}
            aboutTask={about}
            cancelHref={backHref}
            today={today}
            discordEnabled={discordWebhookUrl() !== null}
          />
        </CardBody>
      </Card>
    </div>
  );
}
