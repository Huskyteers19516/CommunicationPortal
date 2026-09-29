import "server-only";
// Word (.docx) export of a team notebook (or one page): a title page (team, notebook, export date), then each page
// as a Heading 1 and each entry as a Heading 2 with its stamp line, text (paragraphs and "- " bullet lists),
// pictures scaled to the page width, and "Edited by … on …". Links in the text are clickable. Built with the `docx`
// package, in memory.
//
// Picture bytes are only loaded for the pictures that fit NOTEBOOK_EXPORT_IMAGE_BUDGET (the whole file has to fit in
// one download; Vercel refuses responses over 4.5 MB). If the finished file is still over NOTEBOOK_EXPORT_MAX_BYTES
// (lots of text), it's built again with fewer pictures; if the text alone is too big, the download says to export
// one page at a time. Pictures left out, and WebP pictures (Word can't show them), get a line naming them instead,
// and the title page says how many; Print / Save as PDF always has everything.
import { Document, ExternalHyperlink, HeadingLevel, ImageRun, Packer, Paragraph, TextRun } from "docx";
import { todayInTimezone } from "@/lib/dates";
import {
  formatStamp,
  formatStampDay,
  NOTEBOOK_TEAM_LINE,
  notebookBlocks,
  notebookExportFilename,
  writtenByLine,
} from "@/lib/notebook";
import type { Db } from "../db";
import { prisma } from "../db";
import type { ObjectStore } from "../files/object-store";
import { plainResponse } from "../files/respond";
import { type NotebookExport, type NotebookExportImage, loadNotebookImageBytes } from "../queries/notebook";
import { contentDisposition } from "../resources/serve";

/** Bytes of pictures one Word file may carry (the text is usually tiny next to them). */
export const NOTEBOOK_EXPORT_IMAGE_BUDGET = 3.5 * 1024 * 1024;
/** The most one Word file may be: under Vercel's 4.5 MB response limit (however "MB" is counted), with room to spare. */
export const NOTEBOOK_EXPORT_MAX_BYTES = 4_300_000;

/** Letter paper with 1" margins leaves 6.5" (624 px at 96 dpi) for a picture; a little less looks better. */
const IMAGE_MAX_WIDTH = 600;
const IMAGE_MAX_HEIGHT = 720;

export const DOCX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const DOCX_IMAGE_TYPES: Record<string, "png" | "jpg" | "gif"> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
};

/** Characters XML 1.0 can't hold (Word won't open a file with them): other control characters and stray surrogates. */
function xmlSafe(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, "")
    .replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "");
}

/** Which pictures go into the Word file: in reading order, the ones Word can show, until the budget is used up. */
export function pickExportImages(
  data: NotebookExport,
  budget = NOTEBOOK_EXPORT_IMAGE_BUDGET,
): { included: Set<string>; leftOut: number } {
  const included = new Set<string>();
  let used = 0;
  let leftOut = 0;
  for (const page of data.pages) {
    for (const entry of page.entries) {
      for (const image of entry.images) {
        if (DOCX_IMAGE_TYPES[image.contentType] && used + image.size <= budget) {
          included.add(image.id);
          used += image.size;
        } else {
          leftOut++;
        }
      }
    }
  }
  return { included, leftOut };
}

/** Width × height (px) that fit the page, keeping the shape. */
function fitOnPage(image: NotebookExportImage): { width: number; height: number } {
  const w = image.width && image.width > 0 ? image.width : IMAGE_MAX_WIDTH;
  const h = image.height && image.height > 0 ? image.height : Math.round(IMAGE_MAX_WIDTH * 0.75);
  const scale = Math.min(1, IMAGE_MAX_WIDTH / w, IMAGE_MAX_HEIGHT / h);
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

const note = (text: string) =>
  new Paragraph({ spacing: { after: 120 }, children: [new TextRun({ text: xmlSafe(text), italics: true, color: "666666", size: 20 })] });

/** http(s) links in entry text: the same rule the page uses (RichText), so the same things are clickable. */
const URL_RE = /(https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]])/g;

/** A line of text as runs, with its links as clickable hyperlinks. */
function textRuns(text: string): (TextRun | ExternalHyperlink)[] {
  const runs: (TextRun | ExternalHyperlink)[] = [];
  text.split(URL_RE).forEach((part, i) => {
    if (!part) return;
    if (i % 2 === 0) runs.push(new TextRun(part));
    else runs.push(new ExternalHyperlink({ link: part, children: [new TextRun({ text: part, style: "Hyperlink" })] }));
  });
  return runs;
}

function bodyParagraphs(body: string): Paragraph[] {
  const out: Paragraph[] = [];
  for (const block of notebookBlocks(xmlSafe(body))) {
    if (block.kind === "list") {
      for (const item of block.items) out.push(new Paragraph({ children: textRuns(item), bullet: { level: 0 } }));
    } else {
      for (const line of block.text.split("\n")) out.push(new Paragraph({ children: textRuns(line) }));
    }
  }
  return out;
}

export interface NotebookDocxOptions {
  timeZone: string;
  now: Date;
  /** Bytes of the pictures to embed, by id (see pickExportImages). Pictures not here get a line instead. */
  imageBytes: Map<string, Uint8Array>;
  /** Pictures left out because the file would be too big (said on the title page). */
  leftOut?: number;
}

/** The notebook (or page) as a .docx file. */
export async function buildNotebookDocx(data: NotebookExport, opts: NotebookDocxOptions): Promise<Buffer> {
  const { timeZone } = opts;
  const entryCount = data.pages.reduce((n, p) => n + p.entries.length, 0);
  const onePage = data.scope === "page" ? data.pages[0] : undefined;
  const heading = `${data.notebook.emoji ? `${data.notebook.emoji} ` : ""}${data.notebook.title}`;

  const children: Paragraph[] = [
    new Paragraph({ children: [new TextRun({ text: NOTEBOOK_TEAM_LINE, bold: true, size: 28, color: "2F7D3A" })], spacing: { after: 240 } }),
    new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun(xmlSafe(heading))] }),
  ];
  if (onePage) {
    children.push(new Paragraph({ spacing: { after: 240 }, children: [new TextRun({ text: xmlSafe(onePage.title), size: 36, color: "444444" })] }));
  }
  if (data.notebook.description) children.push(new Paragraph({ children: [new TextRun(xmlSafe(data.notebook.description))] }));
  children.push(
    new Paragraph({
      spacing: { before: 240 },
      children: [new TextRun({ text: `Exported ${formatStampDay(opts.now, timeZone)}`, color: "444444" })],
    }),
    new Paragraph({
      children: [
        new TextRun({
          text: [
            !onePage && `${data.pages.length} ${data.pages.length === 1 ? "page" : "pages"}`,
            `${entryCount} ${entryCount === 1 ? "entry" : "entries"}`,
          ]
            .filter(Boolean)
            .join(" · "),
          color: "444444",
        }),
      ],
    }),
  );
  if (opts.leftOut) {
    children.push(
      note(
        `${opts.leftOut} ${opts.leftOut === 1 ? "picture is" : "pictures are"} not in this file (too big to fit in one download, or WebP). Use Print / Save as PDF in the Team notebook to get every picture, or export one page at a time.`,
      ),
    );
  }

  for (const page of data.pages) {
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, pageBreakBefore: true, children: [new TextRun(xmlSafe(page.title))] }));
    if (page.entries.length === 0) children.push(note("No entries yet."));
    for (const entry of page.entries) {
      children.push(
        new Paragraph({
          heading: HeadingLevel.HEADING_2,
          children: [new TextRun(xmlSafe(entry.title || formatStamp(entry.createdAt, timeZone)))],
        }),
        note(writtenByLine(entry.authorName, entry.createdAt, timeZone)),
        ...bodyParagraphs(entry.body),
      );
      for (const image of entry.images) {
        const bytes = opts.imageBytes.get(image.id);
        const type = DOCX_IMAGE_TYPES[image.contentType];
        if (bytes && type) {
          children.push(
            new Paragraph({
              spacing: { before: 120, after: 120 },
              children: [
                new ImageRun({
                  type,
                  data: bytes,
                  transformation: fitOnPage(image),
                  altText: { name: xmlSafe(image.filename), description: xmlSafe(image.filename), title: xmlSafe(image.filename) },
                }),
              ],
            }),
          );
        } else {
          children.push(note(`[Picture: ${image.filename} — see it in the Team notebook]`));
        }
      }
      if (entry.lastEditedAt) {
        children.push(note(`Edited by ${entry.lastEditedByName ?? "a former member"} on ${formatStamp(entry.lastEditedAt, timeZone)}`));
      }
    }
  }

  const doc = new Document({
    creator: NOTEBOOK_TEAM_LINE,
    title: xmlSafe(onePage ? `${data.notebook.title} — ${onePage.title}` : data.notebook.title),
    description: "Exported from the Huskyteers Portal team notebook",
    sections: [
      {
        properties: {
          page: {
            size: { width: 12240, height: 15840 }, // US Letter, in twips
            margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 },
          },
        },
        children,
      },
    ],
  });
  return Packer.toBuffer(doc);
}

/** "Hardware Notebook 2026-09-27.docx" / "Hardware Notebook - Intake 2026-09-27.docx". */
export function notebookDocxFilename(data: NotebookExport, timeZone: string, now: Date): string {
  const parts = data.scope === "page" && data.pages[0] ? [data.notebook.title, data.pages[0].title] : [data.notebook.title];
  return notebookExportFilename(parts, todayInTimezone(timeZone, now));
}

/**
 * The Word file, at most `maxBytes`: with the pictures that fit NOTEBOOK_EXPORT_IMAGE_BUDGET, then — when the text
 * makes it too big — fewer pictures, then none. Null when even the text alone is too big for one file.
 * Loads only the picture bytes it uses (from Postgres or Cloudflare R2; `store` defaults to the R2_* settings).
 */
export async function buildNotebookDocxWithin(
  data: NotebookExport,
  opts: { timeZone: string; now: Date; maxBytes?: number; store?: ObjectStore | null },
  db: Db = prisma,
): Promise<Buffer | null> {
  const maxBytes = opts.maxBytes ?? NOTEBOOK_EXPORT_MAX_BYTES;
  const sizes = new Map(data.pages.flatMap((p) => p.entries.flatMap((e) => e.images.map((i) => [i.id, i.size] as const))));
  const loaded = new Map<string, Uint8Array>();
  let budget = NOTEBOOK_EXPORT_IMAGE_BUDGET;
  for (let attempt = 0; ; attempt++) {
    const { included, leftOut } = pickExportImages(data, budget);
    const missing = [...included].filter((id) => !loaded.has(id));
    for (const [id, bytes] of await loadNotebookImageBytes(missing, db, opts.store)) loaded.set(id, bytes);
    const imageBytes = new Map([...included].flatMap((id) => (loaded.has(id) ? [[id, loaded.get(id)!] as const] : [])));
    const buffer = await buildNotebookDocx(data, { timeZone: opts.timeZone, now: opts.now, imageBytes, leftOut });
    if (buffer.byteLength <= maxBytes) return buffer;
    if (included.size === 0) return null; // the text alone is too big
    // Take out about as many picture bytes as the file is over (plus some room); the last try has none.
    const used = [...included].reduce((sum, id) => sum + (sizes.get(id) ?? 0), 0);
    budget = attempt >= 2 ? 0 : Math.max(0, used - (buffer.byteLength - maxBytes) - 64 * 1024);
  }
}

/** The export as a download (never cached, never sniffed), or a short message when it can't fit in one file. */
export async function notebookDocxResponse(
  data: NotebookExport,
  timeZone: string,
  now = new Date(),
  db: Db = prisma,
  maxBytes = NOTEBOOK_EXPORT_MAX_BYTES,
): Promise<Response> {
  const buffer = await buildNotebookDocxWithin(data, { timeZone, now, maxBytes }, db);
  if (!buffer) {
    return plainResponse(
      413,
      data.scope === "page"
        ? "This page has too much text for one Word file. Use Print / Save as PDF in the Team notebook instead."
        : "This notebook has too much text for one Word file. Export one page at a time, or use Print / Save as PDF in the Team notebook.",
    );
  }
  const body = new Uint8Array(buffer);
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": DOCX_CONTENT_TYPE,
      "Content-Length": String(body.byteLength),
      "Content-Disposition": contentDisposition("attachment", notebookDocxFilename(data, timeZone, now)),
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    },
  });
}
