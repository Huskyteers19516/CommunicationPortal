import Link from "next/link";
import { cn } from "@/lib/cn";
import type { FundraiserPerson } from "@/server/queries/fundraising";
import { firstName } from "../checklist/format";
import { Avatar } from "../ui/avatar";

/**
 * Who's helping: avatar + first name per person (the viewer shows as "You", first). Shows up to `max`
 * people, then "+N more" linking to the fundraiser's page.
 */
export function HelperChips({
  helpers,
  fundraiserId,
  max = 8,
  emptyText,
  className,
}: {
  helpers: FundraiserPerson[];
  fundraiserId: string;
  max?: number;
  emptyText: string;
  className?: string;
}) {
  if (helpers.length === 0) return emptyText ? <p className={cn("text-xs text-ink-500", className)}>{emptyText}</p> : null;
  const me = helpers.find((p) => p.isMe);
  const ordered = me ? [me, ...helpers.filter((p) => !p.isMe)] : helpers;
  const shown = ordered.length > max ? ordered.slice(0, max - 1) : ordered;
  const hidden = ordered.length - shown.length;

  return (
    <ul className={cn("flex flex-wrap items-center gap-1.5", className)} aria-label="Helpers">
      {shown.map((p) => (
        <li
          key={p.id}
          title={p.name}
          className={cn(
            "inline-flex min-w-0 max-w-full items-center gap-1 rounded-full border py-0.5 pl-0.5 pr-2 text-xs",
            p.isMe ? "border-brand-300 bg-brand-50" : "border-ink-200 bg-white",
          )}
        >
          <Avatar name={p.name} size="sm" />
          <span aria-hidden className="truncate font-medium text-ink-800">
            {p.isMe ? "You" : firstName(p.name)}
          </span>
          <span className="sr-only">{p.isMe ? `You (${p.name})` : p.name}</span>
        </li>
      ))}
      {hidden > 0 && (
        <li>
          <Link
            href={`/fundraising/${fundraiserId}#helpers`}
            className="inline-flex min-h-10 items-center rounded-full px-2 text-xs font-medium text-brand-700 hover:bg-brand-50 hover:text-brand-800"
            aria-label={`${hidden} more ${hidden === 1 ? "helper" : "helpers"} — see everyone helping`}
          >
            +{hidden} more
          </Link>
        </li>
      )}
    </ul>
  );
}
