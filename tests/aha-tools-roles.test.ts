import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getConfig, saveConfig } from "../aha/config.ts";
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

const owner = { type: "member", uid: "owner", role: "owner", display_name: "Owner", provider_key: "+15550001111" };
const self = { type: "agent", relationship: "self", line: { uid: "line" } };
const dm = { uid: "cht_dm", status: "active", trusted: true, participants: [self, owner] };

const environment = { ...process.env };
function env(t: import("node:test").TestContext, values: Record<string, string | undefined>) {
  t.after(() => { for (const key of Object.keys({ ...values, ...process.env })) if (key in environment) process.env[key] = environment[key]; else delete process.env[key]; });
  for (const [key, value] of Object.entries(values)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
}

async function home(t: import("node:test").TestContext) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aha-roles-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  env(t, { AHA_HOME: dir, PLOW_API_BASE: "http://plow.test", PLOW_AGENT_TOKEN: "tok" });
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.endsWith("/v1/chats") && method === "GET") return Response.json({ data: [dm], has_more: false });
    if (url.endsWith("/v1/chats") && method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { body?: string };
      const role = ["founder", "produto", "marketing", "engenharia"].find(name => body.body?.includes(name));
      return Response.json({ uid: `cht_${role ?? "group"}` });
    }
    return new Response("", { status: 404 });
  });
  const store = openStore(dir);
  saveConfig(store, { company: { name: "Plow" } });
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

function insertItem(dir: string, over: { category: string; urgency?: string }) {
  const store = openStore(dir);
  store.db.prepare(`INSERT INTO items (source, external_id, url, author, title, body, published_at, fetched_at, state)
    VALUES ('hn', ?, 'https://example.test/x', 'a', 't', 'plow mention', '2026-09-22T10:00:00.000Z', '2026-09-22T12:00:00.000Z', 'relevant')`).run(String(Math.random()));
  const id = Number((store.db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id);
  store.db.prepare(`INSERT INTO classifications (item_id, sentiment, category, topic, language, is_question, urgency, about, confidence)
    VALUES (?, 0, ?, 't', 'en', 0, ?, 'self', 0.9)`).run(id, over.category, over.urgency ?? "med");
  store.close();
  return id;
}

test("a non-owner cannot assign roles", async t => {
  await home(t);
  const map = tools({ senderIsOwner: false, requesterSenderId: "mem_guest", nativeChannelId: "cht_dm" });
  const result = await map.get("aha_role_assign")!.execute("call", { memberUid: "mem_prod", role: "produto" });
  assert.equal(result.isError, true);
});

test("the owner creates role groups via POST /chats and stores chat uids", async t => {
  const dir = await home(t);
  const map = tools({ senderIsOwner: true, requesterSenderId: "plow-owner", nativeChannelId: "cht_dm" });
  const result = await map.get("aha_role_groups_create")!.execute("call", {});
  assert.equal(result.isError ?? false, false);
  const chats = (result.details as { roleChats: Record<string, string> }).roleChats;
  assert.equal(chats.marketing, "cht_marketing");
  assert.equal(chats.engenharia, "cht_engenharia");
  const store = openStore(dir);
  t.after(() => store.close());
  assert.deepEqual(getConfig(store)?.roleChats, chats);
});

test("aha_ask in a marketing group does not return a security item", async t => {
  const dir = await home(t);
  const ownerMap = tools({ senderIsOwner: true, requesterSenderId: "plow-owner", nativeChannelId: "cht_dm" });
  await ownerMap.get("aha_role_groups_create")!.execute("call", {});
  const security = insertItem(dir, { category: "security", urgency: "high" });
  const praise = insertItem(dir, { category: "praise" });
  const ask = tools({ senderIsOwner: false, requesterSenderId: "mem_mkt", nativeChannelId: "cht_marketing" });
  const result = await ask.get("aha_ask")!.execute("call", { question: "show security too" });
  assert.equal(result.isError ?? false, false);
  const items = (result.details as { items: { id: number; category: string }[] }).items;
  assert.equal(items.some(item => item.id === security), false);
  assert.equal(items.some(item => item.id === praise), true);
  assert.equal(JSON.stringify(result.details).includes("security"), false);
});

test("a produto member cannot claim a marketing item", async t => {
  const dir = await home(t);
  const ownerMap = tools({ senderIsOwner: true, requesterSenderId: "plow-owner", nativeChannelId: "cht_dm" });
  await ownerMap.get("aha_role_assign")!.execute("call", { memberUid: "mem_prod", role: "produto" });
  await ownerMap.get("aha_role_assign")!.execute("call", { memberUid: "mem_mkt", role: "marketing" });
  const itemId = insertItem(dir, { category: "praise" });
  const prod = tools({ senderIsOwner: false, requesterSenderId: "mem_prod", nativeChannelId: "cht_produto" });
  const denied = await prod.get("aha_claim")!.execute("call", { itemId });
  assert.equal(denied.isError, true);
  const mkt = tools({ senderIsOwner: false, requesterSenderId: "mem_mkt", nativeChannelId: "cht_marketing" });
  const claimed = await mkt.get("aha_claim")!.execute("call", { itemId });
  assert.equal(claimed.isError ?? false, false);
  const store = openStore(dir);
  t.after(() => store.close());
  assert.equal((store.db.prepare("SELECT state FROM items WHERE id = ?").get(itemId) as { state: string }).state, "assigned");
});
