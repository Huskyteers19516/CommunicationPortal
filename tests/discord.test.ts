import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "@/server/actor";
import { ForbiddenError } from "@/server/errors";
import { deliverNotification } from "@/server/notifications/deliver";
import {
  type DiscordPayload,
  type FetchLike,
  deliverDiscord,
  discordWebhookUrl,
  escapeMarkdown,
  postToDiscord,
  questionAskedPayloads,
  splitForDiscord,
} from "@/server/notifications/discord";
import { sendDiscordTest } from "@/server/services/admin";
import { deleteQuestion } from "@/server/services/questions";
import { createTestDb, type TestDb } from "./helpers/db";
import { contextFor, makeTask, makeUser } from "./helpers/factories";

const WEBHOOK = "https://discord.com/api/webhooks/123456789012345678/abcDEF_ghi-JKL";
const APP_URL = "https://portal.example.org";

let t: TestDb;
let asker: Actor;
let buildLead: Actor;
let admin: Actor;

beforeAll(async () => {
  t = await createTestDb();
  asker = await makeUser(t.db, { name: "Maya Patel", role: "MEMBER", subteam: "BUILD" });
  buildLead = await makeUser(t.db, { name: "Marcus Johnson", role: "BUILD_LEADER" });
  admin = await makeUser(t.db, { name: "Jordan Lee", role: "CAPTAIN", isAdmin: true });
});
afterAll(async () => {
  await t.drop();
});

type Call = { url: string; method: string; body: DiscordPayload | null };

/**
 * A stand-in for Discord: records requests; POSTs answer like `?wait=true` (200 + message id),
 * unless explicit responses are queued.
 */
function fakeDiscord(...queued: Array<Response | Error>) {
  const calls: Call[] = [];
  let nextId = 1000;
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, method: String(init.method), body: init.body ? JSON.parse(String(init.body)) : null });
    const next = queued.shift();
    if (next instanceof Error) throw next;
    if (next) return next;
    if (init.method === "DELETE") return new Response(null, { status: 204 });
    return Response.json({ id: String(nextId++) });
  };
  return { calls, fetch, posts: () => calls.filter((c) => c.method === "POST") };
}
const noSleep = async () => {};

async function makeQuestion(data: { title?: string; body?: string; subteam?: "BUILD" | null; recipientId?: string | null; taskId?: string } = {}) {
  return t.db.question.create({
    data: {
      title: data.title ?? "How tight should the chain be?",
      body: data.body ?? "It skips under load.",
      askerId: asker.id,
      subteam: data.subteam === undefined ? "BUILD" : data.subteam,
      recipientId: data.recipientId ?? null,
      taskId: data.taskId ?? null,
    },
  });
}

describe("webhook URL", () => {
  it("accepts only Discord webhook links", () => {
    expect(discordWebhookUrl(WEBHOOK)).toBe(WEBHOOK);
    expect(discordWebhookUrl(`  ${WEBHOOK}  `)).toBe(WEBHOOK);
    expect(discordWebhookUrl("https://discordapp.com/api/webhooks/1/x")).not.toBeNull();
    expect(discordWebhookUrl("https://canary.discord.com/api/webhooks/1/x")).not.toBeNull();
    expect(discordWebhookUrl("http://discord.com/api/webhooks/1/x")).toBeNull();
    expect(discordWebhookUrl("https://evil.example.com/api/webhooks/1/x")).toBeNull();
    expect(discordWebhookUrl("https://discord.com.evil.io/api/webhooks/1/x")).toBeNull();
    expect(discordWebhookUrl(`${WEBHOOK}?wait=true`)).toBeNull();
    expect(discordWebhookUrl("")).toBeNull();
    expect(discordWebhookUrl(undefined)).toBeNull();
  });
});

describe("message formatting", () => {
  it("escapes markdown but keeps links clickable (wrapped in <…>, trailing punctuation outside)", () => {
    expect(escapeMarkdown("**bold** [fake](https://evil.example) # head")).toBe(
      "\\*\\*bold\\*\\* \\[fake\\](<https://evil.example>) \\# head",
    );
    expect(escapeMarkdown("see https://docs.example.com/a_b-c?x=1.")).toBe("see <https://docs.example.com/a_b-c?x=1>.");
    expect(escapeMarkdown("(https://x.com/a)*")).toBe("(<https://x.com/a>)\\*");
  });

  it("builds a full-question card that can't ping anyone", () => {
    const [p, ...more] = questionAskedPayloads(
      {
        id: "q1",
        title: "Help @everyone",
        body: "Ping @here and @everyone <@&123>",
        subteam: "BUILD",
        createdAt: new Date("2026-09-25T18:00:00Z"),
        asker: { name: "Maya Patel", role: "MEMBER", subteam: "BUILD" },
        taskTitle: "Wire the drivetrain",
      },
      APP_URL,
    );
    expect(more).toEqual([]);
    expect(p.allowed_mentions).toEqual({ parse: [] });
    const e = p.embeds[0];
    expect(e.url).toBe(`${APP_URL}/questions/q1`);
    expect(e.author?.name).toBe("Maya Patel · Build member");
    expect(e.description).not.toMatch(/@everyone|@here/);
    expect(e.description).toContain("@​everyone");
    expect(e.fields).toEqual([
      { name: "To", value: "Build leaders", inline: true },
      { name: "Topic", value: "Build", inline: true },
      { name: "About task", value: "Wire the drivetrain" },
    ]);
    expect(e.timestamp).toBe("2026-09-25T18:00:00.000Z");
  });

  it("posts a 5000-character question in full across messages, each within Discord's limits", () => {
    const words = Array.from({ length: 1000 }, (_, i) => `w${i}_x`).join(" "); // ~6000 chars once escaped
    const payloads = questionAskedPayloads(
      {
        id: "q2",
        title: "x".repeat(1000),
        body: words,
        subteam: null,
        createdAt: new Date(),
        asker: { name: "Maya", role: "MEMBER", subteam: "BUILD" },
        taskTitle: "t".repeat(2000),
      },
      APP_URL,
    );
    expect(payloads.length).toBeGreaterThan(1);
    for (const p of payloads) {
      const e = p.embeds[0];
      expect(JSON.stringify(e).length).toBeLessThan(6000);
      expect((e.description ?? "").length).toBeLessThanOrEqual(4096);
      expect((e.title ?? "").length).toBeLessThanOrEqual(256);
      expect(p.allowed_mentions).toEqual({ parse: [] });
    }
    expect(payloads.map((p) => p.embeds[0].description).join("")).toBe(escapeMarkdown(words));
    expect(payloads[0].embeds[0].fields?.[0]).toEqual({ name: "To", value: "Captain (whole team)", inline: true });
    expect(payloads.at(-1)?.embeds[0].footer?.text).toBe(`continued (${payloads.length}/${payloads.length})`);
  });

  it("never splits an escape sequence or an emoji", () => {
    const text = `${"a".repeat(9)}\\*${"😀".repeat(5)}`;
    const chunks = splitForDiscord(text, 10, 3);
    expect(chunks.join("")).toBe(text);
    for (const c of chunks) {
      expect(c.endsWith("\\") && !c.endsWith("\\\\")).toBe(false);
      expect(Array.from(c).every((ch) => ch.length === 1 || ch === "😀")).toBe(true);
    }
  });
});

describe("posting", () => {
  it("posts a new question, saves its message id, and logs it", async () => {
    const task = await makeTask(t.db, buildLead, { title: "Replace the chain", assigneeIds: [asker.id] });
    const q = await makeQuestion({ taskId: task.id });
    const d = fakeDiscord();
    await deliverDiscord(t.db, { type: "question.asked", questionId: q.id }, { webhookUrl: WEBHOOK, appUrl: APP_URL, fetch: d.fetch });
    expect(d.posts()).toHaveLength(1);
    expect(d.posts()[0].url).toBe(`${WEBHOOK}?wait=true`);
    const e = d.posts()[0].body!.embeds[0];
    expect(e.title).toBe("New question: How tight should the chain be?");
    expect(e.description).toBe("It skips under load.");
    expect(e.fields?.find((f) => f.name === "About task")?.value).toBe("Replace the chain");
    expect((await t.db.question.findUniqueOrThrow({ where: { id: q.id } })).discordMessageIds).toEqual(["1000"]);
    const log = await t.db.emailLog.findFirst({ where: { kind: "discord:question.asked" }, orderBy: { createdAt: "desc" } });
    expect(log).toMatchObject({ to: "Discord", status: "SENT", error: null });
  });

  it("does not post questions addressed to one specific person, or their replies", async () => {
    const q = await makeQuestion({ recipientId: buildLead.id });
    const r = await t.db.questionReply.create({ data: { questionId: q.id, authorId: buildLead.id, body: "Private answer" } });
    const d = fakeDiscord();
    await deliverDiscord(t.db, { type: "question.asked", questionId: q.id }, { webhookUrl: WEBHOOK, fetch: d.fetch });
    await deliverDiscord(t.db, { type: "question.replied", questionId: q.id, replyId: r.id }, { webhookUrl: WEBHOOK, fetch: d.fetch });
    expect(d.calls).toHaveLength(0);
  });

  it("posts replies: a leader's answer vs. the asker's follow-up", async () => {
    const q = await makeQuestion({ title: "Which battery?" });
    const answer = await t.db.questionReply.create({ data: { questionId: q.id, authorId: buildLead.id, body: "Use the blue one." } });
    const followUp = await t.db.questionReply.create({ data: { questionId: q.id, authorId: asker.id, body: "Thanks! And the charger?" } });
    const d = fakeDiscord();
    const opts = { webhookUrl: WEBHOOK, appUrl: APP_URL, fetch: d.fetch };
    await deliverDiscord(t.db, { type: "question.replied", questionId: q.id, replyId: answer.id }, opts);
    await deliverDiscord(t.db, { type: "question.replied", questionId: q.id, replyId: followUp.id }, opts);
    expect(d.posts().map((c) => c.body!.embeds[0].title)).toEqual(["Answered: Which battery?", "Follow-up: Which battery?"]);
    expect(d.posts()[0].body!.embeds[0].author?.name).toBe("Marcus Johnson · Build Leader");
    expect(d.posts()[1].body!.embeds[0].fields?.[0].value).toBe("Waiting for a leader");
    expect((await t.db.questionReply.findUniqueOrThrow({ where: { id: answer.id } })).discordMessageIds).toHaveLength(1);
    // A reply id that doesn't belong to the question is ignored.
    await deliverDiscord(t.db, { type: "question.replied", questionId: "other", replyId: answer.id }, opts);
    expect(d.posts()).toHaveLength(2);
  });

  it("does nothing when Discord isn't set up, or for non-question events", async () => {
    const q = await makeQuestion();
    const d = fakeDiscord();
    const before = await t.db.emailLog.count();
    await deliverDiscord(t.db, { type: "question.asked", questionId: q.id }, { webhookUrl: null, fetch: d.fetch });
    await deliverDiscord(t.db, { type: "question.asked", questionId: q.id }, { webhookUrl: "https://example.com/hook", fetch: d.fetch });
    await deliverDiscord(t.db, { type: "task.assigned", taskId: "x", userIds: [] }, { webhookUrl: WEBHOOK, fetch: d.fetch });
    await deliverDiscord(t.db, { type: "question.asked", questionId: "missing" }, { webhookUrl: WEBHOOK, fetch: d.fetch });
    expect(d.calls).toHaveLength(0);
    expect(await t.db.emailLog.count()).toBe(before);
  });

  it("retries once after a rate limit, and logs failures without throwing", async () => {
    const [body] = questionAskedPayloads(
      { id: "q", title: "T", body: "B", subteam: null, createdAt: new Date(), asker: { name: "A", role: "MEMBER", subteam: "BUILD" }, taskTitle: null },
      APP_URL,
    );
    const limited = fakeDiscord(Response.json({ retry_after: 0.2 }, { status: 429 }));
    expect(await postToDiscord(t.db, body, "question.asked", { webhookUrl: WEBHOOK, fetch: limited.fetch, sleep: noSleep })).toEqual({
      status: "SENT",
      messageIds: ["1000"],
    });
    expect(limited.calls).toHaveLength(2);

    const broken = fakeDiscord(new Response("Unknown Webhook", { status: 404 }));
    expect((await postToDiscord(t.db, body, "question.asked", { webhookUrl: WEBHOOK, fetch: broken.fetch, sleep: noSleep })).status).toBe("FAILED");
    const failedLog = await t.db.emailLog.findFirst({ where: { status: "FAILED", to: "Discord" }, orderBy: { createdAt: "desc" } });
    expect(failedLog?.error).toContain("Discord 404");

    const offline = fakeDiscord(new Error("network down"));
    expect((await postToDiscord(t.db, body, "question.asked", { webhookUrl: WEBHOOK, fetch: offline.fetch, sleep: noSleep })).status).toBe("FAILED");
  });

  it("runs alongside the emails in deliverNotification", async () => {
    const q = await makeQuestion();
    const sent: string[] = [];
    const d = fakeDiscord();
    await deliverNotification(
      t.db,
      { type: "question.asked", questionId: q.id },
      { transport: { name: "fake", send: async (m) => void sent.push(m.to) }, appUrl: APP_URL, discord: { webhookUrl: WEBHOOK, fetch: d.fetch } },
    );
    expect(sent).toEqual([buildLead.email]);
    expect(d.posts()).toHaveLength(1);
  });
});

describe("deleting a question removes its Discord posts", () => {
  it("deleteQuestion emits the ids, and delivery deletes those messages", async () => {
    const q = await makeQuestion({ title: "Oops, wrong channel" });
    const d = fakeDiscord();
    await deliverDiscord(t.db, { type: "question.asked", questionId: q.id }, { webhookUrl: WEBHOOK, fetch: d.fetch });
    const [id] = (await t.db.question.findUniqueOrThrow({ where: { id: q.id } })).discordMessageIds;

    const ctx = contextFor(t.db, asker);
    await deleteQuestion(ctx, { questionId: q.id });
    const events = ctx.notifier.ofType("question.deleted");
    expect(events).toEqual([{ type: "question.deleted", questionId: q.id, discordMessageIds: [id] }]);

    await deliverNotification(t.db, events[0], { transport: null, discord: { webhookUrl: WEBHOOK, fetch: d.fetch } });
    expect(d.calls.filter((c) => c.method === "DELETE").map((c) => c.url)).toEqual([`${WEBHOOK}/messages/${id}`]);
  });

  it("an admin deleting a question also removes the posted replies", async () => {
    const q = await makeQuestion();
    const r = await t.db.questionReply.create({ data: { questionId: q.id, authorId: buildLead.id, body: "Answer" } });
    await t.db.question.update({ where: { id: q.id }, data: { discordMessageIds: ["11"] } });
    await t.db.questionReply.update({ where: { id: r.id }, data: { discordMessageIds: ["12", "13"] } });
    const ctx = contextFor(t.db, admin);
    await deleteQuestion(ctx, { questionId: q.id });
    expect(ctx.notifier.ofType("question.deleted")[0].discordMessageIds.sort()).toEqual(["11", "12", "13"]);
  });

  it("no event when nothing was posted", async () => {
    const q = await makeQuestion();
    const ctx = contextFor(t.db, asker);
    await deleteQuestion(ctx, { questionId: q.id });
    expect(ctx.notifier.ofType("question.deleted")).toEqual([]);
  });
});

describe("admin test message", () => {
  it("only people with admin access can send it; reports whether Discord is set up", async () => {
    const member = await makeUser(t.db, { role: "MEMBER", subteam: "BUILD" });
    await expect(sendDiscordTest(contextFor(t.db, member), { webhookUrl: WEBHOOK })).rejects.toBeInstanceOf(ForbiddenError);
    // Leaders have admin access too.
    expect(await sendDiscordTest(contextFor(t.db, buildLead), { webhookUrl: null })).toBe("SKIPPED");
    expect(await sendDiscordTest(contextFor(t.db, admin), { webhookUrl: null })).toBe("SKIPPED");
    const d = fakeDiscord();
    expect(await sendDiscordTest(contextFor(t.db, admin), { webhookUrl: WEBHOOK, fetch: d.fetch })).toBe("SENT");
    expect(d.posts()[0].body!.embeds[0].title).toBe("Huskyteers Portal is connected");
    expect(d.posts()[0].body!.allowed_mentions).toEqual({ parse: [] });
  });
});
