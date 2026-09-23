import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { saveConfig } from "../aha/config.ts";
import { checkPromises, parseDue, runPromiseChecks } from "../aha/promises/check.ts";
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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aha-promise-"));
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
  saveConfig(store, {
    company: { name: "Plow" },
    language: "pt",
    ownerChatUid: "cht_dm",
    roleChats: { engenharia: "cht_engenharia", founder: "cht_founder" },
  });
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

function mention(dir: string, over: { ext: string; published: string; topic: string; urgency?: string; category?: string }) {
  const store = openStore(dir);
  store.db.prepare(`INSERT INTO items (source, external_id, url, author, title, body, published_at, fetched_at, state)
    VALUES ('hn', ?, 'https://example.test/x', 'a', 't', 'plow', ?, ?, 'relevant')`).run(over.ext, over.published, over.published);
  const id = Number((store.db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id);
  store.db.prepare(`INSERT INTO classifications (item_id, sentiment, category, topic, language, is_question, urgency, about, confidence)
    VALUES (?, 0, ?, ?, 'en', 0, ?, 'self', 0.9)`).run(id, over.category ?? "bug", over.topic, over.urgency ?? "med");
  store.close();
  return id;
}

test("the plugin exposes promise tools", async () => {
  const names: string[] = [];
  entry.register({
    registrationMode: "full", registerChannel() {}, runtime: {}, logger: { info() {} },
    registerTool(factory: (context: object) => { name: string }) { names.push(factory({}).name); },
    on() {},
  });
  assert.ok(names.includes("aha_promise_propose"));
  assert.ok(names.includes("aha_promise_confirm"));
  assert.ok(names.includes("aha_promises"));
  const manifest = JSON.parse(await readFile(new URL("../plugin/openclaw.plugin.json", import.meta.url), "utf8"));
  assert.ok(manifest.contracts.tools.includes("aha_promise_propose"));
});

test("propose does not write a promise until the ownerUid or owner confirms", async t => {
  const dir = await home(t);
  const member = tools({ senderIsOwner: false, requesterSenderId: "mem_ana", nativeChannelId: "cht_engenharia" });
  const proposed = await member.get("aha_promise_propose")!.execute("call", {
    topic: "login", due: "2026-09-26", ownerUid: "mem_ana",
  });
  assert.equal(proposed.isError ?? false, false);
  const details = proposed.details as { proposalId: number; confirmText: string };
  assert.equal(typeof details.proposalId, "number");
  assert.match(details.confirmText, /login/);
  assert.match(details.confirmText, /2026-09-26/);
  const store = openStore(dir);
  t.after(() => store.close());
  assert.equal((store.db.prepare("SELECT COUNT(*) AS n FROM promises").get() as { n: number }).n, 0);
  const stranger = tools({ senderIsOwner: false, requesterSenderId: "mem_mkt", nativeChannelId: "cht_marketing" });
  const denied = await stranger.get("aha_promise_confirm")!.execute("call", { proposalId: details.proposalId });
  assert.equal(denied.isError, true);
  assert.equal((store.db.prepare("SELECT COUNT(*) AS n FROM promises").get() as { n: number }).n, 0);
  const confirmed = await member.get("aha_promise_confirm")!.execute("call", { proposalId: details.proposalId });
  assert.equal(confirmed.isError ?? false, false);
  assert.equal((store.db.prepare("SELECT COUNT(*) AS n FROM promises").get() as { n: number }).n, 1);
  const row = store.db.prepare("SELECT topic, due, owner, status FROM promises").get() as { topic: string; due: string; owner: string; status: string };
  assert.equal(row.topic, "login");
  assert.equal(row.owner, "mem_ana");
  assert.equal(row.status, "open");
  assert.equal(parseDue(row.due).toISOString().slice(0, 10), "2026-09-26");
});

test("the company owner can confirm a proposal they did not make", async t => {
  const dir = await home(t);
  const member = tools({ senderIsOwner: false, requesterSenderId: "mem_ana", nativeChannelId: "cht_engenharia" });
  const proposed = await member.get("aha_promise_propose")!.execute("call", {
    topic: "login", due: "2026-09-26", ownerUid: "mem_ana",
  });
  const proposalId = (proposed.details as { proposalId: number }).proposalId;
  const owner = tools({ senderIsOwner: true, requesterSenderId: "plow-owner", nativeChannelId: "cht_dm" });
  const confirmed = await owner.get("aha_promise_confirm")!.execute("call", { proposalId });
  assert.equal(confirmed.isError ?? false, false);
  const store = openStore(dir);
  t.after(() => store.close());
  assert.equal((store.db.prepare("SELECT COUNT(*) AS n FROM promises").get() as { n: number }).n, 1);
});

test("aha_promises lists confirmed promises without public post text", async t => {
  const dir = await home(t);
  mention(dir, { ext: "secret", published: "2026-09-20T00:00:00.000Z", topic: "login" });
  const owner = tools({ senderIsOwner: true, requesterSenderId: "plow-owner", nativeChannelId: "cht_dm" });
  const proposed = await owner.get("aha_promise_propose")!.execute("call", {
    topic: "login", due: "2026-09-26", ownerUid: "mem_ana",
  });
  const listedEmpty = await owner.get("aha_promises")!.execute("call", {});
  assert.deepEqual((listedEmpty.details as { promises: unknown[] }).promises, []);
  await owner.get("aha_promise_confirm")!.execute("call", { proposalId: (proposed.details as { proposalId: number }).proposalId });
  const listed = await owner.get("aha_promises")!.execute("call", {});
  const rows = (listed.details as { promises: { topic: string; owner: string; status: string }[] }).promises;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].topic, "login");
  assert.equal(rows[0].status, "open");
  assert.equal(JSON.stringify(listed.details).includes("plow"), false);
});

test("checkPromises marks a 50% drop without high urgency as resolvida", async t => {
  const dir = await home(t);
  const due = "2026-09-26";
  for (let i = 0; i < 4; i++) mention(dir, { ext: `b${i}`, published: "2026-09-22T00:00:00.000Z", topic: "login" });
  for (let i = 0; i < 2; i++) mention(dir, { ext: `a${i}`, published: "2026-09-28T00:00:00.000Z", topic: "login" });
  const store = openStore(dir);
  t.after(() => store.close());
  store.db.prepare("INSERT INTO promises (topic, due, owner, status) VALUES ('login', ?, 'mem_ana', 'open')").run(due);
  const results = checkPromises(store, new Date("2026-10-04T00:00:00.000Z"));
  assert.equal(results.length, 1);
  assert.equal(results[0].result, "resolvida");
  assert.equal(results[0].before, 4);
  assert.equal(results[0].after, 2);
  assert.equal((store.db.prepare("SELECT status FROM promises").get() as { status: string }).status, "resolvida");
});

test("checkPromises returns sem sinal when both windows have fewer than 3 items together", async t => {
  const dir = await home(t);
  mention(dir, { ext: "only", published: "2026-09-22T00:00:00.000Z", topic: "login" });
  const store = openStore(dir);
  t.after(() => store.close());
  store.db.prepare("INSERT INTO promises (topic, due, owner, status) VALUES ('login', '2026-09-26', 'mem_ana', 'open')").run();
  const results = checkPromises(store, new Date("2026-10-04T00:00:00.000Z"));
  assert.equal(results[0].result, "sem sinal");
});

test("checkPromises returns persiste when volume does not drop or a high item appears", async t => {
  const dir = await home(t);
  for (let i = 0; i < 4; i++) mention(dir, { ext: `b${i}`, published: "2026-09-22T00:00:00.000Z", topic: "login" });
  mention(dir, { ext: "a0", published: "2026-09-28T00:00:00.000Z", topic: "login" });
  mention(dir, { ext: "hot", published: "2026-09-29T00:00:00.000Z", topic: "login", urgency: "high" });
  const store = openStore(dir);
  t.after(() => store.close());
  store.db.prepare("INSERT INTO promises (topic, due, owner, status) VALUES ('login', '2026-09-26', 'mem_ana', 'open')").run();
  const results = checkPromises(store, new Date("2026-10-04T00:00:00.000Z"));
  assert.equal(results[0].result, "persiste");
  assert.equal(results[0].before, 4);
  assert.equal(results[0].after, 2);
});

test("promise results go to the role group and owner DM once each", async t => {
  const posts: { url: string; body: string }[] = [];
  const dir = await home(t, posts);
  for (let i = 0; i < 4; i++) mention(dir, { ext: `b${i}`, published: "2026-09-22T00:00:00.000Z", topic: "login", category: "bug" });
  for (let i = 0; i < 2; i++) mention(dir, { ext: `a${i}`, published: "2026-09-28T00:00:00.000Z", topic: "login", category: "bug" });
  const store = openStore(dir);
  t.after(() => store.close());
  store.db.prepare("INSERT INTO promises (topic, due, owner, status) VALUES ('login', '2026-09-26', 'mem_ana', 'open')").run();
  const now = () => new Date("2026-10-04T00:00:00.000Z");
  await runPromiseChecks(store, now(), { now, fetch: async (input, init) => {
    posts.push({ url: String(input), body: String(init?.body ?? "") });
    return Response.json({ uid: "msg" });
  } });
  await runPromiseChecks(store, now(), { now, fetch: async (input, init) => {
    posts.push({ url: String(input), body: String(init?.body ?? "") });
    return Response.json({ uid: "msg" });
  } });
  const dm = posts.filter(row => row.url.includes("/chats/cht_dm/messages"));
  const role = posts.filter(row => row.url.includes("/chats/cht_engenharia/messages"));
  assert.equal(dm.length, 1);
  assert.equal(role.length, 1);
  assert.match(dm[0].body, /resolvida/);
  assert.equal(dm[0].body.includes("plow"), false);
  assert.equal(role[0].url.includes("cht_engenharia"), true);
});
