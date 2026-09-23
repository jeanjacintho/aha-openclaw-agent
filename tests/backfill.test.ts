import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { saveConfig } from "../aha/config.ts";
import { runBackfill } from "../aha/pipeline/backfill.ts";
import { openStore } from "../aha/store/db.ts";
import { type FetchResult, type SourceAdapter, type SourceQuery } from "../aha/sources/types.ts";

const now = new Date("2026-09-22T18:00:00.000Z");

async function home(t: import("node:test").TestContext) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aha-backfill-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = openStore(dir);
  t.after(() => store.close());
  saveConfig(store, { company: { name: "Plow" } });
  return store;
}

function item(id: string): FetchResult {
  return {
    ok: true,
    items: [{
      source: "hn", externalId: id, url: `https://news.ycombinator.com/item?id=${id}`,
      author: "a", body: "plow mention", publishedAt: now.toISOString(),
    }],
    nextCursor: null,
  };
}

test("backfill more than 30 days is rejected", async t => {
  const store = await home(t);
  await assert.rejects(() => runBackfill(store, [], 31, now), /30/);
  await assert.rejects(() => runBackfill(store, [], 0, now), /30|days/);
});

test("backfill follows source cursors and does not duplicate", async t => {
  const store = await home(t);
  const cursors: (string | null)[] = [];
  const queries: SourceQuery[] = [];
  const adapter: SourceAdapter = {
    id: "hn",
    enabled: () => true,
    async fetch(query, cursor) {
      queries.push(query);
      cursors.push(cursor);
      if (cursor === null) {
        return {
          ok: true,
          items: [{
            source: "hn", externalId: "a", url: "https://news.ycombinator.com/item?id=a",
            author: "a", body: "plow one", publishedAt: now.toISOString(),
          }],
          nextCursor: "p2",
        };
      }
      return {
        ok: true,
        items: [{
          source: "hn", externalId: "b", url: "https://news.ycombinator.com/item?id=b",
          author: "a", body: "plow two", publishedAt: now.toISOString(),
        }],
        nextCursor: null,
      };
    },
  };
  const first = await runBackfill(store, [adapter], 30, now);
  const second = await runBackfill(store, [adapter], 30, now);
  assert.equal(first.sources[0].stored, 2);
  assert.equal(second.sources[0].stored, 0);
  assert.deepEqual(cursors, [null, "p2", null, "p2"]);
  assert.equal((store.db.prepare("SELECT COUNT(*) AS n FROM items").get() as { n: number }).n, 2);
  const since = queries[0].since.getTime();
  const until = queries[0].until.getTime();
  assert.equal(until, now.getTime());
  assert.equal(until - since, 30 * 24 * 60 * 60 * 1000);
});

test("a 1-day backfill uses a 24h window", async t => {
  const store = await home(t);
  let query: SourceQuery | undefined;
  const adapter: SourceAdapter = {
    id: "hn",
    enabled: () => true,
    async fetch(q) {
      query = q;
      return item("1");
    },
  };
  await runBackfill(store, [adapter], 1, now);
  assert.equal(query!.until.getTime() - query!.since.getTime(), 24 * 60 * 60 * 1000);
});
