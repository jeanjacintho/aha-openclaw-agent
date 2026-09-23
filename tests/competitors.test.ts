import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { saveConfig } from "../aha/config.ts";
import { buildDigest, competitorSummary } from "../aha/digest/build.ts";
import { renderDigest } from "../aha/digest/render.ts";
import { autonomyLevel } from "../aha/responder/autonomy.ts";
import { openStore } from "../aha/store/db.ts";

async function home(t: import("node:test").TestContext) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aha-comp-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = openStore(dir);
  t.after(() => store.close());
  saveConfig(store, { company: { name: "Plow" }, competitors: ["zonk"] });
  return store;
}

function insertItem(store: ReturnType<typeof openStore>, over: { id?: number; state?: string; fetched?: string }) {
  store.db.prepare(`INSERT INTO items (source, external_id, url, author, title, body, published_at, fetched_at, state)
    VALUES ('ph', ?, 'https://www.producthunt.com/posts/x', 'a', 't', 'body', '2026-09-22T10:00:00.000Z', ?, ?)`).run(
    String(over.id ?? Math.random()), over.fetched ?? "2026-09-22T12:00:00.000Z", over.state ?? "relevant",
  );
  return Number((store.db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id);
}

function classify(store: ReturnType<typeof openStore>, itemId: number, over: { category: string; about: string; topic: string }) {
  store.db.prepare(`INSERT INTO classifications (item_id, sentiment, category, topic, language, is_question, urgency, about, confidence)
    VALUES (?, 0, ?, ?, 'en', 0, 'low', ?, 0.9)`).run(itemId, over.category, over.topic, over.about);
}

const until = new Date("2026-09-22T20:00:00.000Z");

test("competitor about is always L0", () => {
  assert.equal(autonomyLevel("competitor:zonk"), "L0");
  assert.equal(autonomyLevel("self"), "L1");
  assert.equal(autonomyLevel(null), "L1");
});

test("weekly competitor summary uses store counts in three blocks", async t => {
  const store = await home(t);
  classify(store, insertItem(store, { id: 1 }), { category: "praise", about: "competitor:zonk", topic: "onboarding" });
  classify(store, insertItem(store, { id: 2 }), { category: "comparison", about: "competitor:zonk", topic: "onboarding" });
  classify(store, insertItem(store, { id: 3 }), { category: "complaint", about: "competitor:zonk", topic: "pricing" });
  classify(store, insertItem(store, { id: 4 }), { category: "bug", about: "competitor:zonk", topic: "login" });
  classify(store, insertItem(store, { id: 5 }), { category: "complaint", about: "competitor:zonk", topic: "docs" });
  classify(store, insertItem(store, { id: 6 }), { category: "praise", about: "self", topic: "login" });
  store.db.prepare("INSERT INTO promises (topic, due, owner, status) VALUES ('login', '2026-09-20', 'Ana', 'resolvida')").run();
  const summary = competitorSummary(store, until);
  assert.deepEqual(summary.theyWin, [{ topic: "onboarding", n: 2 }]);
  assert.deepEqual(summary.theyComplain, [
    { topic: "docs", n: 1 },
    { topic: "login", n: 1 },
    { topic: "pricing", n: 1 },
  ]);
  assert.deepEqual(summary.weSolved, [{ topic: "login", n: 1 }]);
  const text = renderDigest(buildDigest(store, "founder", until), "pt");
  assert.match(text, /eles ganham em: onboarding \(2\)/);
  assert.match(text, /eles reclamam de: docs \(1\), login \(1\), pricing \(1\)/);
  assert.match(text, /nós já resolvemos: login \(1\)/);
  assert.equal((text.match(/\d+/g) || []).length > 0, true);
  const engenharia = buildDigest(store, "engenharia", until);
  assert.equal(engenharia.competitors, undefined);
});
