import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { saveConfig } from "../aha/config.ts";
import { buildDigest } from "../aha/digest/build.ts";
import { renderDigest } from "../aha/digest/render.ts";
import { openStore } from "../aha/store/db.ts";

async function home(t: import("node:test").TestContext) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aha-digest-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = openStore(dir);
  t.after(() => store.close());
  saveConfig(store, { company: { name: "Plow" } });
  return store;
}

function insertItem(store: ReturnType<typeof openStore>, over: { id?: number; state?: string; body?: string; fetched?: string }) {
  store.db.prepare(`INSERT INTO items (source, external_id, url, author, title, body, published_at, fetched_at, state)
    VALUES ('hn', ?, 'https://news.ycombinator.com/item?id=1', 'a', 't', ?, '2026-09-22T10:00:00.000Z', ?, ?)`).run(
    String(over.id ?? Math.random()), over.body ?? "plow mention", over.fetched ?? "2026-09-22T12:00:00.000Z", over.state ?? "relevant",
  );
  return Number((store.db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id);
}

function classify(store: ReturnType<typeof openStore>, itemId: number, over: { category?: string; urgency?: string; topic?: string } = {}) {
  store.db.prepare(`INSERT INTO classifications (item_id, sentiment, category, topic, language, is_question, urgency, about, confidence)
    VALUES (?, 0, ?, ?, 'en', 0, ?, 'self', 0.9)`).run(itemId, over.category ?? "question", over.topic ?? "queues", over.urgency ?? "low");
}

test("a day with no relevant items renders one line with the store count", async t => {
  const store = await home(t);
  insertItem(store, { state: "irrelevant" });
  insertItem(store, { state: "irrelevant", id: 2 });
  const model = buildDigest(store, "founder", "2026-09-22");
  assert.equal(model.readCount, 2);
  assert.equal(model.items.length, 0);
  const text = renderDigest(model, "pt");
  assert.equal(text.split("\n").length, 1);
  assert.equal(text, "Nada que mude decisão hoje. 2 menções lidas.");
});

test("digest keeps at most 7 items and uses store numbers", async t => {
  const store = await home(t);
  for (let i = 0; i < 8; i++) {
    const id = insertItem(store, { id: i, body: `item ${i}` });
    classify(store, id, { category: "bug", urgency: i === 0 ? "high" : "med", topic: `t${i}` });
  }
  insertItem(store, { id: 99, state: "irrelevant" });
  const model = buildDigest(store, "engenharia", "2026-09-22");
  assert.equal(model.readCount, 9);
  assert.equal(model.items.length, 7);
  const text = renderDigest(model, "pt");
  assert.match(text, /9 menções lidas/);
  assert.equal(text.split("\n").filter(line => line.startsWith("•")).length, 7);
});

test("a failed source appears as sem dados desde", async t => {
  const store = await home(t);
  store.db.prepare("INSERT INTO source_runs (source, window_start, window_end, status, detail) VALUES ('hn', '2026-09-22T00:00:00.000Z', '2026-09-22T14:00:00.000Z', 'limitada', 'rate_limited')").run();
  const model = buildDigest(store, "founder", "2026-09-22");
  const text = renderDigest(model, "pt");
  assert.match(text, /HN sem dados desde 2026-09-22 14:00:00 UTC \(limite da API\)/);
});
