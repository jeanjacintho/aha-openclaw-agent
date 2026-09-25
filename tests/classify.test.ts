import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { saveConfig } from "../aha/config.ts";
import { classifyBatch, MAX_CLASSIFY_ATTEMPTS, type ItemRow } from "../aha/pipeline/classify.ts";
import { classifyNewItems } from "../aha/digest/deliver.ts";
import { classificationSchema } from "../aha/llm/schemas.ts";
import { openStore } from "../aha/store/db.ts";

const environment = { ...process.env };
function env(t: import("node:test").TestContext, values: Record<string, string | undefined>) {
  t.after(() => { for (const key of Object.keys({ ...values, ...process.env })) if (key in environment) process.env[key] = environment[key]; else delete process.env[key]; });
  for (const [key, value] of Object.entries(values)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
}

async function home(t: import("node:test").TestContext) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aha-classify-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  env(t, { AHA_HOME: dir, PLOW_API_BASE: "http://llm.test", PLOW_AGENT_TOKEN: "tok" });
  const store = openStore(dir);
  t.after(() => store.close());
  saveConfig(store, { company: { name: "Plow" }, competitors: ["zonk"] });
  return store;
}

function valid(over: Record<string, unknown> = {}) {
  return {
    relevant: true,
    confidence: 0.9,
    about: "self",
    sentiment: 0.2,
    category: "question",
    topic: "queues",
    lang: "en",
    isQuestion: true,
    urgency: "low",
    reason: "asks about plow queues",
    ...over,
  };
}

function insert(store: ReturnType<typeof openStore>, over: { externalId?: string; body?: string } = {}) {
  store.db.prepare(`INSERT INTO items (source, external_id, url, author, title, body, published_at, fetched_at, state)
    VALUES ('hn', ?, 'https://news.ycombinator.com/item?id=1', 'alice', 'Plow?', ?, '2026-09-22T00:00:00.000Z', '2026-09-22T00:00:00.000Z', 'new')`)
    .run(over.externalId ?? "1", over.body ?? "Does plow queue jobs?");
  return store.db.prepare("SELECT * FROM items WHERE id = last_insert_rowid()").get() as ItemRow;
}

function chatFetch(content: unknown): typeof fetch {
  return async () => new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify(content) } }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

test("schema rejects a category outside the list and confidence outside 0..1", () => {
  assert.throws(() => classificationSchema.parse(valid({ category: "rant" })), /category/);
  assert.throws(() => classificationSchema.parse(valid({ confidence: 1.2 })), /confidence/);
  assert.throws(() => classificationSchema.parse(valid({ confidence: -0.01 })), /confidence/);
  assert.throws(() => classificationSchema.parse(valid({ topic: "evil.example/steal" })), /topic/);
  assert.throws(() => classificationSchema.parse(valid({ topic: "---" })), /topic/);
  assert.throws(() => classificationSchema.parse(valid({ topic: "_" })), /topic/);
  assert.deepEqual(classificationSchema.parse(valid({ relevant: false, about: null, isQuestion: false, reason: "idiom" })), valid({ relevant: false, about: "self", isQuestion: false, reason: "idiom" }));
  assert.deepEqual(classificationSchema.parse(valid()), valid());
});

test("an invalid classified item goes to needs_review", async t => {
  const store = await home(t);
  const item = insert(store);
  const report = await classifyBatch(store, [item], {
    complete: async () => ({ ok: true, value: { results: [{ id: item.id, category: "rant" }] } }),
  });
  assert.equal(report.needsReview, 1);
  assert.equal(report.classified, 0);
  assert.equal((store.db.prepare("SELECT state FROM items WHERE id = ?").get(item.id) as { state: string }).state, "needs_review");
  assert.equal((store.db.prepare("SELECT COUNT(*) AS n FROM classifications").get() as { n: number }).n, 0);
});

test("one invalid item in a batch does not send the rest to needs_review", async t => {
  const store = await home(t);
  const good = insert(store, { externalId: "1" });
  const bad = insert(store, { externalId: "2", body: "also plow" });
  const report = await classifyBatch(store, [good, bad], {
    fetch: chatFetch({
      results: [
        { id: good.id, ...valid() },
        { id: bad.id, ...valid({ category: "rant" }) },
      ],
    }),
  });
  assert.equal(report.classified, 1);
  assert.equal(report.needsReview, 1);
  assert.equal((store.db.prepare("SELECT state FROM items WHERE id = ?").get(good.id) as { state: string }).state, "relevant");
  assert.equal((store.db.prepare("SELECT state FROM items WHERE id = ?").get(bad.id) as { state: string }).state, "needs_review");
});

test("a punctuation-only topic goes to needs_review and later items in the batch still save", async t => {
  const store = await home(t);
  const empty = insert(store, { externalId: "1" });
  const good = insert(store, { externalId: "2", body: "also plow" });
  const report = await classifyBatch(store, [empty, good], {
    fetch: chatFetch({
      results: [
        { id: empty.id, ...valid({ topic: "---" }) },
        { id: good.id, ...valid() },
      ],
    }),
  });
  assert.equal(report.needsReview, 1);
  assert.equal(report.classified, 1);
  assert.equal((store.db.prepare("SELECT state FROM items WHERE id = ?").get(empty.id) as { state: string }).state, "needs_review");
  assert.equal((store.db.prepare("SELECT state FROM items WHERE id = ?").get(good.id) as { state: string }).state, "relevant");
  assert.equal((store.db.prepare("SELECT COUNT(*) AS n FROM items WHERE state = 'new'").get() as { n: number }).n, 0);
});

test("an unknown competitor about value goes to needs_review", async t => {
  const store = await home(t);
  const item = insert(store);
  const report = await classifyBatch(store, [item], {
    fetch: chatFetch({ results: [{ id: item.id, ...valid({ about: "competitor:anything-injected" }) }] }),
  });
  assert.equal(report.needsReview, 1);
  assert.equal(report.classified, 0);
});

test("feedback_examples enter the classification prompt", async t => {
  const store = await home(t);
  const item = insert(store);
  store.db.prepare("INSERT INTO feedback_examples (item_id, kind, text) VALUES (?, ?, ?)").run(item.id, "negative", "NOT US AHA-123 snow plow");
  let prompt = "";
  await classifyBatch(store, [item], {
    complete: async req => {
      prompt = `${req.system}\n${JSON.stringify(req.data)}`;
      return { ok: true, value: { results: [{ id: item.id, ...valid() }] } };
    },
  });
  assert.match(prompt, /NOT US AHA-123 snow plow/);
  assert.equal((store.db.prepare("SELECT state FROM items WHERE id = ?").get(item.id) as { state: string }).state, "relevant");
  const row = store.db.prepare("SELECT category, confidence, about FROM classifications WHERE item_id = ?").get(item.id) as { category: string; confidence: number; about: string };
  assert.equal(row.category, "question");
  assert.equal(row.confidence, 0.9);
  assert.equal(row.about, "self");
});

test("classifyBatch sends at most 20 items", async t => {
  const store = await home(t);
  const items: ItemRow[] = [];
  for (let i = 0; i < 21; i++) {
    items.push(insert(store, { externalId: String(i) }));
  }
  let sent = 0;
  await classifyBatch(store, items, {
    complete: async req => {
      const data = req.data as { posts: { id: number }[] };
      sent = data.posts.length;
      return { ok: true, value: { results: data.posts.map(p => ({ id: p.id, ...valid() })) } };
    },
  });
  assert.equal(sent, 20);
});

test("a null or empty topic falls back to the category instead of rejecting the item", () => {
  assert.deepEqual(classificationSchema.parse(valid({ relevant: false, category: "other", topic: null })), valid({ relevant: false, category: "other", topic: "other" }));
  assert.deepEqual(classificationSchema.parse(valid({ topic: "  " })), valid({ topic: "question" }));
  assert.deepEqual(classificationSchema.parse(valid({ topic: undefined })), valid({ topic: "question" }));
});

test("a batch where the model leaves every topic null is still classified", async t => {
  const store = await home(t);
  const noise = insert(store, { externalId: "1", body: "just plow through it" });
  const mention = insert(store, { externalId: "2", body: "I use Plow for my agents" });
  const report = await classifyBatch(store, [noise, mention], {
    fetch: chatFetch({
      results: [
        { id: noise.id, ...valid({ relevant: false, category: "other", topic: null }) },
        { id: mention.id, ...valid({ category: "praise", topic: null }) },
      ],
    }),
  });
  assert.deepEqual(report, { classified: 2, needsReview: 0 });
  const states = store.db.prepare("SELECT state FROM items ORDER BY id").all() as { state: string }[];
  assert.deepEqual(states.map(row => row.state), ["irrelevant", "relevant"]);
  const topics = store.db.prepare("SELECT topic FROM classifications ORDER BY item_id").all() as { topic: string }[];
  assert.deepEqual(topics.map(row => row.topic), ["other", "praise"]);
});

function itemRow(store: ReturnType<typeof openStore>, id: number) {
  return store.db.prepare("SELECT state, classify_attempts FROM items WHERE id = ?").get(id) as { state: string; classify_attempts: number };
}

test("a failed item is retried on later passes and recovers once the model answers", async t => {
  const store = await home(t);
  const item = insert(store);
  let answer: unknown = { results: [{ id: item.id, category: "rant" }] };
  const deps = { complete: async () => ({ ok: true as const, value: answer as { results: { id: number }[] } }) };
  await classifyNewItems(store, deps);
  assert.deepEqual({ ...itemRow(store, item.id) }, { state: "needs_review", classify_attempts: 1 });
  answer = { results: [{ id: item.id, ...valid() }] };
  await classifyNewItems(store, deps);
  assert.equal(itemRow(store, item.id).state, "relevant");
  assert.equal((store.db.prepare("SELECT COUNT(*) AS n FROM classifications").get() as { n: number }).n, 1);
});

test("an item that keeps failing stops being retried after the attempt limit", async t => {
  const store = await home(t);
  const item = insert(store);
  let calls = 0;
  const deps = {
    complete: async () => {
      calls += 1;
      return { ok: false as const, reason: "http 503" };
    },
  };
  for (let i = 0; i < MAX_CLASSIFY_ATTEMPTS + 2; i += 1) await classifyNewItems(store, deps);
  assert.equal(calls, MAX_CLASSIFY_ATTEMPTS);
  assert.deepEqual({ ...itemRow(store, item.id) }, { state: "needs_review", classify_attempts: MAX_CLASSIFY_ATTEMPTS });
});
