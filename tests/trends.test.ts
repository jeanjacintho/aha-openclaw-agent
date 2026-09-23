import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { saveConfig } from "../aha/config.ts";
import { buildDigest } from "../aha/digest/build.ts";
import { renderDigest } from "../aha/digest/render.ts";
import { assignTopic } from "../aha/pipeline/topics.ts";
import { detectTrends, trendSentence, weeklyCounts } from "../aha/pipeline/trends.ts";
import { openStore, type Store } from "../aha/store/db.ts";

async function home(t: import("node:test").TestContext) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aha-trends-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = openStore(dir);
  t.after(() => store.close());
  saveConfig(store, { company: { name: "Plow" } });
  return store;
}

function run(store: Store, source: string, start: string, end: string, status: string) {
  store.db.prepare("INSERT INTO source_runs (source, window_start, window_end, status, detail) VALUES (?, ?, ?, ?, NULL)").run(source, start, end, status);
}

function mention(store: Store, over: { source?: string; ext: string; published: string; topic: string; state?: string; about?: string }) {
  store.db.prepare(`INSERT INTO items (source, external_id, url, author, title, body, published_at, fetched_at, state)
    VALUES (?, ?, 'https://example.test/x', 'a', 't', 'plow', ?, ?, ?)`).run(
    over.source ?? "hn", over.ext, over.published, over.published, over.state ?? "relevant",
  );
  const id = Number((store.db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id);
  store.db.prepare(`INSERT INTO classifications (item_id, sentiment, category, topic, language, is_question, urgency, about, confidence)
    VALUES (?, 0, 'bug', ?, 'en', 0, 'med', ?, 0.9)`).run(id, over.topic, over.about ?? "self");
  return id;
}

// ISO weeks around 2026-09-23 (Wed): W38 is 2026-09-14..20, W39 is 2026-09-21..27.
const W36 = { start: "2026-08-31T00:00:00.000Z", mid: "2026-09-02T12:00:00.000Z", end: "2026-09-07T00:00:00.000Z" };
const W37 = { start: "2026-09-07T00:00:00.000Z", mid: "2026-09-09T12:00:00.000Z", end: "2026-09-14T00:00:00.000Z" };
const W38 = { start: "2026-09-14T00:00:00.000Z", mid: "2026-09-16T12:00:00.000Z", end: "2026-09-21T00:00:00.000Z" };
const W39 = { start: "2026-09-21T00:00:00.000Z", mid: "2026-09-23T12:00:00.000Z", end: "2026-09-28T00:00:00.000Z" };

function cover(store: Store, weeks: { start: string; end: string }[], sources = ["hn", "ph"]) {
  for (const week of weeks) {
    for (const source of sources) run(store, source, week.start, week.end, "ok");
  }
}

test("a week with a source down is unknown, not zero", async t => {
  const store = await home(t);
  const topicId = assignTopic(store, "Login bug");
  cover(store, [W36, W37, W38]);
  run(store, "hn", W39.start, W39.end, "ok");
  run(store, "ph", W39.start, W39.end, "error");
  mention(store, { ext: "1", published: W38.mid, topic: "Login bug" });
  const rows = weeklyCounts(store, topicId, 4, new Date(W39.mid));
  assert.equal(rows.length, 4);
  const current = rows[rows.length - 1];
  assert.equal(current.week, "2026-W39");
  assert.equal(current.count, null);
  const prior = rows[rows.length - 2];
  assert.equal(prior.week, "2026-W38");
  assert.equal(prior.count, 1);
});

test("trend alert needs current week >= 3 and >= 2x the mean of known prior weeks", async t => {
  const store = await home(t);
  assignTopic(store, "Login bug");
  cover(store, [W36, W37, W38, W39]);
  for (let i = 0; i < 2; i++) mention(store, { ext: `a${i}`, published: W36.mid, topic: "Login bug" });
  for (let i = 0; i < 2; i++) mention(store, { ext: `b${i}`, published: W37.mid, topic: "Login bug" });
  for (let i = 0; i < 2; i++) mention(store, { ext: `c${i}`, published: W38.mid, topic: "Login bug" });
  for (let i = 0; i < 3; i++) mention(store, { ext: `now${i}`, published: W39.mid, topic: "Login bug", source: "hn" });
  const now = new Date(W39.mid);
  assert.equal(detectTrends(store, now).length, 0, "3 is not 2x a mean of 2");
  mention(store, { ext: "now3", published: W39.mid, topic: "Login bug", source: "ph" });
  const alerts = detectTrends(store, now);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].current, 4);
  assert.equal(alerts[0].average, 2);
  const sentence = trendSentence(alerts[0], "pt");
  assert.match(sentence, /Login bug/);
  assert.match(sentence, /4 menções nesta semana/);
  assert.match(sentence, /HN 3/);
  assert.match(sentence, /PH 1/);
});

test("null prior weeks are omitted from the mean, not treated as zero", async t => {
  const store = await home(t);
  assignTopic(store, "Login bug");
  cover(store, [W36, W38, W39]);
  run(store, "hn", W37.start, W37.end, "ok");
  run(store, "ph", W37.start, W37.end, "limitada");
  for (let i = 0; i < 2; i++) mention(store, { ext: `a${i}`, published: W36.mid, topic: "Login bug" });
  mention(store, { ext: "ghost", published: W37.mid, topic: "Login bug" });
  for (let i = 0; i < 2; i++) mention(store, { ext: `c${i}`, published: W38.mid, topic: "Login bug" });
  for (let i = 0; i < 5; i++) mention(store, { ext: `n${i}`, published: W39.mid, topic: "Login bug", source: i < 3 ? "hn" : "ph" });
  const alerts = detectTrends(store, new Date(W39.mid));
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].average, 2, "mean of W36=2 and W38=2; W37 null is skipped");
  assert.equal(alerts[0].current, 5);
});

test("digest includes the store-backed trend sentence", async t => {
  const store = await home(t);
  assignTopic(store, "Login bug");
  cover(store, [W36, W37, W38, W39]);
  for (let i = 0; i < 2; i++) mention(store, { ext: `a${i}`, published: W36.mid, topic: "Login bug" });
  for (let i = 0; i < 2; i++) mention(store, { ext: `b${i}`, published: W37.mid, topic: "Login bug" });
  for (let i = 0; i < 2; i++) mention(store, { ext: `c${i}`, published: W38.mid, topic: "Login bug" });
  for (let i = 0; i < 4; i++) mention(store, { ext: `n${i}`, published: W39.mid, topic: "Login bug", source: i < 3 ? "hn" : "ph" });
  const model = buildDigest(store, "founder", new Date(W39.mid));
  assert.ok(model.trends.length >= 1);
  const text = renderDigest(model, "pt");
  assert.match(text, /Login bug/);
  assert.match(text, /4 menções nesta semana/);
  assert.match(text, /HN 3/);
  assert.match(text, /PH 1/);
});

test("irrelevant and competitor items do not count toward a trend", async t => {
  const store = await home(t);
  assignTopic(store, "Login bug");
  cover(store, [W36, W37, W38, W39]);
  for (let i = 0; i < 2; i++) mention(store, { ext: `a${i}`, published: W36.mid, topic: "Login bug" });
  for (let i = 0; i < 2; i++) mention(store, { ext: `b${i}`, published: W37.mid, topic: "Login bug" });
  for (let i = 0; i < 2; i++) mention(store, { ext: `c${i}`, published: W38.mid, topic: "Login bug" });
  for (let i = 0; i < 4; i++) mention(store, { ext: `snow${i}`, published: W39.mid, topic: "Login bug", state: "irrelevant" });
  mention(store, { ext: "comp", published: W39.mid, topic: "Login bug", about: "competitor:zonk" });
  const now = new Date(W39.mid);
  assert.equal(detectTrends(store, now).length, 0);
  for (let i = 0; i < 4; i++) mention(store, { ext: `real${i}`, published: W39.mid, topic: "Login bug", source: i < 3 ? "hn" : "ph" });
  const alerts = detectTrends(store, now);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].current, 4);
  assert.deepEqual(alerts[0].bySource, [{ source: "hn", count: 3 }, { source: "ph", count: 1 }]);
});

test("current week of 2 does not alert even when it is 2x a 0.5 mean", async t => {
  const store = await home(t);
  assignTopic(store, "Login bug");
  cover(store, [W36, W37, W39]);
  run(store, "hn", W38.start, W38.end, "ok");
  run(store, "ph", W38.start, W38.end, "error");
  mention(store, { ext: "a0", published: W36.mid, topic: "Login bug" });
  const now = new Date(W39.mid);
  assert.equal(weeklyCounts(store, assignTopic(store, "Login bug"), 4, now).find(row => row.week === "2026-W37")?.count, 0);
  mention(store, { ext: "n0", published: W39.mid, topic: "Login bug" });
  mention(store, { ext: "n1", published: W39.mid, topic: "Login bug" });
  const rows = weeklyCounts(store, assignTopic(store, "Login bug"), 4, now);
  assert.equal(rows.find(row => row.week === "2026-W38")?.count, null);
  const known = rows.slice(0, -1).map(row => row.count).filter((n): n is number => n != null);
  assert.equal(known.reduce((sum, n) => sum + n, 0) / known.length, 0.5);
  assert.equal(rows[rows.length - 1].count, 2);
  assert.equal(detectTrends(store, now).length, 0);
});

test("a source seen in the lookback with no ok run that week makes the week unknown", async t => {
  const store = await home(t);
  const topicId = assignTopic(store, "Login bug");
  cover(store, [W36, W37, W39]);
  run(store, "hn", W38.start, W38.end, "ok");
  mention(store, { ext: "1", published: W38.mid, topic: "Login bug" });
  const rows = weeklyCounts(store, topicId, 4, new Date(W39.mid));
  assert.equal(rows.find(row => row.week === "2026-W38")?.count, null);
});
