import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { saveConfig } from "../aha/config.ts";
import { buildDigest, excerpt } from "../aha/digest/build.ts";
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

function insertItem(store: ReturnType<typeof openStore>, over: { id?: number; state?: string; body?: string; fetched?: string; url?: string }) {
  store.db.prepare(`INSERT INTO items (source, external_id, url, author, title, body, published_at, fetched_at, state)
    VALUES ('hn', ?, ?, 'a', 't', ?, '2026-09-22T10:00:00.000Z', ?, ?)`).run(
    String(over.id ?? Math.random()), over.url ?? "https://news.ycombinator.com/item?id=1", over.body ?? "plow mention", over.fetched ?? "2026-09-22T12:00:00.000Z", over.state ?? "relevant",
  );
  return Number((store.db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id);
}

function classify(store: ReturnType<typeof openStore>, itemId: number, over: { category?: string; urgency?: string; topic?: string } = {}) {
  store.db.prepare(`INSERT INTO classifications (item_id, sentiment, category, topic, language, is_question, urgency, about, confidence)
    VALUES (?, 0, ?, ?, 'en', 0, ?, 'self', 0.9)`).run(itemId, over.category ?? "question", over.topic ?? "queues", over.urgency ?? "low");
}

const until = new Date("2026-09-22T20:00:00.000Z");

test("a window with no relevant items renders one line with the store count", async t => {
  const store = await home(t);
  insertItem(store, { state: "irrelevant" });
  insertItem(store, { state: "irrelevant", id: 2 });
  const model = buildDigest(store, "founder", until);
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
  const model = buildDigest(store, "engenharia", until);
  assert.equal(model.readCount, 9);
  assert.equal(model.items.length, 7);
  const text = renderDigest(model, "pt");
  assert.match(text, /9 menções lidas/);
  assert.equal(text.split("\n").filter(line => line.startsWith("•")).length, 7);
});

test("the 24h window includes yesterday UTC when the local digest hour is still today", async t => {
  const store = await home(t);
  const included = insertItem(store, { id: 1, fetched: "2026-09-22T18:00:00.000Z", body: "in window" });
  classify(store, included, { category: "pricing", urgency: "med", topic: "preço" });
  const excluded = insertItem(store, { id: 2, fetched: "2026-09-20T11:00:00.000Z", body: "too old" });
  classify(store, excluded, { category: "pricing", urgency: "med", topic: "antigo" });
  const localUntil = new Date("2026-09-23T12:00:00.000Z");
  const model = buildDigest(store, "founder", localUntil, "America/Sao_Paulo");
  assert.equal(model.day, "2026-09-23");
  assert.equal(model.readCount, 1);
  assert.equal(model.items.length, 1);
  assert.equal(model.items[0].topic, "preço");
});

test("excerpt strips markdown links, URLs and www hosts", () => {
  const text = excerpt("see [fix here](https://evil.example/x) or www.evil.example thanks");
  assert.equal(text.includes("evil.example"), false);
  assert.equal(text.includes("http"), false);
  assert.match(text, /\[link\].*\[link\]/);
});

test("a never-ok source appears as sem dados without a timestamp", async t => {
  const store = await home(t);
  store.db.prepare("INSERT INTO source_runs (source, window_start, window_end, status, detail) VALUES ('hn', '2026-09-22T00:00:00.000Z', '2026-09-22T14:00:00.000Z', 'limitada', 'rate_limited')").run();
  const model = buildDigest(store, "founder", until);
  const text = renderDigest(model, "pt");
  assert.match(text, /HN sem dados \(limite da API\)/);
  assert.equal(text.includes("desde"), false);
});

test("source health uses the last ok window_end after later failures", async t => {
  const store = await home(t);
  store.db.prepare("INSERT INTO source_runs (source, window_start, window_end, status, detail) VALUES ('hn', '2026-09-20T13:00:00.000Z', '2026-09-20T14:00:00.000Z', 'ok', NULL)").run();
  store.db.prepare("INSERT INTO source_runs (source, window_start, window_end, status, detail) VALUES ('hn', '2026-09-22T10:00:00.000Z', '2026-09-22T10:15:00.000Z', 'limitada', 'rate_limited')").run();
  store.db.prepare("INSERT INTO source_runs (source, window_start, window_end, status, detail) VALUES ('hn', '2026-09-22T13:45:00.000Z', '2026-09-22T14:00:00.000Z', 'limitada', 'rate_limited')").run();
  const model = buildDigest(store, "founder", until);
  const text = renderDigest(model, "pt");
  assert.match(text, /HN sem dados desde 2026-09-20 14:00:00 UTC \(limite da API\)/);
});

test("digest bullets include the item id for claims", async t => {
  const store = await home(t);
  const id = insertItem(store, { body: "claim me" });
  classify(store, id, { category: "pricing", urgency: "high", topic: "preço" });
  const text = renderDigest(buildDigest(store, "founder", until), "pt");
  assert.match(text, new RegExp(`\\[AHA-${id}\\]`));
});

test("an escalated red-line item still appears in the routed digest", async t => {
  const store = await home(t);
  const id = insertItem(store, { state: "escalated", body: "security report" });
  classify(store, id, { category: "security", urgency: "high", topic: "auth" });
  const engenharia = buildDigest(store, "engenharia", until);
  assert.equal(engenharia.items.some(item => item.id === id), true);
  const marketing = buildDigest(store, "marketing", until);
  assert.equal(marketing.items.some(item => item.id === id), false);
});
