// Posts question activity to a leaders-only Discord channel through an incoming webhook
// (DISCORD_WEBHOOK_URL). One-way: people still answer in the portal, so question status and
// email notifications keep working. Also posts who said they'd come to practice but didn't check in,
// when a runner closes attendance ("attendance.no_shows").
//
// - Questions addressed to ONE specific person are never posted (the asker chose who sees them).
// - Long text is split across follow-up messages so the full question arrives.
// - Message ids are stored on the question/reply, so deleting a question removes its posts.
// - Every post is recorded in EmailLog (to = "Discord") so the admin can see in Admin → Email log
//   whether it went through.
//
// No "server-only" / next/* imports: this runs inside after() and in tests.
import type { AttendanceKind, Role, Subteam } from "@/generated/prisma/enums";
import { ATTENDANCE_KIND_LABELS } from "@/lib/attendance";
import { SUBTEAM_LABELS } from "@/lib/constants";
import { type DateOnly, dbToDateOnly, formatDateOnly } from "@/lib/dates";
import type { Db } from "../db";
import { env } from "../env";
import type { NotificationEvent } from "./events";
import { roleLabel } from "./templates";

/** Discord's own webhook URL shape — anything else is ignored rather than POSTed to. */
const WEBHOOK_URL_RE = /^https:\/\/(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/;

export const DISCORD_LOG_RECIPIENT = "Discord";

const COLORS = {
  asked: 0x4ca256, // brand green: new question
  followUp: 0xf59e0b, // amber: asker added more, waiting on leaders
  answered: 0x6d6e73, // brand gray: a leader answered
  noShows: 0xf59e0b, // amber: said they'd come, didn't check in
  test: 0x4ca256,
} as const;

// Discord limits: title 256, description 4096, field value 1024, author 256, 6000 per message.
// The main card keeps its description at 3800 so title/author/fields/footer always fit under 6000.
const LIMITS = { title: 256, firstChunk: 3800, nextChunk: 4000, field: 1024, author: 256, maxChunks: 5 } as const;

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface DiscordOptions {
  /** Override the webhook URL (tests). `null` = not configured. Defaults to env. */
  webhookUrl?: string | null;
  appUrl?: string;
  fetch?: FetchLike;
  /** Waits before a retry after HTTP 429 (tests pass a no-op). */
  sleep?: (ms: number) => Promise<void>;
}

export type DiscordStatus = "SENT" | "FAILED" | "SKIPPED";

/** The configured webhook URL, or null when it's missing or doesn't look like a Discord webhook. */
export function discordWebhookUrl(raw: string | undefined | null = process.env.DISCORD_WEBHOOK_URL): string | null {
  const url = raw?.trim();
  return url && WEBHOOK_URL_RE.test(url) ? url : null;
}

function resolveUrl(options: DiscordOptions): string | null {
  return options.webhookUrl === undefined ? discordWebhookUrl() : discordWebhookUrl(options.webhookUrl);
}

// ── text helpers ─────────────────────────────────────────────────────────────

/** http(s) links, without trailing punctuation or formatting characters (like Discord's own autolinker). */
const URL_RE = /(https?:\/\/[^\s<>]*[^\s<>.,:;"')\]*_~|])/g;

/**
 * Escape Discord markdown so user text renders literally (no fake masked links, headers, spoilers…).
 * Links are kept clickable by wrapping them in <…>, which also stops a following escaped
 * character from being glued onto the link.
 */
export function escapeMarkdown(text: string): string {
  return text
    .split(URL_RE)
    .map((part, i) => (i % 2 === 1 ? `<${part}>` : part.replace(/([\\*_~`|>\[\]#<-])/g, "\\$1")))
    .join("");
}

/** Neutralise @everyone / @here even though allowed_mentions already stops pings. */
function defuseMentions(text: string): string {
  return text.replace(/@(everyone|here)/gi, "@​$1");
}

/** Cut at a code point boundary (never inside an emoji / surrogate pair). */
function clip(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("").trimEnd()}…`;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Single-line field text: literal, no mentions, within `max` characters. */
function safeLine(text: string, max: number): string {
  return clip(defuseMentions(escapeMarkdown(oneLine(text))), max);
}

/**
 * Split long, already-escaped text into Discord-sized pieces, preferring line/word breaks and
 * never separating a "\" from the character it escapes. Returns at most LIMITS.maxChunks pieces.
 */
export function splitForDiscord(text: string, first: number = LIMITS.firstChunk, rest: number = LIMITS.nextChunk): string[] {
  const chars = Array.from(text);
  const chunks: string[] = [];
  let start = 0;
  while (start < chars.length && chunks.length < LIMITS.maxChunks) {
    const max = chunks.length === 0 ? first : rest;
    let end = Math.min(chars.length, start + max);
    if (end < chars.length) {
      const window = chars.slice(start, end);
      let breakAt = -1;
      for (let i = window.length - 1; i > max * 0.6; i--) {
        if (window[i] === "\n" || window[i] === " ") {
          breakAt = i;
          break;
        }
      }
      if (breakAt !== -1) end = start + breakAt + 1;
      // Don't end on an escape backslash (count the run of backslashes before `end`).
      let slashes = 0;
      while (end - 1 - slashes >= start && chars[end - 1 - slashes] === "\\") slashes++;
      if (slashes % 2 === 1) end -= 1;
    }
    chunks.push(chars.slice(start, end).join(""));
    start = end;
  }
  if (start < chars.length) chunks[chunks.length - 1] += "\n… (continued in the portal)";
  return chunks;
}

function person(p: { name: string; role: Role; subteam: Subteam | null }): string {
  return `${oneLine(p.name)} · ${roleLabel(p.role, p.subteam)}`;
}

function questionUrl(appUrl: string, id: string): string {
  return `${appUrl.replace(/\/+$/, "")}/questions/${encodeURIComponent(id)}`;
}

function audienceLabel(subteam: Subteam | null): string {
  return subteam ? `${SUBTEAM_LABELS[subteam]} leaders` : "Captain (whole team)";
}

// ── payloads ─────────────────────────────────────────────────────────────────

interface Embed {
  title?: string;
  url?: string;
  description?: string;
  color: number;
  author?: { name: string };
  fields?: { name: string; value: string; inline?: boolean }[];
  footer?: { text: string };
  timestamp?: string;
}

export interface DiscordPayload {
  username: string;
  allowed_mentions: { parse: never[] };
  embeds: Embed[];
}

function payload(embed: Embed): DiscordPayload {
  // allowed_mentions.parse = [] → nothing in the message can ping anyone.
  return { username: "Huskyteers Portal", allowed_mentions: { parse: [] }, embeds: [embed] };
}

/** Main card + continuation messages for a long body. */
function withContinuations(main: Omit<Embed, "description">, body: string): DiscordPayload[] {
  const chunks = splitForDiscord(defuseMentions(escapeMarkdown(body.trim())));
  const total = chunks.length;
  return chunks.map((chunk, i) => {
    if (i > 0) return payload({ description: chunk, color: main.color, footer: { text: `continued (${i + 1}/${total})` } });
    const footer = total > 1 ? { text: `${main.footer?.text ?? ""} (1/${total})`.trim() } : main.footer;
    return payload({ ...main, description: chunk, footer });
  });
}

export interface QuestionForDiscord {
  id: string;
  title: string;
  body: string;
  subteam: Subteam | null;
  createdAt: Date;
  asker: { name: string; role: Role; subteam: Subteam | null };
  taskTitle: string | null;
}

export function questionAskedPayloads(q: QuestionForDiscord, appUrl: string): DiscordPayload[] {
  const fields: NonNullable<Embed["fields"]> = [
    { name: "To", value: audienceLabel(q.subteam), inline: true },
    { name: "Topic", value: q.subteam ? SUBTEAM_LABELS[q.subteam] : "Whole team", inline: true },
  ];
  if (q.taskTitle) fields.push({ name: "About task", value: safeLine(q.taskTitle, LIMITS.field) });
  return withContinuations(
    {
      title: clip(`New question: ${oneLine(q.title)}`, LIMITS.title),
      url: questionUrl(appUrl, q.id),
      color: COLORS.asked,
      author: { name: clip(person(q.asker), LIMITS.author) },
      fields,
      footer: { text: "Answer in the portal (click the title). The asker gets an email." },
      timestamp: q.createdAt.toISOString(),
    },
    q.body,
  );
}

export interface ReplyForDiscord {
  body: string;
  createdAt: Date;
  author: { name: string; role: Role; subteam: Subteam | null };
  /** true when the asker added a follow-up; false when someone else (a leader) answered. */
  byAsker: boolean;
}

export function questionRepliedPayloads(q: { id: string; title: string }, reply: ReplyForDiscord, appUrl: string): DiscordPayload[] {
  return withContinuations(
    {
      title: clip(`${reply.byAsker ? "Follow-up" : "Answered"}: ${oneLine(q.title)}`, LIMITS.title),
      url: questionUrl(appUrl, q.id),
      color: reply.byAsker ? COLORS.followUp : COLORS.answered,
      author: { name: clip(person(reply.author), LIMITS.author) },
      fields: [{ name: "Status", value: reply.byAsker ? "Waiting for a leader" : "Answered", inline: true }],
      timestamp: reply.createdAt.toISOString(),
    },
    reply.body,
  );
}

export interface NoShowsForDiscord {
  sessionId: string;
  kind: AttendanceKind;
  date: DateOnly;
  /** Who said they'd come but didn't check in, by name. */
  names: string[];
}

/** "Regular attendance · Tue, Sep 29" — "3 said they'd come but didn't check in: A, B, C". */
export function attendanceNoShowsPayload(s: NoShowsForDiscord, appUrl: string): DiscordPayload {
  const names = s.names.map((n) => safeLine(n, 100)).join(", ");
  const count = s.names.length;
  return payload({
    title: clip(`${ATTENDANCE_KIND_LABELS[s.kind]} attendance · ${formatDateOnly(s.date)}`, LIMITS.title),
    url: `${appUrl.replace(/\/+$/, "")}/attendance/sessions/${encodeURIComponent(s.sessionId)}`,
    description: clip(`${count} said they'd come but didn't check in: ${names}`, LIMITS.firstChunk),
    color: COLORS.noShows,
    footer: { text: "Give them part credit or No credit on the session page (click the title)." },
  });
}

export function testPayload(adminName: string, appUrl: string): DiscordPayload {
  return payload({
    title: "Huskyteers Portal is connected",
    url: appUrl,
    description: `Test message sent by ${safeLine(adminName, 200)}. New questions and replies will show up in this channel.`,
    color: COLORS.test,
  });
}

// ── sending ──────────────────────────────────────────────────────────────────

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** One HTTP call with a single retry after 429 (waits at most 5 s). Throws on network errors. */
async function callDiscord(url: string, init: RequestInit, options: DiscordOptions): Promise<Response> {
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  let res = await doFetch(url, { ...init, signal: AbortSignal.timeout(8000) });
  if (res.status === 429) {
    const data = (await res.json().catch(() => ({}))) as { retry_after?: number };
    await sleep(Math.min(5000, Math.max(250, Math.ceil((data.retry_after ?? 1) * 1000))));
    res = await doFetch(url, { ...init, signal: AbortSignal.timeout(8000) });
  }
  return res;
}

export interface PostResult {
  status: DiscordStatus;
  /** Ids of the messages created (when Discord returned them). */
  messageIds: string[];
}

/**
 * POST one or more messages (in order) and record the attempt in EmailLog. Never throws.
 * Uses `?wait=true` so Discord returns each message's id.
 */
export async function postToDiscord(
  db: Db,
  bodies: DiscordPayload | DiscordPayload[],
  kind: string,
  options: DiscordOptions = {},
): Promise<PostResult> {
  const url = resolveUrl(options);
  const list = Array.isArray(bodies) ? bodies : [bodies];
  if (!url || list.length === 0) return { status: "SKIPPED", messageIds: [] }; // Discord is optional

  const messageIds: string[] = [];
  let status: DiscordStatus = "SENT";
  let error: string | null = null;
  try {
    for (const body of list) {
      const res = await callDiscord(
        `${url}?wait=true`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
        options,
      );
      if (!res.ok) {
        status = "FAILED";
        error = `Discord ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`;
        break;
      }
      const data = (await res.json().catch(() => null)) as { id?: unknown } | null;
      if (data && typeof data.id === "string") messageIds.push(data.id);
    }
  } catch (e) {
    status = "FAILED";
    error = e instanceof Error ? e.message.slice(0, 500) : String(e).slice(0, 500);
  }
  if (error) console.error(`[discord] ${kind} failed:`, error);
  const subject = list[0]?.embeds[0]?.title ?? kind;
  try {
    await db.emailLog.create({
      data: { to: DISCORD_LOG_RECIPIENT, subject: subject.slice(0, 300), kind: `discord:${kind}`, status, error },
    });
  } catch (e) {
    console.error("[discord] could not write EmailLog", e);
  }
  return { status, messageIds };
}

/** Delete previously posted messages (e.g. when a question is deleted). Never throws; 404 = already gone. */
export async function deleteFromDiscord(messageIds: string[], options: DiscordOptions = {}): Promise<void> {
  const url = resolveUrl(options);
  if (!url) return;
  for (const id of messageIds) {
    if (!/^\d+$/.test(id)) continue;
    try {
      const res = await callDiscord(`${url}/messages/${id}`, { method: "DELETE" }, options);
      if (!res.ok && res.status !== 404) console.error(`[discord] could not delete message ${id}: ${res.status}`);
    } catch (e) {
      console.error(`[discord] could not delete message ${id}`, e);
    }
  }
}

const personSelect = { name: true, role: true, subteam: true } as const;

/**
 * Mirror question activity (and attendance no-shows) to Discord, if configured. Other events are ignored.
 * Questions addressed to one specific person (and their replies) are not posted.
 */
export async function deliverDiscord(db: Db, event: NotificationEvent, options: DiscordOptions = {}): Promise<void> {
  if (
    event.type !== "question.asked" &&
    event.type !== "question.replied" &&
    event.type !== "question.deleted" &&
    event.type !== "attendance.no_shows"
  ) {
    return;
  }
  const url = resolveUrl(options);
  if (!url) return;
  const opts: DiscordOptions = { ...options, webhookUrl: url };
  const appUrl = (options.appUrl ?? env.appUrl).replace(/\/+$/, "");

  if (event.type === "attendance.no_shows") {
    await deliverNoShows(db, event, appUrl, opts);
    return;
  }

  if (event.type === "question.deleted") {
    await deleteFromDiscord(event.discordMessageIds, opts);
    return;
  }

  if (event.type === "question.asked") {
    const q = await db.question.findUnique({
      where: { id: event.questionId },
      select: {
        id: true,
        title: true,
        body: true,
        subteam: true,
        recipientId: true,
        createdAt: true,
        asker: { select: personSelect },
        task: { select: { title: true } },
      },
    });
    if (!q || q.recipientId) return;
    const result = await postToDiscord(db, questionAskedPayloads({ ...q, taskTitle: q.task?.title ?? null }, appUrl), event.type, opts);
    await rememberIds(db, "question", q.id, result.messageIds, opts);
    return;
  }

  const reply = await db.questionReply.findUnique({
    where: { id: event.replyId },
    select: {
      id: true,
      body: true,
      createdAt: true,
      authorId: true,
      questionId: true,
      author: { select: personSelect },
      question: { select: { id: true, title: true, askerId: true, recipientId: true } },
    },
  });
  if (!reply || reply.questionId !== event.questionId || reply.question.recipientId) return;
  const result = await postToDiscord(
    db,
    questionRepliedPayloads(
      reply.question,
      { body: reply.body, createdAt: reply.createdAt, author: reply.author, byAsker: reply.authorId === reply.question.askerId },
      appUrl,
    ),
    event.type,
    opts,
  );
  await rememberIds(db, "reply", reply.id, result.messageIds, opts);
}

/**
 * The names of the people in the event who still aren't on the session's list (an admin may have added them
 * since it closed), then one post. Nothing when the session is gone or everyone's been dealt with.
 */
async function deliverNoShows(
  db: Db,
  event: Extract<NotificationEvent, { type: "attendance.no_shows" }>,
  appUrl: string,
  options: DiscordOptions,
): Promise<void> {
  if (event.userIds.length === 0) return;
  const session = await db.attendanceSession.findUnique({
    where: { id: event.sessionId },
    select: { id: true, kind: true, date: true, records: { where: { userId: { in: event.userIds } }, select: { userId: true } } },
  });
  if (!session) return;
  const onList = new Set(session.records.map((r) => r.userId));
  const people = await db.user.findMany({
    where: { id: { in: event.userIds.filter((id) => !onList.has(id)) } },
    select: { name: true },
    orderBy: { name: "asc" },
  });
  if (people.length === 0) return;
  const names = people.map((p) => p.name).sort((a, b) => a.localeCompare(b));
  await postToDiscord(
    db,
    attendanceNoShowsPayload({ sessionId: session.id, kind: session.kind, date: dbToDateOnly(session.date), names }, appUrl),
    event.type,
    options,
  );
}

/** Store message ids on the row. If the row was deleted meanwhile, remove the posts instead. */
async function rememberIds(db: Db, kind: "question" | "reply", id: string, messageIds: string[], options: DiscordOptions): Promise<void> {
  if (messageIds.length === 0) return;
  const data = { discordMessageIds: { push: messageIds } };
  const { count } =
    kind === "question"
      ? await db.question.updateMany({ where: { id }, data })
      : await db.questionReply.updateMany({ where: { id }, data });
  if (count === 0) await deleteFromDiscord(messageIds, options);
}
