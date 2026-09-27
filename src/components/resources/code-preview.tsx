/**
 * An uploaded text/code file, with line numbers. Rendered as plain React text (never HTML), inside
 * its own scroll box so long lines scroll sideways here, not the page.
 */
export function CodePreview({ filename, text, lineCount }: { filename: string; text: string; lineCount: number }) {
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  const numbers = Array.from({ length: Math.max(lineCount, 1) }, (_, i) => i + 1).join("\n");
  return (
    <figure className="min-w-0 overflow-hidden rounded-xl border border-ink-200 bg-white shadow-sm">
      <figcaption className="flex items-center justify-between gap-3 border-b border-ink-100 bg-ink-50 px-3 py-2 text-xs text-ink-600">
        <span className="min-w-0 truncate font-mono">{filename}</span>
        <span className="shrink-0">
          {lineCount} {lineCount === 1 ? "line" : "lines"}
        </span>
      </figcaption>
      <div
        className="max-h-[70vh] overflow-auto overscroll-x-contain focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40"
        tabIndex={0}
        role="region"
        aria-label={`Contents of ${filename}`}
      >
        <div className="flex min-w-max font-mono text-xs leading-5 sm:text-[13px]">
          <pre aria-hidden className="sticky left-0 select-none border-r border-ink-100 bg-ink-50 py-3 pr-3 pl-3 text-right text-ink-400">
            {numbers}
          </pre>
          <pre className="py-3 pr-6 pl-4 text-ink-900 [tab-size:4]">
            <code>{body}</code>
          </pre>
        </div>
      </div>
    </figure>
  );
}
