import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { saveConfig } from "../aha/config.ts";
import { buildDigest, competitorSummary, isCompetitionDigestDay } from "../aha/digest/build.ts";
import { renderDigest } from "../aha/digest/render.ts";
import { itemAutonomy } from "../aha/responder/autonomy.ts";
import { openStore } from "../aha/store/db.ts";

async function home(t: import("node:test").TestContext) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aha-comp-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = openStore(dir);
  t.after(() => store.close());
  saveConfig(store, { company: { name: "Plow" }, competitors: ["zonk", "acme"] });
  return store;
}

function insertItem(store: ReturnType<typeof openStore>, over: {
  id?: number; state?: string; fetched?: string; published?: string;
}) {
  store.db.prepare(`INSERT INTO items (source, external_id, url, author, title, body, published_at, fetched_at, state)
    VALUES ('ph', ?, 'https://www.producthunt.com/posts/x', 'a', 't', 'body', ?, ?, ?)`).run(
    String(over.id ?? Math.random()),
    over.published ?? "2026-09-22T10:00:00.000Z",
    over.fetched ?? "2026-09-22T12:00:00.000Z",
    over.state ?? "relevant",
  );
  return Number((store.db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id);
}

function classify(store: ReturnType<typeof openStore>, itemId: number, over: { category: string; about: string; topic: string }) {
  store.db.prepare(`INSERT INTO classifications (item_id, sentiment, category, topic, language, is_question, urgency, about, confidence)
    VALUES (?, 0, ?, ?, 'en', 0, 'low', ?, 0.9)`).run(itemId, over.category, over.topic, over.about);
}

const monday = new Date("2026-09-28T20:00:00.000Z");
const tuesday = new Date("2026-09-22T20:00:00.000Z");

test("competitor about is always L0", async t => {
  const store = await home(t);
  assert.equal(itemAutonomy(store, "competitor:zonk", "reddit", "question"), "L0");
  assert.equal(itemAutonomy(store, "self", "reddit", "question"), "L1");
  assert.equal(itemAutonomy(store, null, "reddit", "question"), "L1");
});

test("competition digest only renders on Monday", () => {
  assert.equal(isCompetitionDigestDay(monday, "UTC"), true);
  assert.equal(isCompetitionDigestDay(tuesday, "UTC"), false);
});

test("weekly competitor summary uses store counts in three blocks", async t => {
  const store = await home(t);
  classify(store, insertItem(store, { id: 1 }), { category: "praise", about: "competitor:zonk", topic: "onboarding" });
  classify(store, insertItem(store, { id: 2 }), { category: "comparison", about: "competitor:zonk", topic: "onboarding" });
  classify(store, insertItem(store, { id: 3 }), { category: "complaint", about: "competitor:zonk", topic: "pricing" });
  classify(store, insertItem(store, { id: 4 }), { category: "bug", about: "competitor:zonk", topic: "login" });
  classify(store, insertItem(store, { id: 5 }), { category: "complaint", about: "competitor:acme", topic: "docs" });
  classify(store, insertItem(store, { id: 6 }), { category: "praise", about: "self", topic: "login" });
  store.db.prepare("INSERT INTO promises (topic, due, owner, status) VALUES ('login', '2026-09-20', 'Ana', 'resolvida')").run();
  const summary = competitorSummary(store, monday);
  assert.deepEqual(summary.theyWin, [{ competitor: "zonk", topic: "onboarding", n: 2 }]);
  assert.deepEqual(summary.theyComplain, [
    { competitor: "acme", topic: "docs", n: 1 },
    { competitor: "zonk", topic: "login", n: 1 },
    { competitor: "zonk", topic: "pricing", n: 1 },
  ]);
  assert.deepEqual(summary.weSolved, ["login"]);
  const text = renderDigest(buildDigest(store, "founder", monday), "pt");
  assert.match(text, /eles ganham em: zonk onboarding \(2\)/);
  assert.match(text, /eles reclamam de: acme docs \(1\), zonk login \(1\), zonk pricing \(1\)/);
  assert.match(text, /nós já resolvemos: login \(promessa resolvida\)/);
  assert.equal(buildDigest(store, "founder", tuesday).competitors, undefined);
  assert.equal(buildDigest(store, "engenharia", monday).competitors, undefined);
});

test("competitor summary ignores irrelevant and needs_review items", async t => {
  const store = await home(t);
  classify(store, insertItem(store, { id: 1, state: "relevant" }), { category: "complaint", about: "competitor:zonk", topic: "onboarding" });
  classify(store, insertItem(store, { id: 2, state: "irrelevant" }), { category: "complaint", about: "competitor:zonk", topic: "onboarding" });
  classify(store, insertItem(store, { id: 3, state: "needs_review" }), { category: "complaint", about: "competitor:zonk", topic: "onboarding" });
  const summary = competitorSummary(store, monday);
  assert.deepEqual(summary.theyComplain, [{ competitor: "zonk", topic: "onboarding", n: 1 }]);
});

test("we already solved requires a resolvida promise, not self praise", async t => {
  const store = await home(t);
  classify(store, insertItem(store, { id: 1 }), { category: "complaint", about: "competitor:zonk", topic: "onboarding" });
  classify(store, insertItem(store, { id: 2 }), { category: "praise", about: "self", topic: "onboarding" });
  assert.deepEqual(competitorSummary(store, monday).weSolved, []);
  store.db.prepare("INSERT INTO promises (topic, due, owner, status) VALUES ('onboarding', '2026-09-20', 'Ana', 'resolvida')").run();
  assert.deepEqual(competitorSummary(store, monday).weSolved, ["onboarding"]);
});

test("competitor summary uses published_at, not fetched_at", async t => {
  const store = await home(t);
  classify(store, insertItem(store, {
    id: 1,
    published: "2026-08-01T10:00:00.000Z",
    fetched: "2026-09-27T12:00:00.000Z",
  }), { category: "complaint", about: "competitor:zonk", topic: "onboarding" });
  assert.deepEqual(competitorSummary(store, monday).theyComplain, []);
});
