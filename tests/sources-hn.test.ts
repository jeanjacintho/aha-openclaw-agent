import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { htmlToText, hnSource, uniqueTermsCaseInsensitive } from "../aha/sources/hn.ts";
import { type SourceQuery } from "../aha/sources/types.ts";

const page0 = new URL("./fixtures/hn-page-0.json", import.meta.url);
const page1 = new URL("./fixtures/hn-page-1.json", import.meta.url);

const query: SourceQuery = {
  since: new Date("2026-09-21T12:00:00.000Z"),
  until: new Date("2026-09-22T15:00:00.000Z"),
  terms: ["Plow"],
};

test("HN fixtures normalize items and strip comment HTML", async () => {
  const urls: string[] = [];
  const source = hnSource(async input => {
    urls.push(String(input));
    return new Response(await readFile(page0), { status: 200, headers: { "content-type": "application/json" } });
  });
  const result = await source.fetch(query, null);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.nextCursor, "0:1");
  assert.equal(result.items[0].externalId, "111");
  assert.equal(result.items[0].url, "https://news.ycombinator.com/item?id=111");
  assert.equal(result.items[0].author, "alice");
  assert.equal(result.items[0].title, "Show HN: Plow queues");
  assert.equal(result.items[0].body, "We shipped this on Plow.\nSee 3/4 in the docs.");
  assert.equal(result.items[0].parentUrl, "https://news.ycombinator.com/item?id=100");
  assert.match(urls[0], /numericFilters=created_at_i%3E\d+%2Ccreated_at_i%3C\d+/);
  assert.match(urls[0], /page=0/);
  assert.equal(htmlToText("<p>We shipped this on <i>Plow</i>.<p>See 3&#x2F;4 in the <a href=\"https://example.com/x\">docs</a>."), "We shipped this on Plow.\nSee 3/4 in the docs.");
});

test("HN paginates by cursor", async () => {
  const source = hnSource(async input => {
    const url = String(input);
    const file = url.includes("page=1") ? page1 : page0;
    return new Response(await readFile(file), { status: 200 });
  });
  const first = await source.fetch(query, null);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.nextCursor, "0:1");
  const second = await source.fetch(query, first.nextCursor);
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(second.nextCursor, null);
  assert.equal(second.items[0].externalId, "113");
});

test("HN HTTP 429 is rate_limited", async () => {
  const source = hnSource(async () => new Response("", { status: 429, headers: { "retry-after": "2" } }));
  assert.deepEqual(await source.fetch(query, null), { ok: false, error: "rate_limited", retryAfterMs: 2000 });
});

test("uniqueTermsCaseInsensitive drops case-only duplicates", () => {
  assert.deepEqual(uniqueTermsCaseInsensitive(["Plow", "plow", " PLOW ", "Plow Inc"]), ["Plow", "Plow Inc"]);
});

test("HN searches each term separately instead of joining with OR", async () => {
  // The Algolia search_by_date endpoint has no OR operator: "Plow OR plow"
  // is parsed as three required words, which is why the real API returned
  // 116,908 hits for "Plow OR plow" vs. 1,347,617 for "plow" alone.
  const urls: string[] = [];
  const multiTermQuery: SourceQuery = { ...query, terms: ["Plow", "plow"] };
  const source = hnSource(async input => {
    urls.push(String(input));
    return new Response(JSON.stringify({ page: 0, nbPages: 1, hits: [] }), { status: 200 });
  });
  const first = await source.fetch(multiTermQuery, null);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.nextCursor, null);
  assert.equal(urls.length, 1);
  assert.doesNotMatch(urls[0], /OR/);
  assert.match(urls[0], /query=Plow(&|$)/);
});

test("HN advances the cursor to the next distinct term after exhausting one", async () => {
  const urls: string[] = [];
  const distinctTermsQuery: SourceQuery = { ...query, terms: ["Plow", "aha agent"] };
  const source = hnSource(async input => {
    const url = String(input);
    urls.push(url);
    return new Response(JSON.stringify({ page: 0, nbPages: 1, hits: [] }), { status: 200 });
  });
  const first = await source.fetch(distinctTermsQuery, null);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.nextCursor, "1:0");
  assert.match(urls[0], /query=Plow(&|$)/);
  const second = await source.fetch(distinctTermsQuery, first.nextCursor);
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(second.nextCursor, null);
  assert.match(urls[1], /query=aha%20agent(&|$)/);
});
