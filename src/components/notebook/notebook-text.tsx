import { cn } from "@/lib/cn";
import { notebookBlocks } from "@/lib/notebook";
import { RichText } from "../ui/rich-text";

/** An entry's text: paragraphs with their line breaks and links, and "- " lines as a bulleted list. Never HTML. */
export function NotebookText({ body, className }: { body: string; className?: string }) {
  const blocks = notebookBlocks(body);
  return (
    <div className={cn("space-y-2 text-sm text-ink-800 wrap-anywhere", className)}>
      {blocks.map((block, i) =>
        block.kind === "list" ? (
          <ul key={i} className="list-disc space-y-1 pl-5 marker:text-ink-400">
            {block.items.map((item, j) => (
              <li key={j}>
                <RichText text={item} />
              </li>
            ))}
          </ul>
        ) : (
          <RichText key={i} text={block.text} />
        ),
      )}
    </div>
  );
}
