import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import entry from "../plugin/index.ts";
import { saveConfig } from "../aha/config.ts";
import { checkPolicy, POLICY } from "../aha/responder/policy.ts";
import { type Draft } from "../aha/responder/drafts.ts";
import { openStore } from "../aha/store/db.ts";

for (const mode of ["full", "discovery", "tool-discovery"]) test(`${mode} exposes Plow tools without a tool-call gate`, async () => {
  const names: string[] = [];
  const hooks: string[] = [];
  entry.register({
    registrationMode: mode, registerChannel() {}, runtime: {}, logger: { info() {} },
    registerTool(factory: (context: object) => { name: string }) { names.push(factory({}).name); },
    on(name: string) { hooks.push(name); },
  });
  assert.deepEqual(names, ["plow_start_thread", "aha_setup_save", "aha_secret_set", "aha_status", "aha_backfill", "aha_digest_now", "aha_role_assign", "aha_role_groups_create", "aha_claim", "aha_ask", "aha_approve", "aha_edit", "aha_ignore", "aha_not_us", "aha_logs", "aha_pause", "aha_resume", "aha_autonomy_confirm", "aha_promise_propose", "aha_promise_confirm", "aha_promises"]);
  const manifest = JSON.parse(await readFile(new URL("../plugin/openclaw.plugin.json", import.meta.url), "utf8"));
  assert.deepEqual(manifest.contracts.tools, names);
  assert.ok(!hooks.includes("before_tool_call"));
});

test("start-thread refuses an owner's chat without an owner handle", async t => {
  let factory: ((context: object) => { name: string; execute: (id: string, args: object) => Promise<unknown> }) | undefined;
  entry.register({ registrationMode: "full", runtime: {}, registerChannel() {}, logger: { info() {} }, on() {},
    registerTool(value: typeof factory) { if (value?.({}).name === "plow_start_thread") factory = value; } });
  assert.ok(factory);
  process.env.PLOW_AGENT_TOKEN = "test-token";
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string) => { calls.push(url); return Response.json({ data: [{ uid: "home", status: "active", participants: [{ type: "agent", relationship: "self", line: { uid: "line" } }, { type: "member", role: "owner" }] }], has_more: false }); });
  const tool = factory({ config: { channels: { plow: { apiBase: "http://fixture", lineUid: "line" } } } });
  await assert.rejects(tool.execute("call", { members: ["+15550000002"], body: "Meet Friday?" }), /no owner handle/);
  assert.deepEqual(calls, ["http://fixture/v1/chats"]);
});

test("start-thread returns a tool error without config and makes no request", async t => {
  let factory: ((context: object) => { name: string; execute: (id: string, args: object) => Promise<unknown> }) | undefined;
  entry.register({ registrationMode: "full", runtime: {}, registerChannel() {}, logger: { info() {} }, on() {},
    registerTool(value: typeof factory) { if (value?.({}).name === "plow_start_thread") factory = value; } });
  assert.ok(factory);
  const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("must not request"); });
  assert.deepEqual(await factory({}).execute("call", { members: ["+15550000002"], body: "Hi" }), {
    isError: true, content: [{ type: "text", text: "Plow configuration is unavailable." }], details: {},
  });
  assert.equal(fetch.mock.callCount(), 0);
});

for (const accountId of ["chat", "email"]) for (const status of [200, 403, 503, "unserved", "inactive"] as const) test(`native send checks account reach and reports only confirmed sends: ${accountId}, ${status}`, async t => {
  let channel: { outbound: { sendText: (context: object) => Promise<unknown> } };
  entry.register({ registrationMode: "full", runtime: {}, registerTool() {}, logger: { info() {} }, on() {},
    registerChannel(value: { plugin: typeof channel }) { channel = value.plugin; } });
  process.env.PLOW_AGENT_TOKEN = "test-token";
  const posts: unknown[] = [];
  t.mock.method(globalThis, "fetch", async (_url: string, options: RequestInit) => {
    if (options.method === "POST") {
      posts.push(JSON.parse(options.body as string));
      return Response.json({ uid: "sent-message" }, { status: typeof status === "number" ? status : 200 });
    }
    return Response.json({ uid: "target", status: status === "inactive" ? "inactive" : "active", participants: [
      { type: "agent", relationship: "self", line: { uid: status === "unserved" ? "other-line" : accountId } },
    ] });
  });
  const result = channel!.outbound.sendText({ cfg: { channels: { plow: { apiBase: "http://fixture", lineUid: "chat", emailLineUid: "email" } } }, accountId, to: "target", text: "Friday at noon." });
  if (status === 200) assert.deepEqual(await result, { channel: "plow", messageId: "sent-message" });
  else await assert.rejects(result, typeof status === "string" ? /does not serve/ : status === 503 ? /delivery is unknown/ : /HTTP 403/);
  assert.deepEqual(posts, typeof status === "string" ? [] : [{ body: "Friday at noon.", attachment_uids: [] }]);
});

test("native targets preserve opaque UID case and reject names and non-chat IDs", () => {
  let channel: { messaging: { normalizeTarget: (raw: string) => string | undefined; targetResolver: { looksLikeId: (raw: string, normalized?: string) => boolean } } };
  entry.register({ registrationMode: "full", runtime: {}, registerTool() {}, logger: { info() {} }, on() {},
    registerChannel(value: { plugin: typeof channel }) { channel = value.plugin; } });
  const uid = "cht_AbCdef0123456789_-XyZqw";
  for (const target of [uid, `plow:${uid}`, `  plow:${uid}  `]) {
    const normalized = channel!.messaging.normalizeTarget(target);
    assert.equal(normalized, uid);
    assert.equal(channel!.messaging.targetResolver.looksLikeId(target, normalized), true);
  }
  for (const target of ["Joe", "+15550000001", "mem_owner", "cht_", "cht_a/b", "cht_a?b"]) {
    assert.equal(channel!.messaging.targetResolver.looksLikeId(target), false);
  }
});

test("owner-targeted delivery resolves the sentinel to the owner's phone chat", async t => {
  let channel: { outbound: { sendText: (context: object) => Promise<unknown> } };
  entry.register({ registrationMode: "full", runtime: {}, registerTool() {}, logger: { info() {} },
    registerChannel(value: { plugin: typeof channel }) { channel = value.plugin; } });
  process.env.PLOW_AGENT_TOKEN = "test-token";
  const chat = { uid: "cht_home", status: "active", participants: [
    { type: "agent", relationship: "self", line: { uid: "line" } },
    { type: "member", uid: "member", role: "owner" },
  ] };
  const urls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string) => {
    urls.push(url);
    if (url.endsWith("/chats")) return Response.json({ data: [chat], has_more: false });
    if (url.endsWith("/chats/cht_home")) return Response.json(chat);
    if (url.endsWith("/chats/cht_home/messages")) return Response.json({ uid: "delivered" });
    return new Response(null, { status: 404 });
  });
  assert.deepEqual(await channel!.outbound.sendText({ cfg: { channels: { plow: { apiBase: "http://fixture", lineUid: "line" } } },
    accountId: "chat", to: "plow-owner", text: "Reminder" }), { channel: "plow", messageId: "delivered" });
  assert.equal(urls.at(-1), "http://fixture/v1/chats/cht_home/messages");
});

test("heartbeat owner discovery identifies only the sentinel as a direct destination", () => {
  let channel: { messaging: { inferTargetChatType?: (params: { to: string }) => string | undefined } };
  entry.register({ registrationMode: "full", runtime: {}, registerTool() {}, logger: { info() {} },
    registerChannel(value: { plugin: typeof channel }) { channel = value.plugin; } });
  assert.equal(channel!.messaging.inferTargetChatType?.({ to: "plow-owner" }), "direct");
  assert.equal(channel!.messaging.inferTargetChatType?.({ to: "cht_unknown" }), undefined);
});

async function policyHome(t: import("node:test").TestContext) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aha-policy-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = openStore(dir);
  t.after(() => store.close());
  saveConfig(store, { company: { name: "Plow", aliases: ["plow"] }, links: ["https://news.ycombinator.com/item?id=1"] });
  return store;
}

  function seedItem(store: ReturnType<typeof openStore>, over: {
  body?: string;
  about?: string;
  category?: string;
  topic?: string;
  confidence?: number;
  question?: number;
  source?: string;
  externalId?: string;
  url?: string;
} = {}) {
  store.db.prepare(`INSERT INTO items (source, external_id, url, author, title, body, published_at, fetched_at, state)
    VALUES (?, ?, ?, 'a', 't', ?, '2026-09-22T00:00:00.000Z', '2026-09-22T00:00:00.000Z', 'relevant')`)
    .run(over.source ?? "hn", over.externalId ?? String(Math.random()), over.url ?? "https://news.ycombinator.com/item?id=1", over.body ?? "Does plow queue jobs?");
  const id = Number((store.db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id);
  store.db.prepare(`INSERT INTO classifications (item_id, sentiment, category, topic, language, is_question, urgency, about, confidence)
    VALUES (?, 0, ?, ?, 'en', ?, 'low', ?, ?)`)
    .run(id, over.category ?? "question", over.topic ?? "queues", over.question ?? 1, over.about ?? "self", over.confidence ?? 0.9);
  const draft: Draft = {
    id: 1,
    itemId: id,
    body: "Thanks for asking about Plow queues.\n— AHA, AI assistant of Plow",
    state: "pending",
  };
  store.db.prepare("INSERT INTO drafts (item_id, body, state) VALUES (?, ?, 'pending')").run(id, draft.body);
  draft.id = Number((store.db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id);
  return draft;
}

const now = new Date("2026-09-23T12:00:00.000Z");

test("response policy allows a mention with a valid draft", async t => {
  const store = await policyHome(t);
  const draft = seedItem(store);
  assert.deepEqual(checkPolicy(store, draft, now), { allow: true });
});

test("response policy rule 1 fails only when the company is not mentioned and nobody asked for help", async t => {
  const store = await policyHome(t);
  const draft = seedItem(store, { body: "random thread about tractors", question: 0 });
  const result = checkPolicy(store, draft, now);
  assert.equal(result.allow, false);
  if (!result.allow) assert.deepEqual(result.reasons, [POLICY.mention]);
});

test("response policy rule 2 fails only for a competitor item", async t => {
  const store = await policyHome(t);
  const draft = seedItem(store, { about: "competitor:zonk" });
  const result = checkPolicy(store, draft, now);
  assert.equal(result.allow, false);
  if (!result.allow) assert.deepEqual(result.reasons, [POLICY.competitor]);
});

test("response policy rule 3 fails only for a red-line category", async t => {
  const store = await policyHome(t);
  const draft = seedItem(store, { category: "security" });
  const result = checkPolicy(store, draft, now);
  assert.equal(result.allow, false);
  if (!result.allow) assert.deepEqual(result.reasons, [POLICY.redLine]);
  assert.equal((store.db.prepare("SELECT state FROM items WHERE id = ?").get(draft.itemId) as { state: string }).state, "escalated");
});

test("response policy rule 3 fails only for a red-line topic such as imprensa", async t => {
  const store = await policyHome(t);
  const draft = seedItem(store, { topic: "imprensa" });
  const result = checkPolicy(store, draft, now);
  assert.equal(result.allow, false);
  if (!result.allow) assert.deepEqual(result.reasons, [POLICY.redLine]);
  assert.equal((store.db.prepare("SELECT state FROM items WHERE id = ?").get(draft.itemId) as { state: string }).state, "escalated");
});

test("response policy rule 4 fails only when confidence is below 0.8", async t => {
  const store = await policyHome(t);
  const draft = seedItem(store, { confidence: 0.79 });
  const result = checkPolicy(store, draft, now);
  assert.equal(result.allow, false);
  if (!result.allow) assert.deepEqual(result.reasons, [POLICY.confidence]);
});

test("response policy rule 5 fails only when the daily reply limit is full", async t => {
  const store = await policyHome(t);
  const draft = seedItem(store, { source: "github", externalId: "g1" });
  for (let i = 0; i < 10; i++) {
    const source = i < 3 ? "hn" : i < 6 ? "producthunt" : "agent-index";
    store.db.prepare("INSERT INTO ledger (key, state, url) VALUES (?, 'ready', NULL)").run(`post:2026-09-23:${source}:${i}`);
  }
  const result = checkPolicy(store, draft, now);
  assert.equal(result.allow, false);
  if (!result.allow) assert.deepEqual(result.reasons, [POLICY.rateLimit]);
});

test("response policy rule 5 fails only when the community daily limit is full", async t => {
  const store = await policyHome(t);
  const draft = seedItem(store, { source: "hn", externalId: "fresh" });
  for (let i = 0; i < 3; i++) {
    store.db.prepare("INSERT INTO ledger (key, state, url) VALUES (?, 'ready', NULL)").run(`post:2026-09-23:hn:${i}`);
  }
  const result = checkPolicy(store, draft, now);
  assert.equal(result.allow, false);
  if (!result.allow) assert.deepEqual(result.reasons, [POLICY.rateLimit]);
});

test("response policy rule 5 fails only when the thread already has a reply", async t => {
  const store = await policyHome(t);
  const draft = seedItem(store, { source: "hn", externalId: "same-thread" });
  store.db.prepare("INSERT INTO ledger (key, state, url) VALUES (?, 'ready', NULL)").run("thread:hn:same-thread");
  const result = checkPolicy(store, draft, now);
  assert.equal(result.allow, false);
  if (!result.allow) assert.deepEqual(result.reasons, [POLICY.rateLimit]);
});

test("response policy rule 5 fails at 3 replies in the same subreddit day", async t => {
  const store = await policyHome(t);
  const draft = seedItem(store, { source: "reddit", externalId: "t1_new", url: "https://www.reddit.com/r/testaha/comments/abc/title/new/" });
  for (let i = 0; i < 3; i++) {
    store.db.prepare("INSERT INTO ledger (key, state, url) VALUES (?, 'ready', NULL)").run(`post:2026-09-23:reddit:testaha:t1_${i}`);
  }
  const result = checkPolicy(store, draft, now);
  assert.equal(result.allow, false);
  if (!result.allow) assert.deepEqual(result.reasons, [POLICY.rateLimit]);
});

test("response policy rule 6 fails only when the draft fails the validator", async t => {
  const store = await policyHome(t);
  const draft = seedItem(store);
  draft.body = "Thanks for asking about Plow. https://evil.example/steal\n— AHA, AI assistant of Plow";
  const result = checkPolicy(store, draft, now);
  assert.equal(result.allow, false);
  if (!result.allow) assert.deepEqual(result.reasons, [POLICY.validator]);
});

test("response policy rule 7 fails only when PAUSE is active", async t => {
  const store = await policyHome(t);
  const draft = seedItem(store);
  store.db.prepare("UPDATE flags SET paused = 1").run();
  const result = checkPolicy(store, draft, now);
  assert.equal(result.allow, false);
  if (!result.allow) assert.deepEqual(result.reasons, [POLICY.paused]);
});
