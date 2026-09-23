import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { saveConfig } from "../aha/config.ts";
import { passesFilter1, runIngest } from "../aha/pipeline/ingest.ts";
import { agentIndexSource } from "../aha/sources/agent-index.ts";
import { hnSource } from "../aha/sources/hn.ts";
import { openStore } from "../aha/store/db.ts";
import { type FetchResult, type SourceAdapter } from "../aha/sources/types.ts";

const now = new Date("2026-09-22T18:00:00.000Z");
const cfg = { company: { name: "Plow", aliases: ["plow"], negative: ["snow"] } };

async function home(t: import("node:test").TestContext) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aha-ingest-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = openStore(dir);
  t.after(() => store.close());
  saveConfig(store, cfg);
  return store;
}

function stub(id: SourceAdapter["id"], result: FetchResult | FetchResult[], enabled = true): SourceAdapter {
  const queue = Array.isArray(result) ? [...result] : [result];
  return {
    id,
    enabled: () => enabled,
    async fetch() {
      return queue.shift() ?? { ok: true, items: [], nextCursor: null };
    },
  };
}

test("filtro 1 keeps plow and drops plow+snow", () => {
  const keep = { source: "hn", externalId: "1", url: "https://news.ycombinator.com/item?id=1", author: "a", body: "Trying plow queues", publishedAt: now.toISOString() };
  const drop = { ...keep, externalId: "2", title: "Snow plow", body: "Need a snow plow" };
  assert.equal(passesFilter1(keep, cfg), true);
  assert.equal(passesFilter1(drop, cfg), false);
});

test("filtro 1 does not match on the url alone", () => {
  // "plow-pbc" used to leak in through item.url and pass the alias check even
  // though the body never mentions the company.
  const item = { source: "hn", externalId: "3", url: "https://github.com/plow-pbc/agent-index-comments/discussions/1", author: "a", body: "Unrelated discussion about something else.", publishedAt: now.toISOString() };
  assert.equal(passesFilter1(item, cfg), false);
});

test("filtro 1 skips alias matching for agent-index items regardless of company name", () => {
  // Agent Index comments already live inside an agent:<slug> discussion for
  // this company, so they are on-topic even when they never say the company
  // name — this must hold for a company other than "Plow" too.
  const zonkCfg = { company: { name: "Zonk", negative: ["unrelated"] } };
  const onTopic = { source: "agent-index", externalId: "D_1", url: "https://github.com/plow-pbc/agent-index-comments/discussions/1#discussioncomment-1", author: "nina", body: "The agent missed a mention.", publishedAt: now.toISOString() };
  assert.equal(passesFilter1(onTopic, zonkCfg), true);
  const negative = { ...onTopic, externalId: "D_2", body: "This is an unrelated aside." };
  assert.equal(passesFilter1(negative, zonkCfg), false);
});

test("filtro 1 keeps competitor names from config", () => {
  const zonkCfg = { company: { name: "Plow" }, competitors: ["zonk"] };
  const item = { source: "ph", externalId: "PHC_Z1", url: "https://www.producthunt.com/posts/zonk", author: "a", title: "Zonk", body: "Zonk onboarding is smoother.", publishedAt: now.toISOString() };
  assert.equal(passesFilter1(item, zonkCfg), true);
});

test("filtro 1 skips alias matching for github items of the configured repo", () => {
  const item = { source: "github", externalId: "ISS_1", url: "https://github.com/plow-pbc/aha/issues/12", author: "nina", title: "Login hangs", body: "The form never returns.", publishedAt: now.toISOString() };
  assert.equal(passesFilter1(item, { company: { name: "Zonk", negative: ["unrelated"] } }), true);
  assert.equal(passesFilter1({ ...item, body: "This is an unrelated aside." }, { company: { name: "Zonk", negative: ["unrelated"] } }), false);
});

test("an error on one source does not stop the others", async t => {
  const store = await home(t);
  const report = await runIngest(store, [
    stub("hn", { ok: false, error: "unknown" }),
    stub("agent-index", { ok: true, items: [{ source: "agent-index", externalId: "D_1", url: "https://example.com/d", author: "n", body: "plow mention", publishedAt: now.toISOString() }], nextCursor: null }),
  ], now);
  assert.deepEqual(report.sources.map(row => ({ id: row.id, status: row.status })), [
    { id: "hn", status: "error" },
    { id: "agent-index", status: "ok" },
  ]);
  const runs = (store.db.prepare("SELECT source, status FROM source_runs ORDER BY id").all() as { source: string; status: string }[])
    .map(row => ({ source: row.source, status: row.status }));
  assert.deepEqual(runs, [{ source: "hn", status: "error" }, { source: "agent-index", status: "ok" }]);
  assert.equal((store.db.prepare("SELECT COUNT(*) AS n FROM items").get() as { n: number }).n, 1);
});

test("rate_limited is recorded as limitada", async t => {
  const store = await home(t);
  const report = await runIngest(store, [stub("hn", { ok: false, error: "rate_limited" })], now);
  assert.equal(report.sources[0].status, "limitada");
  assert.equal((store.db.prepare("SELECT status FROM source_runs").get() as { status: string }).status, "limitada");
});

test("running ingest twice does not duplicate items", async t => {
  const store = await home(t);
  const page0 = JSON.parse(await readFile(new URL("./fixtures/hn-page-0.json", import.meta.url), "utf8"));
  const page1 = JSON.parse(await readFile(new URL("./fixtures/hn-page-1.json", import.meta.url), "utf8"));
  const adapter = hnSource(async input => {
    const url = String(input);
    return new Response(JSON.stringify(url.includes("page=1") ? page1 : page0), { status: 200 });
  });
  const first = await runIngest(store, [adapter], now);
  const second = await runIngest(store, [adapter], now);
  assert.equal(first.sources[0].stored, 2);
  assert.equal(second.sources[0].stored, 0);
  assert.equal((store.db.prepare("SELECT COUNT(*) AS n FROM items").get() as { n: number }).n, 2);
  const ids = (store.db.prepare("SELECT external_id FROM items ORDER BY external_id").all() as { external_id: string }[]).map(row => row.external_id);
  assert.deepEqual(ids, ["111", "113"]);
  const detail = (store.db.prepare("SELECT detail FROM source_runs ORDER BY id LIMIT 1").get() as { detail: string | null }).detail;
  assert.equal(detail, null);
});

test("a source that never returns a null cursor does not loop forever", async t => {
  const store = await home(t);
  const looping: SourceAdapter = {
    id: "hn",
    enabled: () => true,
    async fetch() {
      return { ok: true, items: [], nextCursor: "same" };
    },
  };
  const report = await runIngest(store, [looping], now);
  assert.equal(report.sources[0].status, "error");
  assert.equal(report.sources[0].detail, "too_many_pages");
});

test("Agent Index without a token is skipped and ingest continues", async t => {
  const store = await home(t);
  let called = 0;
  const off = agentIndexSource({ token: "", slug: "aha", fetch: async () => { called += 1; return new Response("", { status: 500 }); } });
  const on = stub("hn", { ok: true, items: [{ source: "hn", externalId: "9", url: "https://news.ycombinator.com/item?id=9", author: "a", body: "plow", publishedAt: now.toISOString() }], nextCursor: null });
  const report = await runIngest(store, [off, on], now);
  assert.equal(called, 0);
  assert.deepEqual(report.sources.map(row => row.id), ["hn"]);
});
