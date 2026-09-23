import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { saveConfig } from "../aha/config.ts";
import { sendToChat } from "../aha/notify/plow.ts";
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

async function home(t: import("node:test").TestContext, posts: { url: string; body: string }[] = []) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aha-approve-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  env(t, { AHA_HOME: dir, PLOW_API_BASE: "http://plow.test", PLOW_AGENT_TOKEN: "tok" });
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if ((init?.method ?? "GET") === "POST" && url.includes("/messages")) {
      posts.push({ url, body: String(init?.body ?? "") });
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
  assert.match(row.text, new RegExp(`^NOT US AHA-${itemId}$`));
  assert.equal(row.text.includes("Plow queues"), false);
  assert.equal((store.db.prepare("SELECT state FROM items WHERE id = ?").get(itemId) as { state: string }).state, "irrelevant");
});

test("aha_logs returns the item history without the public post body", async t => {
  const dir = await home(t);
  const { itemId } = seed(dir);
  const owner = tools({ senderIsOwner: true, requesterSenderId: "plow-owner", nativeChannelId: "cht_dm" });
  await owner.get("aha_approve")!.execute("call", { draftId: `AHA-${itemId}` });
  const result = await owner.get("aha_logs")!.execute("call", { id: `AHA-${itemId}` });
  assert.equal(result.isError ?? false, false);
  const details = result.details as { publicId: string; item: { id: number; body?: string }; drafts: { id: number; chars?: number; body?: string }[]; classification: { topic?: string } };
  assert.equal(details.publicId, `AHA-${itemId}`);
  assert.equal(details.item.id, itemId);
  assert.equal("body" in details.item, false);
  assert.equal("topic" in (details.classification ?? {}), false);
  assert.equal("body" in details.drafts[0], false);
  assert.equal(typeof details.drafts[0].chars, "number");
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

test("AHA-n always names the item, not a draft with the same number", async t => {
  const dir = await home(t);
  const decoy = seed(dir, { category: "praise" });
  const pad = openStore(dir);
  for (let i = 0; i < 8; i++) {
    pad.db.prepare("INSERT INTO drafts (item_id, body, state) VALUES (?, 'padding', 'pending')").run(decoy.itemId);
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
  assert.equal((after.db.prepare("SELECT state FROM drafts WHERE id = ?").get(target.itemId) as { state: string }).state, "pending");
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
