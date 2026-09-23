import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { saveConfig } from "../aha/config.ts";
import { classifySystemPrompt } from "../aha/llm/prompts.ts";
import { classifyBatch, type ItemRow } from "../aha/pipeline/classify.ts";
import { assignTopic, listTopics } from "../aha/pipeline/topics.ts";
import { openStore } from "../aha/store/db.ts";

async function home(t: import("node:test").TestContext) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aha-topics-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = openStore(dir);
  t.after(() => store.close());
  saveConfig(store, { company: { name: "Plow" } });
  return store;
}

function insert(store: ReturnType<typeof openStore>, over: { externalId?: string; body?: string } = {}) {
  store.db.prepare(`INSERT INTO items (source, external_id, url, author, title, body, published_at, fetched_at, state)
    VALUES ('hn', ?, 'https://news.ycombinator.com/item?id=1', 'alice', 'Plow?', ?, '2026-09-22T00:00:00.000Z', '2026-09-22T00:00:00.000Z', 'new')`)
    .run(over.externalId ?? "1", over.body ?? "bug de login no plow");
  return store.db.prepare("SELECT * FROM items WHERE id = last_insert_rowid()").get() as ItemRow;
}

test("Login bug and login-bug reuse one topic by normalization", async t => {
  const store = await home(t);
  const a = assignTopic(store, "Login bug");
  const b = assignTopic(store, "login-bug");
  assert.equal(a, b);
  assert.equal(assignTopic(store, "login bug."), a);
  assert.equal(assignTopic(store, "Integração"), assignTopic(store, "integracao"));
  assert.deepEqual(listTopics(store).map(row => row.label), ["Login bug", "Integração"]);
});

test("bug de login reuses Login bug when that label is on the existing-topic list passed to the LLM", async t => {
  const store = await home(t);
  const id = assignTopic(store, "Login bug");
  const labels = listTopics(store).map(row => row.label);
  assert.ok(labels.includes("Login bug"));
  const prompt = classifySystemPrompt({ company: { name: "Plow" } }, [], labels);
  assert.match(prompt, /Login bug/);
  assert.match(prompt, /reuse/i);

  const item = insert(store);
  let seen = "";
  const report = await classifyBatch(store, [item], {
    complete: async req => {
      seen = req.system;
      return {
        ok: true,
        value: {
          results: [{
            id: item.id,
            relevant: true,
            confidence: 0.9,
            about: "self",
            sentiment: -0.4,
            category: "bug",
            topic: "Login bug",
            lang: "pt",
            isQuestion: false,
            urgency: "med",
            reason: "login failure",
          }],
        },
      };
    },
  });
  assert.equal(report.classified, 1);
  assert.match(seen, /Login bug/);
  const row = store.db.prepare("SELECT topic FROM classifications WHERE item_id = ?").get(item.id) as { topic: string };
  assert.equal(row.topic, "Login bug");
  assert.equal(assignTopic(store, row.topic), id);
});
