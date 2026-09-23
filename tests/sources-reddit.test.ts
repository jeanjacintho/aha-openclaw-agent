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
