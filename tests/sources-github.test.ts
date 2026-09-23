import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { githubSource, parseGithubRepos } from "../aha/sources/github.ts";
import { type SourceQuery } from "../aha/sources/types.ts";

const issues = new URL("./fixtures/github-issues.json", import.meta.url);
const discussions = new URL("./fixtures/github-repo-discussions.json", import.meta.url);

const query: SourceQuery = {
  since: new Date("2026-09-21T00:00:00.000Z"),
  until: new Date("2026-09-23T00:00:00.000Z"),
  terms: ["Plow"],
};

const repos = [{ owner: "plow-pbc", name: "aha" }];
const cfg = { company: { name: "Plow" }, githubRepos: ["plow-pbc/aha"] };

test("parseGithubRepos keeps owner/name pairs", () => {
  assert.deepEqual(parseGithubRepos({ company: { name: "Plow" }, githubRepos: [" plow-pbc/aha.git ", "bad", "plow-pbc/aha"] }), [
    { owner: "plow-pbc", name: "aha" },
  ]);
});

test("GitHub fetches issues then discussions of the configured repo", async () => {
  const bodies: string[] = [];
  const source = githubSource({
    token: "ghs_test",
    repos,
    fetch: async (_url, init) => {
      const body = String(init?.body);
      bodies.push(body);
      const file = body.includes("issues(") ? issues : discussions;
      return new Response(await readFile(file), { status: 200 });
    },
  });
  assert.equal(source.enabled(cfg), true);
  const first = await source.fetch(query, null);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.deepEqual(first.items.map(item => item.externalId), ["ISS_1", "ISS_1c"]);
  assert.match(bodies[0], /plow-pbc/);
  assert.match(bodies[0], /"aha"/);
  const second = await source.fetch(query, first.nextCursor);
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(second.nextCursor, null);
  assert.deepEqual(second.items.map(item => item.externalId), ["DISC_1", "DISC_1c"]);
  assert.match(bodies[1], /discussions\(/);
});

test("GitHub without a configured repo stays off", () => {
  const source = githubSource({ token: "ghs_test", repos: [] });
  assert.equal(source.enabled({ company: { name: "Plow" } }), false);
});

test("GitHub GraphQL errors on HTTP 200 are unknown, not zero mentions", async () => {
  const source = githubSource({
    token: "ghs_test",
    repos,
    fetch: async () => new Response(JSON.stringify({ data: null, errors: [{ type: "NOT_FOUND", message: "no repo" }] }), { status: 200 }),
  });
  assert.deepEqual(await source.fetch(query, null), { ok: false, error: "unknown" });
});
