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
