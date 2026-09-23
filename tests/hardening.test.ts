import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { saveConfig } from "../aha/config.ts";
import { classifyNewItems } from "../aha/digest/deliver.ts";
import { draftAndNotify, draftReply } from "../aha/responder/drafts.ts";
import { runIngest } from "../aha/pipeline/ingest.ts";
import { openStore } from "../aha/store/db.ts";
import { RETENTION_DAYS, forgetByUrlOrAuthor, pruneExpired } from "../aha/store/retention.ts";
import { recordUsage } from "../aha/usage/ledger.ts";
import { classifyAllowed, DEFAULT_DAILY_TOKEN_BUDGET, llmAllowed } from "../aha/usage/budget.ts";
import entry from "../plugin/index.ts";
import { type SourceAdapter } from "../aha/sources/types.ts";

const environment = { ...process.env };
function env(t: import("node:test").TestContext, values: Record<string, string | undefined>) {
  t.after(() => { for (const key of Object.keys({ ...values, ...process.env })) if (key in environment) process.env[key] = environment[key]; else delete process.env[key]; });
  for (const [key, value] of Object.entries(values)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
}

async function home(t: import("node:test").TestContext) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aha-hard-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  env(t, { AHA_HOME: dir, PLOW_API_BASE: "http://plow.test", PLOW_AGENT_TOKEN: "tok", AHA_TOKEN_BUDGET: "10" });
  const store = openStore(dir);
  t.after(() => store.close());
  saveConfig(store, { company: { name: "Plow", aliases: ["plow"] }, ownerChatUid: "cht_dm", language: "en" });
  return store;
}

function insertItem(store: ReturnType<typeof openStore>, over: { fetched?: string; author?: string; url?: string; externalId?: string; state?: string } = {}) {
  store.db.prepare(`INSERT INTO items (source, external_id, url, author, title, body, published_at, fetched_at, state)
    VALUES ('hn', ?, ?, ?, 't', 'Does plow queue jobs?', ?, ?, ?)`)
    .run(
      over.externalId ?? String(Math.random()),
      over.url ?? "https://news.ycombinator.com/item?id=1",
      over.author ?? "alice",
      over.fetched ?? "2026-09-22T12:00:00.000Z",
      over.fetched ?? "2026-09-22T12:00:00.000Z",
      over.state ?? "new",
    );
  return Number((store.db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id);
}

test("classification stops at 100% of the daily token budget and ingest still runs", async t => {
  const store = await home(t);
  insertItem(store);
  recordUsage({ at: new Date("2026-09-23T10:00:00.000Z"), model: "z-ai/glm-5.2", input: 8, output: 2, purpose: "classify" });
  assert.equal(classifyAllowed(store, new Date("2026-09-23T12:00:00.000Z")), false);
  let called = 0;
  await classifyNewItems(store, {
    now: () => new Date("2026-09-23T12:00:00.000Z"),
    complete: async () => {
      called += 1;
      return { ok: true, value: { results: [] } };
    },
    fetch: async () => Response.json({ uid: "msg" }),
  });
  assert.equal(called, 0);
  assert.equal((store.db.prepare("SELECT state FROM items WHERE id = 1").get() as { state: string }).state, "new");
  const adapter: SourceAdapter = {
    id: "hn",
    enabled: () => true,
    async fetch() {
      return {
        ok: true,
        items: [{ source: "hn", externalId: "99", url: "https://news.ycombinator.com/item?id=99", author: "b", body: "plow still collected", publishedAt: "2026-09-23T11:00:00.000Z" }],
        nextCursor: null,
      };
    },
  };
  const report = await runIngest(store, [adapter], new Date("2026-09-23T12:00:00.000Z"));
  assert.equal(report.sources[0].stored, 1);
});

test("the owner is warned once at 80% of the token budget", async t => {
  const store = await home(t);
  insertItem(store);
  recordUsage({ at: new Date("2026-09-23T10:00:00.000Z"), model: "z-ai/glm-5.2", input: 6, output: 2, purpose: "draft" });
  const posts: string[] = [];
  await classifyNewItems(store, {
    now: () => new Date("2026-09-23T12:00:00.000Z"),
    complete: async () => ({ ok: true, value: { results: [] } }),
    fetch: async (input, init) => {
      if (String(input).includes("/messages")) {
        posts.push(String(init?.body ?? ""));
        return Response.json({ uid: "msg" });
      }
      return new Response("", { status: 404 });
    },
  });
  assert.equal(posts.filter(body => body.includes("Token budget at")).length, 1);
  await classifyNewItems(store, {
    now: () => new Date("2026-09-23T12:00:00.000Z"),
    complete: async () => ({ ok: true, value: { results: [] } }),
    fetch: async (input, init) => {
      if (String(input).includes("/messages")) {
        posts.push(String(init?.body ?? ""));
        return Response.json({ uid: "msg" });
      }
      return new Response("", { status: 404 });
    },
  });
  assert.equal(posts.filter(body => body.includes("Token budget at")).length, 1);
});

test("the owner is warned separately at 100% of the token budget", async t => {
  const store = await home(t);
  insertItem(store);
  recordUsage({ at: new Date("2026-09-23T10:00:00.000Z"), model: "z-ai/glm-5.2", input: 8, output: 2, purpose: "classify" });
  const posts: string[] = [];
  await classifyNewItems(store, {
    now: () => new Date("2026-09-23T12:00:00.000Z"),
    complete: async () => ({ ok: true, value: { results: [] } }),
    fetch: async (input, init) => {
      if (String(input).includes("/messages")) {
        posts.push(String(init?.body ?? ""));
        return Response.json({ uid: "msg" });
      }
      return new Response("", { status: 404 });
    },
  });
  assert.equal(posts.filter(body => body.includes("Token budget at")).length, 1);
  assert.equal(posts.filter(body => body.includes("Token budget exhausted (100%)")).length, 1);
});

test("the default daily token budget is two million tokens", () => {
  assert.equal(DEFAULT_DAILY_TOKEN_BUDGET, 2_000_000);
});

test("draftReply and draftAndNotify stop calling the LLM at 100% of the token budget", async t => {
  const store = await home(t);
  saveConfig(store, { company: { name: "Plow", aliases: ["plow"] }, ownerChatUid: "cht_dm", language: "en", links: ["https://plow.example/docs"] });
  const itemId = insertItem(store, { state: "relevant" });
  store.db.prepare(`INSERT INTO classifications (item_id, sentiment, category, topic, language, is_question, urgency, about, confidence)
    VALUES (?, 0, 'question', 'queues', 'en', 1, 'low', 'self', 0.9)`).run(itemId);
  recordUsage({ at: new Date("2026-09-23T10:00:00.000Z"), model: "z-ai/glm-5.2", input: 8, output: 2, purpose: "classify" });
  assert.equal(llmAllowed(store, new Date("2026-09-23T12:00:00.000Z")), false);
  let called = 0;
  await assert.rejects(
    () => draftReply(store, itemId, {
      now: () => new Date("2026-09-23T12:00:00.000Z"),
      complete: async () => {
        called += 1;
        return { ok: true, value: { body: "Thanks for asking about queues." } };
      },
    }),
    /token budget exhausted/,
  );
  await draftAndNotify(store, {
    now: () => new Date("2026-09-23T12:00:00.000Z"),
    complete: async () => {
      called += 1;
      return { ok: true, value: { body: "Thanks for asking about queues." } };
    },
  });
  assert.equal(called, 0);
  assert.equal((store.db.prepare("SELECT COUNT(*) AS n FROM drafts").get() as { n: number }).n, 0);
});

test("items older than 90 days are pruned unless they have a pending draft or are assigned or escalated", async t => {
  const store = await home(t);
  const oldId = insertItem(store, { fetched: "2026-06-01T00:00:00.000Z", externalId: "old" });
  store.db.prepare(`INSERT INTO classifications (item_id, sentiment, category, topic, language, is_question, urgency, about, confidence)
    VALUES (?, 0, 'question', 'queues', 'en', 1, 'low', 'self', 0.9)`).run(oldId);
  const assignedId = insertItem(store, { fetched: "2026-06-01T00:00:00.000Z", externalId: "assigned", state: "assigned" });
  store.db.prepare(`INSERT INTO classifications (item_id, sentiment, category, topic, language, is_question, urgency, about, confidence)
    VALUES (?, 0, 'question', 'queues', 'en', 1, 'low', 'self', 0.9)`).run(assignedId);
  const pendingId = insertItem(store, { fetched: "2026-06-01T00:00:00.000Z", externalId: "pending", state: "relevant" });
  store.db.prepare(`INSERT INTO classifications (item_id, sentiment, category, topic, language, is_question, urgency, about, confidence)
    VALUES (?, 0, 'question', 'queues', 'en', 1, 'low', 'self', 0.9)`).run(pendingId);
  store.db.prepare("INSERT INTO drafts (item_id, body, state) VALUES (?, ?, 'pending')").run(pendingId, "Rascunho AHA pending");
  const kept = insertItem(store, { fetched: "2026-09-20T00:00:00.000Z", externalId: "new" });
  const removed = pruneExpired(store, new Date("2026-09-23T00:00:00.000Z"));
  assert.equal(removed, 3);
  assert.equal(RETENTION_DAYS, 90);
  assert.equal(store.db.prepare("SELECT id FROM items WHERE id = ?").get(oldId), undefined);
  assert.ok(store.db.prepare("SELECT id FROM items WHERE id = ?").get(kept));
  const assigned = store.db.prepare("SELECT id, state, body, title, author FROM items WHERE id = ?").get(assignedId) as {
    id: number; state: string; body: string; title: string; author: string;
  };
  assert.equal(assigned.state, "assigned");
  assert.equal(assigned.body, "");
  assert.equal(assigned.title, "");
  assert.equal(assigned.author, "");
  const classification = store.db.prepare("SELECT topic, category FROM classifications WHERE item_id = ?").get(assignedId) as {
    topic: string; category: string;
  };
  assert.equal(classification.topic, "queues");
  assert.equal(classification.category, "question");
  const pending = store.db.prepare("SELECT id, state, body FROM items WHERE id = ?").get(pendingId) as { id: number; state: string; body: string };
  assert.equal(pending.state, "relevant");
  assert.equal(pending.body, "");
  assert.equal((store.db.prepare("SELECT body, state FROM drafts WHERE item_id = ?").get(pendingId) as { body: string; state: string }).body, "");
  assert.equal((store.db.prepare("SELECT body, state FROM drafts WHERE item_id = ?").get(pendingId) as { body: string; state: string }).state, "pending");
});

test("forget by url or author removes that post", async t => {
  const store = await home(t);
  const byUrl = insertItem(store, { url: "https://news.ycombinator.com/item?id=77", externalId: "77" });
  const byAuthor = insertItem(store, { author: "mallory", url: "https://news.ycombinator.com/item?id=78", externalId: "78" });
  const other = insertItem(store, { author: "bob", url: "https://news.ycombinator.com/item?id=79", externalId: "79" });
  assert.equal(forgetByUrlOrAuthor(store, "https://news.ycombinator.com/item?id=77"), 1);
  assert.equal(forgetByUrlOrAuthor(store, "mallory"), 1);
  assert.equal(store.db.prepare("SELECT id FROM items WHERE id = ?").get(byUrl), undefined);
  assert.equal(store.db.prepare("SELECT id FROM items WHERE id = ?").get(byAuthor), undefined);
  assert.ok(store.db.prepare("SELECT id FROM items WHERE id = ?").get(other));
});

test("forget normalizes URLs and authors, overwrites deleted bytes, and writes an audit row", async t => {
  const store = await home(t);
  const slash = insertItem(store, { url: "https://news.ycombinator.com/item?id=77/", externalId: "77" });
  const ph = insertItem(store, { url: "https://www.producthunt.com/posts/plow#comment-9", externalId: "ph" });
  const cased = insertItem(store, { author: "Mallory", url: "https://news.ycombinator.com/item?id=78", externalId: "78" });
  const other = insertItem(store, { author: "bob", url: "https://news.ycombinator.com/item?id=79", externalId: "79" });
  assert.equal((store.db.prepare("PRAGMA secure_delete").get() as { secure_delete: number }).secure_delete, 1, "secure_delete");
  assert.equal(forgetByUrlOrAuthor(store, "http://news.ycombinator.com/item?id=77", { actor: "plow-owner", at: new Date("2026-09-23T12:00:00.000Z") }), 1, "hn trailing slash");
  assert.equal(forgetByUrlOrAuthor(store, "https://producthunt.com/posts/plow", { actor: "plow-owner" }), 1, "ph fragment");
  assert.equal(forgetByUrlOrAuthor(store, "MALLORY", { actor: "plow-owner" }), 1, "author case");
  assert.equal(store.db.prepare("SELECT id FROM items WHERE id = ?").get(slash), undefined);
  assert.equal(store.db.prepare("SELECT id FROM items WHERE id = ?").get(ph), undefined);
  assert.equal(store.db.prepare("SELECT id FROM items WHERE id = ?").get(cased), undefined);
  assert.ok(store.db.prepare("SELECT id FROM items WHERE id = ?").get(other));
  const audits = store.db.prepare("SELECT target_hash, at, actor, deleted FROM forget_audit ORDER BY id").all() as {
    target_hash: string; at: string; actor: string; deleted: number;
  }[];
  assert.equal(audits.length, 3);
  assert.equal(audits[0].actor, "plow-owner");
  assert.equal(audits[0].deleted, 1);
  assert.equal(audits[0].at, "2026-09-23T12:00:00.000Z");
  assert.match(audits[0].target_hash, /^[a-f0-9]{64}$/);
  const blob = JSON.stringify(audits);
  assert.equal(blob.includes("mallory"), false);
  assert.equal(blob.includes("producthunt.com"), false);
  assert.equal(blob.includes("news.ycombinator.com"), false);
});

test("aha_forget is owner-only", async t => {
  await home(t);
  const byName = new Map<string, { execute: (id: string, args: object) => Promise<{ isError?: boolean }> }>();
  entry.register({
    registrationMode: "full",
    runtime: {},
    logger: { info() {} },
    on() {},
    registerChannel() {},
    registerTool(factory: (context: object) => { name: string; execute: (id: string, args: object) => Promise<{ isError?: boolean }> }) {
      const tool = factory({ senderIsOwner: false, requesterSenderId: "mem", nativeChannelId: "cht_x", config: { channels: { plow: { apiBase: "http://plow.test", lineUid: "line" } } } });
      byName.set(tool.name, tool);
    },
  });
  const result = await byName.get("aha_forget")!.execute("call", { urlOrAuthor: "alice" });
  assert.equal(result.isError, true);
});

test("a killed ingest cycle does not duplicate or drop items on restart", async t => {
  const store = await home(t);
  let calls = 0;
  const adapter: SourceAdapter = {
    id: "hn",
    enabled: () => true,
    async fetch(_query, cursor) {
      calls += 1;
      if (calls === 1) {
        return {
          ok: true,
          items: [{ source: "hn", externalId: "a", url: "https://news.ycombinator.com/item?id=a", author: "a", body: "plow one", publishedAt: "2026-09-23T10:00:00.000Z" }],
          nextCursor: "page-2",
        };
      }
      if (calls === 2) throw new Error("killed");
      return {
        ok: true,
        items: [
          { source: "hn", externalId: "a", url: "https://news.ycombinator.com/item?id=a", author: "a", body: "plow one", publishedAt: "2026-09-23T10:00:00.000Z" },
          { source: "hn", externalId: "b", url: "https://news.ycombinator.com/item?id=b", author: "b", body: "plow two", publishedAt: "2026-09-23T10:01:00.000Z" },
        ],
        nextCursor: null,
      };
    },
  };
  await runIngest(store, [adapter], new Date("2026-09-23T12:00:00.000Z"));
  assert.equal((store.db.prepare("SELECT COUNT(*) AS n FROM items").get() as { n: number }).n, 1);
  await runIngest(store, [adapter], new Date("2026-09-23T12:00:00.000Z"));
  const ids = store.db.prepare("SELECT external_id AS id FROM items ORDER BY id").all() as { id: string }[];
  assert.deepEqual(ids.map(row => row.id), ["a", "b"]);
});

test("compose.yml keeps agent state on a named volume", async () => {
  const text = await fs.readFile(new URL("../compose.yml", import.meta.url), "utf8");
  assert.match(text, /state:\/var\/lib\/plow/);
  assert.match(text, /^volumes:\n {2}state:/m);
});
