import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { saveConfig } from "../aha/config.ts";
import { classifyBatch, type ItemRow } from "../aha/pipeline/classify.ts";
import { classificationSchema } from "../aha/llm/schemas.ts";
import { openStore } from "../aha/store/db.ts";

async function home(t: import("node:test").TestContext) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aha-classify-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
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

function insert(store: ReturnType<typeof openStore>, body = "Does plow queue jobs?") {
  store.db.prepare(`INSERT INTO items (source, external_id, url, author, title, body, published_at, fetched_at, state)
    VALUES ('hn', '1', 'https://news.ycombinator.com/item?id=1', 'alice', 'Plow?', ?, '2026-09-22T00:00:00.000Z', '2026-09-22T00:00:00.000Z', 'new')`).run(body);
  return store.db.prepare("SELECT * FROM items WHERE id = last_insert_rowid()").get() as ItemRow;
}

test("schema rejects a category outside the list and confidence outside 0..1", () => {
  assert.throws(() => classificationSchema.parse(valid({ category: "rant" })), /category/);
  assert.throws(() => classificationSchema.parse(valid({ confidence: 1.2 })), /confidence/);
  assert.throws(() => classificationSchema.parse(valid({ confidence: -0.01 })), /confidence/);
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
    store.db.prepare(`INSERT INTO items (source, external_id, url, author, title, body, published_at, fetched_at, state)
      VALUES ('hn', ?, 'https://news.ycombinator.com/item?id=1', 'a', 't', 'plow', '2026-09-22T00:00:00.000Z', '2026-09-22T00:00:00.000Z', 'new')`).run(String(i));
    items.push(store.db.prepare("SELECT * FROM items WHERE id = last_insert_rowid()").get() as ItemRow);
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
