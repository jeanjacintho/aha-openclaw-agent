import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { saveConfig } from "../aha/config.ts";
import { draftReply, stripOffListLinks, validateReply } from "../aha/responder/drafts.ts";
import { openStore } from "../aha/store/db.ts";

async function home(t: import("node:test").TestContext) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aha-drafts-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = openStore(dir);
  t.after(() => store.close());
  saveConfig(store, {
    company: { name: "Plow" },
    language: "en",
    links: ["https://plow.example/docs"],
  });
  return store;
}

function insertItem(store: ReturnType<typeof openStore>, over: { about?: string; lang?: string; body?: string; url?: string } = {}) {
  store.db.prepare(`INSERT INTO items (source, external_id, url, author, title, body, published_at, fetched_at, state)
    VALUES ('hn', ?, ?, 'a', 'Plow queues', ?, '2026-09-22T00:00:00.000Z', '2026-09-22T00:00:00.000Z', 'relevant')`)
    .run(String(Math.random()), over.url ?? "https://news.ycombinator.com/item?id=1", over.body ?? "Does plow queue jobs?");
  const id = Number((store.db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id);
  store.db.prepare(`INSERT INTO classifications (item_id, sentiment, category, topic, language, is_question, urgency, about, confidence)
    VALUES (?, 0, 'question', 'queues', ?, 1, 'low', ?, 0.9)`).run(id, over.lang ?? "en", over.about ?? "self");
  return id;
}

test("the validator removes links that are not on the owner's list", () => {
  const allowed = ["https://plow.example/docs"];
  const text = stripOffListLinks("See https://evil.example/x and https://plow.example/docs/ok", allowed);
  assert.equal(text.includes("evil.example"), false);
  assert.match(text, /plow\.example\/docs\/ok/);
});

test("the validator refuses a deadline or price promise", () => {
  const result = validateReply("We will ship in 3 days for $99", {
    company: "Plow", lang: "en", url: null, links: [],
  });
  assert.equal(result.ok, false);
});

test("the validator requires the language of the original post", () => {
  const en = validateReply("você não deveria usar isso", { company: "Plow", lang: "en", url: null });
  assert.equal(en.ok, false);
  const pt = validateReply("Obrigado pela pergunta sobre o produto", { company: "Plow", lang: "pt", url: null });
  assert.equal(pt.ok, true);
  if (pt.ok) assert.match(pt.body, /assistente de IA da Plow/);
});

test("the validator appends the AHA signature", () => {
  const result = validateReply("Thanks for asking about queues.", { company: "Plow", lang: "en", url: null });
  assert.equal(result.ok, true);
  if (result.ok) assert.match(result.body, /— AHA, AI assistant of Plow/);
});

test("draftReply strips off-list links, signs the body, and stores a pending draft", async t => {
  const store = await home(t);
  const itemId = insertItem(store);
  const draft = await draftReply(store, itemId, {
    complete: async () => ({ ok: true, value: { body: "Thanks for asking. See https://evil.example/x and https://plow.example/docs" } }),
  });
  assert.equal(draft.state, "pending");
  assert.equal(draft.body.includes("evil.example"), false);
  assert.match(draft.body, /plow\.example\/docs/);
  assert.match(draft.body, /AI assistant of Plow/);
  assert.equal((store.db.prepare("SELECT COUNT(*) AS n FROM drafts").get() as { n: number }).n, 1);
});

test("draftReply refuses a promise of time or price", async t => {
  const store = await home(t);
  const itemId = insertItem(store);
  await assert.rejects(
    () => draftReply(store, itemId, { complete: async () => ({ ok: true, value: { body: "Fix by Friday for $50" } }) }),
    /promise/,
  );
  assert.equal((store.db.prepare("SELECT COUNT(*) AS n FROM drafts").get() as { n: number }).n, 0);
});

test("a competitor item never gets a draft", async t => {
  const store = await home(t);
  const itemId = insertItem(store, { about: "competitor:zonk" });
  let called = 0;
  await assert.rejects(
    () => draftReply(store, itemId, { complete: async () => { called += 1; return { ok: true, value: { body: "hi" } }; } }),
    /competitor/,
  );
  assert.equal(called, 0);
  assert.equal((store.db.prepare("SELECT COUNT(*) AS n FROM drafts").get() as { n: number }).n, 0);
});
