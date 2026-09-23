import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { agentIndexSource } from "../aha/sources/agent-index.ts";
import { type SourceQuery } from "../aha/sources/types.ts";

const fixture = new URL("./fixtures/github-discussions.json", import.meta.url);
const query: SourceQuery = {
  since: new Date("2026-09-21T00:00:00.000Z"),
  until: new Date("2026-09-23T00:00:00.000Z"),
  terms: ["aha"],
};

test("Agent Index keeps only agent:<slug> comments and replies", async () => {
  let body = "";
  const source = agentIndexSource({
    token: "ghs_test",
    slug: "aha",
    fetch: async (_url, init) => {
      body = String(init?.body);
      return new Response(await readFile(fixture), { status: 200 });
    },
  });
  assert.equal(source.enabled({ company: { name: "Plow" } }), true);
  const result = await source.fetch(query, null);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.items.map(item => item.externalId), ["D_1", "D_1r"]);
  assert.equal(result.items[0].body, "The aha agent missed a mention.");
  assert.equal(result.items[1].parentUrl, "https://github.com/plow-pbc/agent-index-comments/discussions/1#discussioncomment-1");
  assert.match(body, /plow-pbc/);
  assert.match(body, /agent-index-comments/);
});

test("Agent Index without a token stays off", async () => {
  let called = 0;
  const source = agentIndexSource({
    token: "",
    slug: "aha",
    fetch: async () => {
      called += 1;
      return new Response("no", { status: 500 });
    },
  });
  assert.equal(source.enabled({ company: { name: "Plow" } }), false);
  assert.equal(called, 0);
});

test("Agent Index requests comments and replies as last:100, newest first", async () => {
  // comments(first: 100) truncates to the OLDEST 100 comments, since GitHub
  // returns them chronologically; a busy discussion would then never surface
  // its newest comments. last: 100 keeps the most recent ones instead.
  let body = "";
  const source = agentIndexSource({
    token: "ghs_test",
    slug: "aha",
    fetch: async (_url, init) => {
      body = String(init?.body);
      return new Response(await readFile(fixture), { status: 200 });
    },
  });
  await source.fetch(query, null);
  assert.match(body, /comments\(last:\s*100\)/);
  assert.match(body, /replies\(last:\s*100\)/);
});

test("GraphQL errors on HTTP 200 do not read as zero mentions", async () => {
  const source = agentIndexSource({
    token: "ghs_test",
    slug: "aha",
    fetch: async () => new Response(JSON.stringify({ data: null, errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }] }), { status: 200 }),
  });
  assert.deepEqual(await source.fetch(query, null), { ok: false, error: "rate_limited" });
});

test("GraphQL non-rate-limit errors on HTTP 200 are unknown, not ok", async () => {
  const source = agentIndexSource({
    token: "ghs_test",
    slug: "aha",
    fetch: async () => new Response(JSON.stringify({ data: null, errors: [{ type: "NOT_FOUND", message: "Could not resolve to a Repository" }] }), { status: 200 }),
  });
  assert.deepEqual(await source.fetch(query, null), { ok: false, error: "unknown" });
});

test("secondary rate limit (403 + Retry-After) is rate_limited, not auth", async () => {
  const source = agentIndexSource({
    token: "ghs_test",
    slug: "aha",
    fetch: async () => new Response("", { status: 403, headers: { "retry-after": "30" } }),
  });
  assert.deepEqual(await source.fetch(query, null), { ok: false, error: "rate_limited", retryAfterMs: 30000 });
});

test("primary rate limit (403 + X-RateLimit-Remaining: 0) is rate_limited, not auth", async () => {
  const resetAt = Math.floor(Date.now() / 1000) + 60;
  const source = agentIndexSource({
    token: "ghs_test",
    slug: "aha",
    fetch: async () => new Response("", { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(resetAt) } }),
  });
  const result = await source.fetch(query, null);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error, "rate_limited");
});

test("a plain 403 without rate-limit headers is still auth", async () => {
  const source = agentIndexSource({
    token: "ghs_bad",
    slug: "aha",
    fetch: async () => new Response("", { status: 403 }),
  });
  assert.deepEqual(await source.fetch(query, null), { ok: false, error: "auth" });
});
