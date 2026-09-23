import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { saveConfig } from "../aha/config.ts";
import { buildDigest } from "../aha/digest/build.ts";
import { routeItem } from "../aha/pipeline/route.ts";
import { openStore } from "../aha/store/db.ts";

test("a high-urgency bug routes to engenharia and founder", () => {
  assert.deepEqual(routeItem({ category: "bug", urgency: "high" }), ["engenharia", "founder"]);
});

test("a pricing question routes only to founder", () => {
  assert.deepEqual(routeItem({ category: "pricing", urgency: "med" }), ["founder"]);
  assert.deepEqual(routeItem({ category: "question", urgency: "med" }), ["marketing"]);
});

test("a low-urgency bug routes only to engenharia", () => {
  assert.deepEqual(routeItem({ category: "bug", urgency: "low" }), ["engenharia"]);
});

test("a high-urgency security item routes to engenharia and founder", () => {
  assert.deepEqual(routeItem({ category: "security", urgency: "high" }), ["engenharia", "founder"]);
});

test("feature requests and comparisons route to produto", () => {
  assert.deepEqual(routeItem({ category: "feature_request" }), ["produto"]);
  assert.deepEqual(routeItem({ category: "comparison" }), ["produto"]);
});

test("other is not in spec §7 so it routes nowhere", () => {
  assert.deepEqual(routeItem({ category: "other" }), []);
});

test("an unclaimed item older than 24h appears in the founder digest", async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aha-route-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = openStore(dir);
  t.after(() => store.close());
  saveConfig(store, { company: { name: "Plow" } });
  const until = new Date("2026-09-22T20:00:00.000Z");
  store.db.prepare(`INSERT INTO items (source, external_id, url, author, title, body, published_at, fetched_at, state)
    VALUES ('hn', 'stale', 'https://example.test/s', 'a', 't', 'login still broken', '2026-09-21T08:00:00.000Z', '2026-09-21T10:00:00.000Z', 'relevant')`).run();
  const id = Number((store.db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id);
  store.db.prepare(`INSERT INTO classifications (item_id, sentiment, category, topic, language, is_question, urgency, about, confidence)
    VALUES (?, 0, 'complaint', 'login', 'en', 0, 'med', 'self', 0.9)`).run(id);
  const founder = buildDigest(store, "founder", until);
  assert.equal(founder.items.length, 1);
  assert.equal(founder.items[0].id, id);
  const marketing = buildDigest(store, "marketing", until);
  assert.equal(marketing.items.length, 0);
});

test("an unclaimed founder-routed item from 24h-48h appears in the founder digest", async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aha-route-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = openStore(dir);
  t.after(() => store.close());
  saveConfig(store, { company: { name: "Plow" } });
  const until = new Date("2026-09-22T20:00:00.000Z");
  store.db.prepare(`INSERT INTO items (source, external_id, url, author, title, body, published_at, fetched_at, state)
    VALUES ('hn', 'price-stale', 'https://example.test/p', 'a', 't', 'pricing thread', '2026-09-21T10:00:00.000Z', '2026-09-21T14:00:00.000Z', 'relevant')`).run();
  const id = Number((store.db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id);
  store.db.prepare(`INSERT INTO classifications (item_id, sentiment, category, topic, language, is_question, urgency, about, confidence)
    VALUES (?, 0, 'pricing', 'preço', 'en', 0, 'high', 'self', 0.9)`).run(id);
  const founder = buildDigest(store, "founder", until);
  assert.equal(founder.items.map(item => item.id).includes(id), true);
});

test("stale unclaimed items older than 48h do not crowd out today's founder item", async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aha-route-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = openStore(dir);
  t.after(() => store.close());
  saveConfig(store, { company: { name: "Plow" } });
  const until = new Date("2026-09-22T20:00:00.000Z");
  for (let i = 0; i < 8; i++) {
    store.db.prepare(`INSERT INTO items (source, external_id, url, author, title, body, published_at, fetched_at, state)
      VALUES ('hn', ?, 'https://example.test/old', 'a', 't', 'old praise', '2026-08-01T10:00:00.000Z', '2026-08-01T12:00:00.000Z', 'relevant')`).run(`old-${i}`);
    const id = Number((store.db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id);
    store.db.prepare(`INSERT INTO classifications (item_id, sentiment, category, topic, language, is_question, urgency, about, confidence)
      VALUES (?, 0, 'praise', 'old', 'en', 0, 'low', 'self', 0.9)`).run(id);
  }
  store.db.prepare(`INSERT INTO items (source, external_id, url, author, title, body, published_at, fetched_at, state)
    VALUES ('hn', 'today-legal', 'https://example.test/n', 'a', 't', 'legal today', '2026-09-22T10:00:00.000Z', '2026-09-22T12:00:00.000Z', 'relevant')`).run();
  const today = Number((store.db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id);
  store.db.prepare(`INSERT INTO classifications (item_id, sentiment, category, topic, language, is_question, urgency, about, confidence)
    VALUES (?, 0, 'legal', 'contrato', 'en', 0, 'high', 'self', 0.9)`).run(today);
  const founder = buildDigest(store, "founder", until);
  assert.equal(founder.items.length, 1);
  assert.equal(founder.items[0].id, today);
});
