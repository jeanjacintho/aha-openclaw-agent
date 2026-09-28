import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { saveConfig } from "../aha/config.ts";
import { sendToChat } from "../aha/notify/plow.ts";
import { writeSecrets } from "../aha/secrets.ts";
import { recordDraftEvent } from "../aha/responder/draft-events.ts";
import { postLedgerKey, threadLedgerKey } from "../aha/responder/post.ts";
import { openStore } from "../aha/store/db.ts";
import entry from "../plugin/index.ts";

type ToolResult = { isError?: boolean; content: { type: string; text: string }[]; details?: unknown };
type Tool = {
  name: string;
  execute: (id: string, args: Record<string, unknown>) => Promise<ToolResult>;
};
type ToolCtx = {
  senderIsOwner?: boolean;
  requesterSenderId?: string;
  nativeChannelId?: string;
};

const environment = { ...process.env };
function env(t: import("node:test").TestContext, values: Record<string, string | undefined>) {
  t.after(() => { for (const key of Object.keys({ ...values, ...process.env })) if (key in environment) process.env[key] = environment[key]; else delete process.env[key]; });
  for (const [key, value] of Object.entries(values)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
}

async function home(
  t: import("node:test").TestContext,
  posts: { url: string; body: string }[] = [],
  redditOutcome?: "posted" | "uncertain",
  onMessage?: (url: string, body: string) => Promise<void>,
  redditPosts: string[] = [],
) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aha-approve-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  env(t, { AHA_HOME: dir, PLOW_API_BASE: "http://plow.test", PLOW_AGENT_TOKEN: "tok" });
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("oauth.reddit.com/api/comment")) {
      redditPosts.push(new URLSearchParams(String(init?.body ?? "")).get("text") ?? "");
      if (redditOutcome === "posted") return Response.json({ json: { data: { things: [{ data: { name: "t1_reply", permalink: "/r/test/comments/thread/reply" } }] } } });
      if (redditOutcome === "uncertain") return new Response("gateway error", { status: 500 });
    }
    if (url.includes("oauth.reddit.com/api/info")) return Response.json({ data: { children: [{
      data: { name: "t1_reply", parent_id: "t3_thread", body: "Thanks for asking about Plow queues.\n— AHA, AI assistant of Plow", author: "aha" },
    }] } });
    if ((init?.method ?? "GET") === "POST" && url.includes("/messages")) {
      const body = String(init?.body ?? "");
      posts.push({ url, body });
      await onMessage?.(url, body);
      return Response.json({ uid: "msg_ok" });
    }
    return new Response("", { status: 404 });
  });
  const store = openStore(dir);
  saveConfig(store, { company: { name: "Plow" }, ownerChatUid: "cht_dm", links: ["https://news.ycombinator.com/item?id=1"] });
  store.close();
  return dir;
}

function tools(ctx: ToolCtx) {
  const byName = new Map<string, Tool>();
  const plow = { apiBase: process.env.PLOW_API_BASE || "http://plow.test", lineUid: "line", accountId: "chat" };
  entry.register({
    registrationMode: "full",
    runtime: {},
    logger: { info() {} },
    on() {},
    registerChannel() {},
    registerTool(factory: (context: object) => Tool) {
      const tool = factory({ ...ctx, config: { channels: { plow } } });
      byName.set(tool.name, tool);
    },
  });
  return byName;
}

function seed(dir: string, over: { category?: string } = {}) {
  const store = openStore(dir);
  store.db.prepare(`INSERT INTO items (source, external_id, url, author, title, body, published_at, fetched_at, state)
    VALUES ('hn', ?, 'https://news.ycombinator.com/item?id=1', 'a', 'Plow queues', 'Does plow queue jobs?', '2026-09-22T00:00:00.000Z', '2026-09-22T00:00:00.000Z', 'assigned')`).run(String(Math.random()));
  const itemId = Number((store.db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id);
  store.db.prepare(`INSERT INTO classifications (item_id, sentiment, category, topic, language, is_question, urgency, about, confidence)
    VALUES (?, 0, ?, 'queues', 'en', 1, 'low', 'self', 0.9)`).run(itemId, over.category ?? "question");
  store.db.prepare("INSERT INTO drafts (item_id, body, state) VALUES (?, ?, 'pending')")
    .run(itemId, "Thanks for asking about Plow queues.\n— AHA, AI assistant of Plow");
  const draftId = Number((store.db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id);
  store.close();
  return { itemId, draftId };
}

function seedReddit(dir: string) {
  const store = openStore(dir);
  store.db.prepare(`INSERT INTO items (source, external_id, url, author, title, body, published_at, fetched_at, state)
    VALUES ('reddit', 't3_thread', 'https://www.reddit.com/r/test/comments/thread/', 'alice', 'Plow queues', 'Does plow queue jobs?', '2026-09-22T00:00:00.000Z', '2026-09-22T00:00:00.000Z', 'assigned')`).run();
  const itemId = Number((store.db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id);
  store.db.prepare(`INSERT INTO classifications (item_id, sentiment, category, topic, language, is_question, urgency, about, confidence)
    VALUES (?, 0, 'question', 'queues', 'en', 1, 'low', 'self', 0.9)`).run(itemId);
  store.db.prepare("INSERT INTO drafts (item_id, body, state) VALUES (?, ?, 'pending')")
    .run(itemId, "Thanks for asking about Plow queues.\n— AHA, AI assistant of Plow");
  const draftId = Number((store.db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id);
  store.close();
  return { itemId, draftId };
}

function seedAbsentRetry(dir: string, states: { post?: string; thread?: string } = {}) {
  const store = openStore(dir);
  const approvedAt = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const url = "https://www.reddit.com/r/test/comments/thread/slug/";
  const externalId = "t3_thread";
  const body = "Thanks for asking about Plow queues.\n— AHA, AI assistant of Plow";
  store.db.prepare(`INSERT INTO items (source, external_id, url, author, title, body, published_at, fetched_at, state)
    VALUES ('reddit', ?, ?, 'alice', 'Plow queues', 'Does plow queue jobs?', ?, ?, 'assigned')`)
    .run(externalId, url, approvedAt, approvedAt);
  const itemId = Number((store.db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id);
  store.db.prepare(`INSERT INTO classifications (item_id, sentiment, category, topic, language, is_question, urgency, about, confidence)
    VALUES (?, 0, 'question', 'queues', 'en', 1, 'low', 'self', 0.9)`).run(itemId);
  const hash = createHash("sha256").update(body).digest("hex");
  store.db.prepare(`INSERT INTO drafts (item_id, body, state, approved_sha256, approved_at)
    VALUES (?, ?, 'approved', ?, ?)`)
    .run(itemId, body, hash, approvedAt);
  const draftId = Number((store.db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id);
  const postKey = postLedgerKey(approvedAt.slice(0, 10), "reddit", externalId, url);
  const threadKey = threadLedgerKey("reddit", externalId, url);
  store.db.prepare("INSERT INTO ledger (key, state, url) VALUES (?, ?, ?)").run(postKey, states.post ?? "absent", url);
  store.db.prepare("INSERT INTO ledger (key, state, url) VALUES (?, ?, ?)").run(threadKey, states.thread ?? "absent", url);
  recordDraftEvent(store, { draftId, itemId, actor: "mem_retry", action: "approved", body, at: new Date(approvedAt) });
  store.db.prepare("INSERT INTO people_roles (person, role) VALUES ('mem_retry', 'marketing')").run();
  store.close();
  return { itemId, draftId, body, postKey, threadKey, approvedAt, url };
}

test("aha_pause blocks group sends immediately and survives a store reopen", async t => {
  const dir = await home(t);
  const owner = tools({ senderIsOwner: true, requesterSenderId: "plow-owner", nativeChannelId: "cht_dm" });
  const paused = await owner.get("aha_pause")!.execute("call", {});
  assert.equal(paused.isError ?? false, false);
  assert.equal((paused.details as { paused: boolean }).paused, true);
  const first = openStore(dir);
  assert.equal((first.db.prepare("SELECT paused FROM flags WHERE id = 1").get() as { paused: number }).paused, 1);
  first.close();
  const second = openStore(dir);
  t.after(() => second.close());
  assert.equal((second.db.prepare("SELECT paused FROM flags WHERE id = 1").get() as { paused: number }).paused, 1);
  const fetchImpl = async () => new Response(JSON.stringify({ uid: "msg" }), { status: 200 });
  assert.equal(await sendToChat("cht_group", "hi", "k-group", { store: second, fetch: fetchImpl }), "failed");
  assert.equal(await sendToChat("cht_dm", "hi", "k-dm", { store: second, fetch: fetchImpl }), "sent");
});

test("a non-owner cannot pause", async t => {
  await home(t);
  const map = tools({ senderIsOwner: false, requesterSenderId: "mem_mkt", nativeChannelId: "cht_marketing" });
  const result = await map.get("aha_pause")!.execute("call", {});
  assert.equal(result.isError, true);
});

test("aha_not_us records a negative example used by classify", async t => {
  const dir = await home(t);
  const { itemId } = seed(dir, { category: "question" });
  const owner = tools({ senderIsOwner: true, requesterSenderId: "plow-owner", nativeChannelId: "cht_dm" });
  const result = await owner.get("aha_not_us")!.execute("call", { itemId: `AHA-${itemId}` });
  assert.equal(result.isError ?? false, false);
  const store = openStore(dir);
  t.after(() => store.close());
  const row = store.db.prepare("SELECT kind, text FROM feedback_examples WHERE item_id = ?").get(itemId) as { kind: string; text: string };
  assert.equal(row.kind, "negative");
  assert.equal(row.text, `NOT US AHA-${itemId}`);
  assert.equal((store.db.prepare("SELECT state FROM items WHERE id = ?").get(itemId) as { state: string }).state, "irrelevant");
});

test("aha_logs returns draft events without draft or post bodies", async t => {
  const dir = await home(t);
  const { itemId } = seed(dir);
  const owner = tools({ senderIsOwner: true, requesterSenderId: "plow-owner", nativeChannelId: "cht_dm" });
  await owner.get("aha_approve")!.execute("call", { draftId: `AHA-${itemId}` });
  const result = await owner.get("aha_logs")!.execute("call", { id: `AHA-${itemId}` });
  assert.equal(result.isError ?? false, false);
  const details = result.details as { publicId: string; item: { id: number; body?: string }; drafts: { id: number; chars?: number; body?: string }[]; draftEvents: { action: string; body_sha256: string | null }[]; classification: { topic?: string } };
  assert.equal(details.publicId, `AHA-${itemId}`);
  assert.equal(details.item.id, itemId);
  assert.equal("body" in details.item, false);
  assert.equal("topic" in (details.classification ?? {}), false);
  assert.equal("body" in details.drafts[0], false);
  assert.equal(typeof details.drafts[0].chars, "number");
  assert.deepEqual(details.draftEvents.map(event => event.action), ["approved"]);
  assert.match(details.draftEvents[0].body_sha256 ?? "", /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(result.details).includes("Does plow queue jobs?"), false);
  assert.equal(JSON.stringify(result.details).includes("Thanks for asking"), false);
});

test("approving sends the reply to the chat and returns only sent:true", async t => {
  const posts: { url: string; body: string }[] = [];
  const dir = await home(t, posts);
  const { itemId, draftId } = seed(dir);
  const owner = tools({ senderIsOwner: true, requesterSenderId: "plow-owner", nativeChannelId: "cht_dm" });
  const result = await owner.get("aha_approve")!.execute("call", { draftId: `AHA-${itemId}` });
  assert.equal(result.isError ?? false, false);
  assert.deepEqual(result.details, { sent: true });
  assert.equal(JSON.stringify(result).includes("Thanks for asking"), false);
  assert.equal(posts.some(row => row.url.includes("/chats/cht_dm/messages") && row.body.includes("AI assistant of Plow")), true);
  const store = openStore(dir);
  t.after(() => store.close());
  assert.equal((store.db.prepare("SELECT state FROM drafts WHERE id = ?").get(draftId) as { state: string }).state, "approved");
});

test("an edit during the approval wait cannot change the body published to Reddit", async t => {
  const posts: { url: string; body: string }[] = [];
  const redditPosts: string[] = [];
  let owner: ReturnType<typeof tools>;
  let publicId = "";
  let editResult: ToolResult | undefined;
  const dir = await home(t, posts, "posted", async (_url, body) => {
    if (body.includes("Promover question")) {
      editResult = await owner.get("aha_edit")!.execute("edit", {
        draftId: publicId, text: "Thanks for asking about Plow queues with a changed reply. — AHA, AI assistant of Plow",
      });
    }
  }, redditPosts);
  writeSecrets(dir, { reddit: "reddit-token" });
  const { itemId } = seedReddit(dir);
  publicId = `AHA-${itemId}`;
  const store = openStore(dir);
  store.db.prepare("INSERT INTO autonomy (source, category, level, streak, suggested) VALUES ('reddit', 'question', 'L1', 4, 0)").run();
  store.close();
  owner = tools({ senderIsOwner: true, requesterSenderId: "plow-owner", nativeChannelId: "cht_dm" });

  const result = await owner.get("aha_approve")!.execute("approve", { draftId: `AHA-${itemId}` });
  assert.equal(result.isError ?? false, false);
  assert.equal(editResult?.isError, true);
  assert.match(editResult?.content[0].text ?? "", /no longer pending/);
  assert.equal(redditPosts.length, 1);
  assert.equal(redditPosts[0], "Thanks for asking about Plow queues.\n— AHA, AI assistant of Plow");
});

test("aha_edit refuses an already approved draft", async t => {
  const dir = await home(t);
  const { itemId, draftId } = seed(dir);
  const owner = tools({ senderIsOwner: true, requesterSenderId: "plow-owner", nativeChannelId: "cht_dm" });
  assert.equal((await owner.get("aha_approve")!.execute("approve", { draftId: `AHA-${itemId}` })).isError ?? false, false);
  const edited = await owner.get("aha_edit")!.execute("edit", {
    draftId: `AHA-${itemId}`, text: "Thanks for asking about Plow queues with a new approved response. — AHA, AI assistant of Plow",
  });
  assert.equal(edited.isError, true);
  assert.match(edited.content[0].text, /no longer pending/);
  const store = openStore(dir);
  t.after(() => store.close());
  assert.equal((store.db.prepare("SELECT body FROM drafts WHERE id = ?").get(draftId) as { body: string }).body, "Thanks for asking about Plow queues.\n— AHA, AI assistant of Plow");
});

test("aha_edit records the hash of the edited body", async t => {
  const dir = await home(t);
  const { itemId } = seed(dir);
  const owner = tools({ senderIsOwner: true, requesterSenderId: "plow-editor", nativeChannelId: "cht_dm" });
  const editedBody = "Thanks for asking about queues. — AHA, AI assistant of Plow";
  const result = await owner.get("aha_edit")!.execute("edit", { draftId: `AHA-${itemId}`, text: editedBody });
  assert.equal(result.isError ?? false, false);
  const store = openStore(dir);
  t.after(() => store.close());
  const event = store.db.prepare("SELECT actor, action, body_sha256, detail FROM draft_events WHERE item_id = ?").get(itemId) as {
    actor: string; action: string; body_sha256: string; detail: string | null;
  };
  assert.deepEqual({ ...event }, { actor: "plow-editor", action: "edited", body_sha256: createHash("sha256").update(editedBody).digest("hex"), detail: null });
  assert.equal(JSON.stringify(event).includes(editedBody), false);
});

test("aha_ignore records the actor but never the free-text reason", async t => {
  const dir = await home(t);
  const { itemId } = seed(dir);
  const owner = tools({ senderIsOwner: true, requesterSenderId: "plow-reviewer", nativeChannelId: "cht_dm" });
  const reason = "contains private text evil.example/secret";
  const result = await owner.get("aha_ignore")!.execute("ignore", { draftId: `AHA-${itemId}`, reason });
  assert.equal(result.isError ?? false, false);
  const store = openStore(dir);
  t.after(() => store.close());
  const event = store.db.prepare("SELECT actor, action, body_sha256, detail FROM draft_events WHERE item_id = ?").get(itemId) as {
    actor: string; action: string; body_sha256: string; detail: string | null;
  };
  assert.equal(event.actor, "plow-reviewer");
  assert.equal(event.action, "ignored");
  assert.equal(event.body_sha256?.length, 64);
  assert.equal(event.detail, null);
  assert.equal(JSON.stringify(event).includes(reason), false);
});

test("aha_retry posts an absent Reddit approval once and atomically refreshes approved_at", async t => {
  const redditPosts: string[] = [];
  const dir = await home(t, [], "posted", undefined, redditPosts);
  writeSecrets(dir, { reddit: "reddit-token" });
  const seeded = seedAbsentRetry(dir);
  const member = tools({ senderIsOwner: false, requesterSenderId: "mem_retry", nativeChannelId: "cht_marketing" });
  const before = Date.parse(seeded.approvedAt);
  const result = await member.get("aha_retry")!.execute("retry", { draftId: `AHA-${seeded.itemId}` });
  assert.equal(result.isError ?? false, false);
  assert.deepEqual(result.details, { sent: true, status: "posted" });
  assert.equal(redditPosts.length, 1);
  assert.equal(redditPosts[0], seeded.body);

  const store = openStore(dir);
  t.after(() => store.close());
  const retryAt = Date.parse((store.db.prepare("SELECT approved_at AS at FROM drafts WHERE id = ?").get(seeded.draftId) as { at: string }).at);
  assert.ok(retryAt > before);
  assert.equal((store.db.prepare("SELECT state FROM ledger WHERE key = ?").get(seeded.threadKey) as { state: string }).state, "verified");
  const retryPostKey = postLedgerKey(new Date(retryAt).toISOString().slice(0, 10), "reddit", "t3_thread", seeded.url);
  assert.equal((store.db.prepare("SELECT state FROM ledger WHERE key = ?").get(retryPostKey) as { state: string }).state, "verified");
  assert.equal((store.db.prepare("SELECT claimed_at AS claimedAt FROM ledger WHERE key = ?").get(retryPostKey) as { claimedAt: string }).claimedAt, new Date(retryAt).toISOString());
  assert.equal((store.db.prepare("SELECT claimed_at AS claimedAt FROM ledger WHERE key = ?").get(seeded.threadKey) as { claimedAt: string }).claimedAt, new Date(retryAt).toISOString());
  assert.equal((store.db.prepare("SELECT state FROM ledger WHERE key = ?").get(seeded.postKey) as { state: string }).state, "absent");
  const retryEvent = store.db.prepare(`SELECT actor, action, body_sha256 FROM draft_events
    WHERE draft_id = ? AND action = 'retried'`).get(seeded.draftId) as { actor: string; action: string; body_sha256: string };
  assert.deepEqual({ ...retryEvent }, { actor: "mem_retry", action: "retried", body_sha256: createHash("sha256").update(seeded.body).digest("hex") });
});

test("an uncertain retry notifies the owner even when the original notice used the same day's post key", async t => {
  const messages: { url: string; body: string }[] = [];
  const redditPosts: string[] = [];
  const dir = await home(t, messages, "uncertain", undefined, redditPosts);
  writeSecrets(dir, { reddit: "reddit-token" });
  const seeded = seedAbsentRetry(dir);
  const store = openStore(dir);
  const now = new Date().toISOString();
  const retryPostKey = postLedgerKey(now.slice(0, 10), "reddit", "t3_thread", seeded.url);
  const oldNoticeKey = `uncertain:${retryPostKey}`;
  store.db.prepare("UPDATE drafts SET approved_at = ? WHERE id = ?").run(now, seeded.draftId);
  store.db.prepare("DELETE FROM ledger WHERE key = ?").run(seeded.postKey);
  store.db.prepare("INSERT INTO ledger (key, state, url) VALUES (?, 'absent', ?)").run(retryPostKey, seeded.url);
  store.db.prepare(`INSERT INTO deliveries (key, chat_uid, status, message_uid, created_at, updated_at, body)
    VALUES (?, 'cht_dm', 'sent', 'original_notice', ?, ?, NULL)`).run(oldNoticeKey, now, now);
  store.close();

  const member = tools({ senderIsOwner: false, requesterSenderId: "mem_retry", nativeChannelId: "cht_marketing" });
  const result = await member.get("aha_retry")!.execute("retry", { draftId: `AHA-${seeded.itemId}` });
  assert.deepEqual(result.details, {
    sent: false, status: "uncertain", reason: "Reddit outcome is uncertain; reconciliation will check automatically",
  });
  assert.equal(redditPosts.length, 1);
  const notices = messages.filter(message => message.url.includes("/chats/cht_dm/messages") && message.body.includes("Uncertain Reddit post"));
  assert.equal(notices.length, 1);
  const after = openStore(dir);
  t.after(() => after.close());
  assert.equal((after.db.prepare("SELECT status FROM deliveries WHERE key = ?").get(oldNoticeKey) as { status: string }).status, "sent");
  assert.equal((after.db.prepare("SELECT status FROM deliveries WHERE key = ?").get(`uncertain-retry:${retryPostKey}`) as { status: string }).status, "sent");
});

test("aha_retry refuses every ledger state except absent for both keys", async t => {
  const dir = await home(t);
  const seeded = seedAbsentRetry(dir);
  const member = tools({ senderIsOwner: false, requesterSenderId: "mem_retry", nativeChannelId: "cht_marketing" });
  const store = openStore(dir);
  t.after(() => store.close());
  const disallowed = ["uncertain", "posted", "verified", "failed", "ready"];
  for (const state of disallowed) {
    store.db.prepare("UPDATE ledger SET state = ? WHERE key = ?").run(state, seeded.postKey);
    const result = await member.get("aha_retry")!.execute("retry", { draftId: `AHA-${seeded.itemId}` });
    assert.equal(result.isError, true, `post state ${state} must be refused`);
    assert.match(result.content[0].text, new RegExp(state));
    store.db.prepare("UPDATE ledger SET state = 'absent' WHERE key = ?").run(seeded.postKey);
  }
  for (const state of disallowed) {
    store.db.prepare("UPDATE ledger SET state = ? WHERE key = ?").run(state, seeded.threadKey);
    const result = await member.get("aha_retry")!.execute("retry", { draftId: `AHA-${seeded.itemId}` });
    assert.equal(result.isError, true, `thread state ${state} must be refused`);
    assert.match(result.content[0].text, new RegExp(state));
    store.db.prepare("UPDATE ledger SET state = 'absent' WHERE key = ?").run(seeded.threadKey);
  }
});

test("aha_retry allows only one resend for a draft", async t => {
  const redditPosts: string[] = [];
  const dir = await home(t, [], "posted", undefined, redditPosts);
  writeSecrets(dir, { reddit: "reddit-token" });
  const seeded = seedAbsentRetry(dir);
  const member = tools({ senderIsOwner: false, requesterSenderId: "mem_retry", nativeChannelId: "cht_marketing" });
  const first = await member.get("aha_retry")!.execute("retry-1", { draftId: `AHA-${seeded.itemId}` });
  assert.equal(first.isError ?? false, false);
  const second = await member.get("aha_retry")!.execute("retry-2", { draftId: `AHA-${seeded.itemId}` });
  assert.equal(second.isError, true);
  assert.match(second.content[0].text, /already used its one retry/);
  assert.equal(redditPosts.length, 1);
});

test("aha_retry refuses while PAUSE is active", async t => {
  const dir = await home(t);
  const seeded = seedAbsentRetry(dir);
  const store = openStore(dir);
  store.db.prepare("UPDATE flags SET paused = 1 WHERE id = 1").run();
  store.close();
  const member = tools({ senderIsOwner: false, requesterSenderId: "mem_retry", nativeChannelId: "cht_marketing" });
  const result = await member.get("aha_retry")!.execute("retry", { draftId: `AHA-${seeded.itemId}` });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /PAUSE is active/);
});

test("aha_retry refuses when daily or community limits are reached", async t => {
  const dir = await home(t);
  const seeded = seedAbsentRetry(dir);
  const today = new Date().toISOString().slice(0, 10);
  const store = openStore(dir);
  for (let i = 0; i < 10; i++) {
    store.db.prepare("INSERT INTO ledger (key, state, url) VALUES (?, 'posted', NULL)").run(`post:${today}:reddit:other:t3_cap${i}`);
  }
  for (let i = 0; i < 3; i++) {
    store.db.prepare("INSERT INTO ledger (key, state, url) VALUES (?, 'posted', NULL)").run(`post:${today}:reddit:test:t3_community${i}`);
  }
  store.close();
  const member = tools({ senderIsOwner: false, requesterSenderId: "mem_retry", nativeChannelId: "cht_marketing" });
  const result = await member.get("aha_retry")!.execute("retry", { draftId: `AHA-${seeded.itemId}` });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /daily posting limit reached/);
  assert.match(result.content[0].text, /community posting limit reached/);
});

test("aha_retry returns the next allowed time when the Reddit interval blocks it", async t => {
  const dir = await home(t);
  writeSecrets(dir, { reddit: "reddit-token" });
  const seeded = seedAbsentRetry(dir);
  const store = openStore(dir);
  t.after(() => store.close());
  const claimedAt = new Date(Date.now() - 5 * 60_000);
  const key = postLedgerKey(claimedAt.toISOString().slice(0, 10), "reddit", "t3_recent", "https://www.reddit.com/r/elsewhere/comments/recent/title/");
  store.db.prepare("INSERT INTO ledger (key, state, url, claimed_at) VALUES (?, 'posted', NULL, ?)").run(key, claimedAt.toISOString());
  const member = tools({ senderIsOwner: false, requesterSenderId: "mem_retry", nativeChannelId: "cht_marketing" });
  const result = await member.get("aha_retry")!.execute("retry", { draftId: `AHA-${seeded.itemId}` });
  assert.equal(result.isError, true);
  assert.deepEqual((result.details as { reasons: string[] }).reasons, ["minimum interval between Reddit posts has not elapsed"]);
  const expectedAt = new Date(claimedAt.getTime() + 10 * 60_000).toISOString();
  assert.equal((result.details as { nextAllowedAt: string }).nextAllowedAt, expectedAt);
  assert.match(result.content[0].text, /try again after/i);
  assert.equal((store.db.prepare("SELECT state FROM ledger WHERE key = ?").get(seeded.threadKey) as { state: string }).state, "absent");
});

test("aha_retry respects the rolling 24-hour total cap", async t => {
  const dir = await home(t);
  writeSecrets(dir, { reddit: "reddit-token" });
  const seeded = seedAbsentRetry(dir);
  const store = openStore(dir);
  t.after(() => store.close());
  const now = new Date();
  for (let i = 0; i < 10; i++) {
    const at = new Date(now.getTime() - 20 * 60_000);
    const key = postLedgerKey(at.toISOString().slice(0, 10), "reddit", `t3_recent${i}`, `https://www.reddit.com/r/other${i}/comments/recent/title/`);
    store.db.prepare("INSERT INTO ledger (key, state, url, claimed_at) VALUES (?, 'posted', NULL, ?)").run(key, at.toISOString());
  }
  const member = tools({ senderIsOwner: false, requesterSenderId: "mem_retry", nativeChannelId: "cht_marketing" });
  const result = await member.get("aha_retry")!.execute("retry", { draftId: `AHA-${seeded.itemId}` });
  assert.equal(result.isError, true);
  assert.deepEqual((result.details as { reasons: string[] }).reasons, ["rolling 24-hour posting limit reached"]);
  assert.equal((store.db.prepare("SELECT state FROM ledger WHERE key = ?").get(seeded.threadKey) as { state: string }).state, "absent");
});

test("aha_retry refuses when the approved body hash no longer matches", async t => {
  const dir = await home(t);
  const seeded = seedAbsentRetry(dir);
  const store = openStore(dir);
  store.db.prepare("UPDATE drafts SET approved_sha256 = ? WHERE id = ?").run("0".repeat(64), seeded.draftId);
  store.close();
  const member = tools({ senderIsOwner: false, requesterSenderId: "mem_retry", nativeChannelId: "cht_marketing" });
  const result = await member.get("aha_retry")!.execute("retry", { draftId: `AHA-${seeded.itemId}` });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /approved draft content changed/);
});

test("aha_retry does not spend the retry when Reddit cannot post", async t => {
  const dir = await home(t);
  const seeded = seedAbsentRetry(dir);
  const member = tools({ senderIsOwner: false, requesterSenderId: "mem_retry", nativeChannelId: "cht_marketing" });
  const result = await member.get("aha_retry")!.execute("retry", { draftId: `AHA-${seeded.itemId}` });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /credentials are unavailable/);
  const store = openStore(dir);
  t.after(() => store.close());
  assert.equal((store.db.prepare("SELECT state FROM ledger WHERE key = ?").get(seeded.postKey) as { state: string }).state, "absent");
  assert.equal((store.db.prepare("SELECT COUNT(*) AS n FROM draft_events WHERE draft_id = ? AND action = 'retried'").get(seeded.draftId) as { n: number }).n, 0);
});

test("the retry claim is atomic when two authorized tool calls race", async t => {
  const redditPosts: string[] = [];
  const dir = await home(t, [], "posted", undefined, redditPosts);
  writeSecrets(dir, { reddit: "reddit-token" });
  const seeded = seedAbsentRetry(dir);
  const member = tools({ senderIsOwner: false, requesterSenderId: "mem_retry", nativeChannelId: "cht_marketing" });
  const [first, second] = await Promise.all([
    member.get("aha_retry")!.execute("retry-1", { draftId: `AHA-${seeded.itemId}` }),
    member.get("aha_retry")!.execute("retry-2", { draftId: `AHA-${seeded.itemId}` }),
  ]);
  assert.equal(Number(first.isError ?? false) + Number(second.isError ?? false), 1);
  assert.equal(redditPosts.length, 1);
  const store = openStore(dir);
  t.after(() => store.close());
  assert.equal((store.db.prepare("SELECT COUNT(*) AS n FROM draft_events WHERE draft_id = ? AND action = 'retried'").get(seeded.draftId) as { n: number }).n, 1);
});

test("approval, edit, and ignore roll back when their audit event cannot be written", async t => {
  const dir = await home(t);
  const { itemId, draftId } = seed(dir);
  const store = openStore(dir);
  store.db.exec(`CREATE TRIGGER fail_draft_audit BEFORE INSERT ON draft_events
    WHEN NEW.action IN ('approved', 'edited', 'ignored')
    BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END`);
  store.close();
  const owner = tools({ senderIsOwner: true, requesterSenderId: "plow-owner", nativeChannelId: "cht_dm" });
  await assert.rejects(() => owner.get("aha_approve")!.execute("approve", { draftId: `AHA-${itemId}` }), /audit unavailable/);
  await assert.rejects(() => owner.get("aha_edit")!.execute("edit", {
    draftId: `AHA-${itemId}`, text: "A changed answer. — AHA, AI assistant of Plow",
  }), /audit unavailable/);
  await assert.rejects(() => owner.get("aha_ignore")!.execute("ignore", { draftId: `AHA-${itemId}`, reason: "not needed" }), /audit unavailable/);
  const after = openStore(dir);
  t.after(() => after.close());
  const draft = after.db.prepare("SELECT state, body FROM drafts WHERE id = ?").get(draftId) as { state: string; body: string };
  assert.equal(draft.state, "pending");
  assert.equal(draft.body, "Thanks for asking about Plow queues.\n— AHA, AI assistant of Plow");
  assert.equal((after.db.prepare("SELECT COUNT(*) AS n FROM ledger WHERE state = 'ready'").get() as { n: number }).n, 0);
  assert.equal((after.db.prepare("SELECT COUNT(*) AS n FROM draft_events WHERE item_id = ?").get(itemId) as { n: number }).n, 0);
});

test("Reddit approval reports a confirmed post as sent", async t => {
  const posts: { url: string; body: string }[] = [];
  const dir = await home(t, posts, "posted");
  writeSecrets(dir, { reddit: "reddit-token" });
  const { itemId, draftId } = seedReddit(dir);
  const owner = tools({ senderIsOwner: true, requesterSenderId: "plow-owner", nativeChannelId: "cht_dm" });
  const result = await owner.get("aha_approve")!.execute("call", { draftId: `AHA-${itemId}` });
  assert.deepEqual(result.details, { sent: true });
  assert.match(posts[0].body, /Publicado no Reddit\./);
  const store = openStore(dir);
  t.after(() => store.close());
  assert.equal((store.db.prepare("SELECT state FROM drafts WHERE id = ?").get(draftId) as { state: string }).state, "approved");
  const events = store.db.prepare("SELECT action, actor FROM draft_events WHERE item_id = ? ORDER BY id").all(itemId) as { action: string; actor: string }[];
  assert.deepEqual(events.map(event => ({ ...event })), [
    { action: "approved", actor: "plow-owner" },
    { action: "posted", actor: "system" },
    { action: "verified", actor: "system" },
  ]);
});

test("Reddit approval reports an uncertain post without claiming success", async t => {
  const posts: { url: string; body: string }[] = [];
  const dir = await home(t, posts, "uncertain");
  writeSecrets(dir, { reddit: "reddit-token" });
  const { itemId } = seedReddit(dir);
  const owner = tools({ senderIsOwner: true, requesterSenderId: "plow-owner", nativeChannelId: "cht_dm" });
  const result = await owner.get("aha_approve")!.execute("call", { draftId: `AHA-${itemId}` });
  assert.deepEqual(result.details, { sent: false, reason: "reddit post uncertain", confirmationSent: true });
  assert.match(posts.find(post => post.url.includes("/chats/cht_dm/messages") && post.body.includes("Publicação no Reddit"))!.body, /Publicação no Reddit não confirmada/);
});

test("aha_approve returns localized nextAllowedAt and leaves a rate-limited draft pending", async t => {
  const posts: { url: string; body: string }[] = [];
  const dir = await home(t, posts);
  const { itemId, draftId } = seedReddit(dir);
  const store = openStore(dir);
  t.after(() => store.close());
  saveConfig(store, {
    company: { name: "Plow", aliases: ["plow"] },
    ownerChatUid: "cht_dm", language: "pt-BR", tz: "America/Sao_Paulo",
  });
  const claimedAt = new Date(Date.now() - 5 * 60_000);
  const recentKey = postLedgerKey(claimedAt.toISOString().slice(0, 10), "reddit", "t3_other", "https://www.reddit.com/r/elsewhere/comments/recent/title/");
  store.db.prepare("INSERT INTO ledger (key, state, url, claimed_at) VALUES (?, 'posted', NULL, ?)").run(recentKey, claimedAt.toISOString());
  const owner = tools({ senderIsOwner: true, requesterSenderId: "plow-owner", nativeChannelId: "cht_dm" });
  const result = await owner.get("aha_approve")!.execute("call", { draftId: `AHA-${itemId}` });
  const details = result.details as { sent: boolean; nextAllowedAt: string; message: string };
  assert.equal(details.sent, false);
  assert.equal(details.nextAllowedAt, new Date(claimedAt.getTime() + 10 * 60_000).toISOString());
  assert.match(details.message, /Você poderá tentar novamente após/);
  assert.match(details.message, /America\/Sao_Paulo/);
  const draft = store.db.prepare("SELECT state, approved_at AS approvedAt FROM drafts WHERE id = ?").get(draftId) as { state: string; approvedAt: string | null };
  assert.deepEqual({ ...draft }, { state: "pending", approvedAt: null });
  assert.equal(posts.length, 0);
});

test("Reddit approval reports a failed post without claiming success", async t => {
  const posts: { url: string; body: string }[] = [];
  const dir = await home(t, posts);
  const { itemId } = seedReddit(dir);
  const owner = tools({ senderIsOwner: true, requesterSenderId: "plow-owner", nativeChannelId: "cht_dm" });
  const result = await owner.get("aha_approve")!.execute("call", { draftId: `AHA-${itemId}` });
  assert.deepEqual(result.details, { sent: false, reason: "reddit post failed", confirmationSent: true });
  assert.match(posts.find(post => post.url.includes("/chats/cht_dm/messages"))!.body, /Não foi possível publicar no Reddit/);
});

test("AHA-n always names the item, not a draft with the same number", async t => {
  const dir = await home(t);
  const decoy = seed(dir, { category: "praise" });
  const pad = openStore(dir);
  for (let i = 0; i < 8; i++) {
    pad.db.prepare("INSERT INTO drafts (item_id, body, state) VALUES (?, 'padding', 'expired')").run(decoy.itemId);
  }
  pad.close();
  const target = seed(dir, { category: "question" });
  assert.notEqual(target.itemId, target.draftId);
  const colliding = openStore(dir);
  const sameNumber = colliding.db.prepare("SELECT item_id AS itemId FROM drafts WHERE id = ?").get(target.itemId) as { itemId: number };
  colliding.close();
  assert.notEqual(sameNumber.itemId, target.itemId);
  const owner = tools({ senderIsOwner: true, requesterSenderId: "plow-owner", nativeChannelId: "cht_dm" });
  const result = await owner.get("aha_approve")!.execute("call", { draftId: `AHA-${target.itemId}` });
  assert.equal(result.isError ?? false, false);
  const after = openStore(dir);
  t.after(() => after.close());
  assert.equal((after.db.prepare("SELECT state FROM drafts WHERE id = ?").get(target.draftId) as { state: string }).state, "approved");
  assert.equal((after.db.prepare("SELECT state FROM drafts WHERE id = ?").get(target.itemId) as { state: string }).state, "expired");
});

test("a second approve on the same draft is rejected", async t => {
  const dir = await home(t);
  const { itemId } = seed(dir);
  const owner = tools({ senderIsOwner: true, requesterSenderId: "plow-owner", nativeChannelId: "cht_dm" });
  const first = await owner.get("aha_approve")!.execute("call", { draftId: `AHA-${itemId}` });
  const second = await owner.get("aha_approve")!.execute("call", { draftId: `AHA-${itemId}` });
  assert.deepEqual(first.details, { sent: true });
  assert.equal(second.isError, true);
});

test("the owner can approve an other item that routes to no role", async t => {
  const dir = await home(t);
  const { itemId } = seed(dir, { category: "other" });
  const owner = tools({ senderIsOwner: true, requesterSenderId: "plow-owner", nativeChannelId: "cht_dm" });
  const result = await owner.get("aha_approve")!.execute("call", { draftId: `AHA-${itemId}` });
  assert.deepEqual(result.details, { sent: true });
});

test("aha_complaint drops autonomy to L1", async t => {
  const dir = await home(t);
  const { itemId } = seed(dir, { category: "question" });
  const store = openStore(dir);
  store.db.prepare("INSERT INTO autonomy (source, category, level, streak, suggested) VALUES ('hn', 'question', 'L2', 5, 0)").run();
  store.close();
  const owner = tools({ senderIsOwner: true, requesterSenderId: "plow-owner", nativeChannelId: "cht_dm" });
  const result = await owner.get("aha_complaint")!.execute("call", { itemId: `AHA-${itemId}`, reason: "tone deaf" });
  assert.equal(result.isError ?? false, false);
  const after = openStore(dir);
  t.after(() => after.close());
  const row = after.db.prepare("SELECT level, streak FROM autonomy WHERE source = 'hn' AND category = 'question'").get() as { level: string; streak: number };
  assert.equal(row.level, "L1");
  assert.equal(row.streak, 0);
});

test("a produto member cannot approve a marketing draft", async t => {
  const dir = await home(t);
  const { itemId } = seed(dir, { category: "praise" });
  const store = openStore(dir);
  store.db.prepare("INSERT INTO people_roles (person, role) VALUES ('mem_prod', 'produto')").run();
  store.close();
  const prod = tools({ senderIsOwner: false, requesterSenderId: "mem_prod", nativeChannelId: "cht_produto" });
  const denied = await prod.get("aha_approve")!.execute("call", { draftId: `AHA-${itemId}` });
  assert.equal(denied.isError, true);
});
