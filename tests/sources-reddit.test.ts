import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { redditSource, REDDIT_USER_AGENT } from "../aha/sources/reddit.ts";
import { type SourceQuery } from "../aha/sources/types.ts";

const fixture = new URL("./fixtures/reddit-search.json", import.meta.url);
const query: SourceQuery = {
  since: new Date("2026-09-21T00:00:00.000Z"),
  until: new Date("2026-09-23T00:00:00.000Z"),
  terms: ["Plow"],
};

test("Reddit search uses the user token and app User-Agent", async () => {
  const headers: string[] = [];
  const source = redditSource({
    token: "reddit_user_token",
    fetch: async (input, init) => {
      assert.ok(init?.signal instanceof AbortSignal);
      const h = new Headers(init?.headers);
      headers.push(`${h.get("authorization")}|${h.get("user-agent")}|${String(input)}`);
      return new Response(await readFile(fixture), { status: 200 });
    },
  });
  assert.equal(source.enabled({ company: { name: "Plow" } }), true);
  const result = await source.fetch(query, null);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.items[0].externalId, "t1_abc");
  assert.equal(result.items[0].source, "reddit");
  assert.match(result.items[0].url, /testaha/);
  assert.equal(result.items[0].parentUrl, "https://www.reddit.com/t3_xyz");
  assert.equal(result.items.some(item => item.externalId === "t1_old"), false);
  assert.match(headers[0], /^Bearer reddit_user_token\|/);
  assert.match(headers[0], new RegExp(REDDIT_USER_AGENT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(REDDIT_USER_AGENT.includes("aha"), true);
});

test("Reddit without a token stays off", () => {
  const source = redditSource({ token: "" });
  assert.equal(source.enabled({ company: { name: "Plow" } }), false);
});

test("Reddit HTTP 429 is rate_limited", async () => {
  const source = redditSource({
    token: "tok",
    fetch: async () => new Response("", { status: 429, headers: { "retry-after": "2" } }),
  });
  assert.deepEqual(await source.fetch(query, null), { ok: false, error: "rate_limited", retryAfterMs: 2000 });
});

test("Reddit stops paging a term after the oldest result passes since and continues with the next term", async () => {
  const calls: string[] = [];
  const source = redditSource({
    token: "tok",
    fetch: async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("q=Plow")) return Response.json({ data: { after: "t3_older", children: [
        { kind: "t1", data: { id: "recent", name: "t1_recent", author: "a", body: "recent", created_utc: 1790035200, permalink: "/r/test/comments/x/recent" } },
        { kind: "t1", data: { id: "old", name: "t1_old", author: "a", body: "old", created_utc: 1789862400, permalink: "/r/test/comments/x/old" } },
      ] } });
      return Response.json({ data: { after: null, children: [] } });
    },
  });
  const multiTermQuery = { ...query, terms: ["Plow", "queues"] };
  const first = await source.fetch(multiTermQuery, null);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.deepEqual(first.items.map(item => item.externalId), ["t1_recent"]);
  assert.deepEqual(JSON.parse(first.nextCursor!), { i: 1, after: null });
  const second = await source.fetch(multiTermQuery, first.nextCursor);
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(second.nextCursor, null);
  assert.equal(calls.length, 2);
  assert.match(calls[1], /q=queues/);
});
