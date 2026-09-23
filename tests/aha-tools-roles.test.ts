import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getConfig, saveConfig } from "../aha/config.ts";
import { deliverDigest } from "../aha/digest/deliver.ts";
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
const prodMember = { type: "member", uid: "mem_prod", role: "member", display_name: "Prod", provider_key: "+15550002222" };
const mktMember = { type: "member", uid: "mem_mkt", role: "member", display_name: "Mkt", provider_key: "+15550003333" };
const mkt2Member = { type: "member", uid: "mem_mkt2", role: "member", display_name: "Mkt2", provider_key: "+15550004444" };
const dm = { uid: "cht_dm", status: "active", trusted: true, participants: [self, owner] };
const team = { uid: "cht_team", status: "active", trusted: true, participants: [self, owner, prodMember, mktMember, mkt2Member] };

const environment = { ...process.env };
function env(t: import("node:test").TestContext, values: Record<string, string | undefined>) {
  t.after(() => { for (const key of Object.keys({ ...values, ...process.env })) if (key in environment) process.env[key] = environment[key]; else delete process.env[key]; });
  for (const [key, value] of Object.entries(values)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
}

async function home(t: import("node:test").TestContext, capture: { chats?: { members: string[]; body?: string }[]; messages?: { url: string; body: string }[] } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aha-roles-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  env(t, { AHA_HOME: dir, PLOW_API_BASE: "http://plow.test", PLOW_AGENT_TOKEN: "tok" });
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.endsWith("/v1/chats") && method === "GET") return Response.json({ data: [dm, team], has_more: false });
    if (url.endsWith("/v1/chats") && method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { body?: string; members?: string[] };
      capture.chats?.push({ members: body.members ?? [], body: body.body });
      const role = ["founder", "produto", "marketing", "engenharia"].find(name => body.body?.includes(name));
      return Response.json({ uid: `cht_${role ?? "group"}` });
    }
    if (method === "POST" && url.includes("/messages")) {
      capture.messages?.push({ url, body: String(init?.body ?? "") });
      return Response.json({ uid: "msg_digest" });
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
  const details = result.details as { items: { id: number; category: string; urgency: string; state: string }[]; counts: { relevant: number } };
  assert.equal(details.items.some(item => item.id === security), false);
  assert.equal(details.items.some(item => item.id === praise), true);
  assert.equal(JSON.stringify(result.details).includes("security"), false);
  assert.equal(JSON.stringify(result.details).includes("plow mention"), false);
  const row = details.items.find(item => item.id === praise)!;
  assert.deepEqual(Object.keys(row).sort(), ["category", "id", "state", "urgency"]);
  assert.equal(details.counts.relevant, 1);
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
  const claimedRow = store.db.prepare("SELECT state, assignee FROM items WHERE id = ?").get(itemId) as { state: string; assignee: string };
  assert.equal(claimedRow.state, "assigned");
  assert.equal(claimedRow.assignee, "mem_mkt");
});

test("aha_role_assign rejects unknown members and maps provider_key to uid", async t => {
  const dir = await home(t);
  const map = tools({ senderIsOwner: true, requesterSenderId: "plow-owner", nativeChannelId: "cht_dm" });
  const unknown = await map.get("aha_role_assign")!.execute("call", { memberUid: "not-a-member", role: "produto" });
  assert.equal(unknown.isError, true);
  const mapped = await map.get("aha_role_assign")!.execute("call", { memberUid: "+15550002222", role: "produto" });
  assert.equal(mapped.isError ?? false, false);
  assert.deepEqual(mapped.details, { memberUid: "mem_prod", role: "produto" });
  const store = openStore(dir);
  t.after(() => store.close());
  const row = store.db.prepare("SELECT person FROM people_roles WHERE role = 'produto'").get() as { person: string };
  assert.equal(row.person, "mem_prod");
});

test("role group creation includes assigned members as provider keys", async t => {
  const chats: { members: string[]; body?: string }[] = [];
  await home(t, { chats });
  const map = tools({ senderIsOwner: true, requesterSenderId: "plow-owner", nativeChannelId: "cht_dm" });
  await map.get("aha_role_assign")!.execute("call", { memberUid: "mem_prod", role: "produto" });
  await map.get("aha_role_assign")!.execute("call", { memberUid: "mem_mkt", role: "marketing" });
  const result = await map.get("aha_role_groups_create")!.execute("call", {});
  assert.equal(result.isError ?? false, false);
  const produto = chats.find(row => row.body?.includes("produto"));
  const founder = chats.find(row => row.body?.includes("founder"));
  assert.deepEqual(produto?.members, ["+15550001111", "+15550002222"]);
  assert.deepEqual(founder?.members, ["+15550001111"]);
});

test("the owner can claim without a people_roles row", async t => {
  const dir = await home(t);
  const ownerMap = tools({ senderIsOwner: true, requesterSenderId: "plow-owner", nativeChannelId: "cht_dm" });
  const itemId = insertItem(dir, { category: "praise" });
  const claimed = await ownerMap.get("aha_claim")!.execute("call", { itemId });
  assert.equal(claimed.isError ?? false, false);
  const store = openStore(dir);
  t.after(() => store.close());
  assert.equal((store.db.prepare("SELECT assignee FROM items WHERE id = ?").get(itemId) as { assignee: string }).assignee, "plow-owner");
});

test("a second claim on the same item is rejected", async t => {
  const dir = await home(t);
  const ownerMap = tools({ senderIsOwner: true, requesterSenderId: "plow-owner", nativeChannelId: "cht_dm" });
  await ownerMap.get("aha_role_assign")!.execute("call", { memberUid: "mem_mkt", role: "marketing" });
  await ownerMap.get("aha_role_assign")!.execute("call", { memberUid: "mem_mkt2", role: "marketing" });
  const itemId = insertItem(dir, { category: "praise" });
  const first = await tools({ senderIsOwner: false, requesterSenderId: "mem_mkt", nativeChannelId: "cht_marketing" })
    .get("aha_claim")!.execute("call", { itemId });
  const second = await tools({ senderIsOwner: false, requesterSenderId: "mem_mkt2", nativeChannelId: "cht_marketing" })
    .get("aha_claim")!.execute("call", { itemId });
  assert.equal(first.isError ?? false, false);
  assert.equal(second.isError, true);
  const store = openStore(dir);
  t.after(() => store.close());
  assert.equal((store.db.prepare("SELECT assignee FROM items WHERE id = ?").get(itemId) as { assignee: string }).assignee, "mem_mkt");
});

test("deliverDigest sends each role slice to its group with a separate key", async t => {
  const messages: { url: string; body: string }[] = [];
  const dir = await home(t, { messages });
  const ownerMap = tools({ senderIsOwner: true, requesterSenderId: "plow-owner", nativeChannelId: "cht_dm" });
  await ownerMap.get("aha_role_groups_create")!.execute("call", {});
  const store = openStore(dir);
  t.after(() => store.close());
  saveConfig(store, { ...getConfig(store)!, ownerChatUid: "cht_dm" });
  insertItem(dir, { category: "praise" });
  insertItem(dir, { category: "bug", urgency: "low" });
  insertItem(dir, { category: "pricing" });
  const until = new Date("2026-09-22T20:00:00.000Z");
  assert.equal(await deliverDigest(store, { now: () => until }), "sent");
  assert.equal(messages.some(row => row.url.includes("/chats/cht_dm/messages") && row.body.includes("(founder)")), true);
  assert.equal(messages.some(row => row.url.includes("/chats/cht_marketing/messages") && row.body.includes("(marketing)")), true);
  assert.equal(messages.some(row => row.url.includes("/chats/cht_engenharia/messages") && row.body.includes("(engenharia)")), true);
  const keys = (store.db.prepare("SELECT key FROM deliveries ORDER BY key").all() as { key: string }[]).map(row => row.key);
  assert.deepEqual(keys, [
    "digest:2026-09-22:engenharia",
    "digest:2026-09-22:founder",
    "digest:2026-09-22:marketing",
    "digest:2026-09-22:produto",
  ]);
});
