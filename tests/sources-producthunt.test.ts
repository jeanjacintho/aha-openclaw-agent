import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { PH_COMPLEXITY_BUDGET, PH_CONSERVATIVE_COST, phNextCost, phShouldBackoff } from "../aha/sources/http.ts";
import { phSlug, productHuntSource } from "../aha/sources/producthunt.ts";
import { type SourceQuery } from "../aha/sources/types.ts";

const plow = new URL("./fixtures/ph-plow.json", import.meta.url);
const zonk = new URL("./fixtures/ph-zonk.json", import.meta.url);

const query: SourceQuery = {
  since: new Date("2026-09-21T00:00:00.000Z"),
  until: new Date("2026-09-23T00:00:00.000Z"),
  terms: ["Plow", "zonk"],
};

function jsonResponse(body: string, headers: Record<string, string> = {}) {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });
}

test("PH fetches comments for the product and for competitors", async () => {
  const slugs: string[] = [];
  const source = productHuntSource({
    token: "ph_test",
    fetch: async (_url, init) => {
      const payload = JSON.parse(String(init?.body)) as { variables: { slug: string } };
      slugs.push(payload.variables.slug);
      const file = payload.variables.slug === "zonk" ? zonk : plow;
      return jsonResponse(await readFile(file, "utf8"), { "x-complexity": "40", "x-rate-limit-remaining": "6200" });
    },
  });
  assert.equal(source.enabled({ company: { name: "Plow" } }), true);
  const first = await source.fetch(query, null);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.items[0].externalId, "PHC_1");
  assert.equal(first.items[0].title, "Plow");
  assert.equal(first.items.some(item => item.externalId === "PHC_old"), false);
  assert.equal(slugs[0], "plow");
  const second = await source.fetch(query, first.nextCursor);
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(second.nextCursor, null);
  assert.equal(second.items[0].externalId, "PHC_Z1");
  assert.equal(second.items[0].title, "Zonk");
  assert.deepEqual(slugs, ["plow", "zonk"]);
});

test("PH backs off when remaining complexity cannot cover the last query", async () => {
  let calls = 0;
  const source = productHuntSource({
    token: "ph_test",
    fetch: async () => {
      calls += 1;
      return jsonResponse(await readFile(plow, "utf8"), {
        "x-complexity": "80",
        "x-rate-limit-remaining": "50",
        "x-rate-limit-reset": "15",
      });
    },
  });
  const first = await source.fetch(query, null);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.items[0].externalId, "PHC_1");
  assert.ok(first.nextCursor);
  const second = await source.fetch(query, first.nextCursor);
  assert.deepEqual(second, { ok: false, error: "rate_limited", retryAfterMs: 15000 });
  assert.equal(calls, 1);
  assert.equal(PH_COMPLEXITY_BUDGET, 6250);
  assert.equal(phShouldBackoff(50, 80), true);
  assert.equal(phShouldBackoff(80, 80), false);
  assert.equal(phShouldBackoff(5, PH_CONSERVATIVE_COST), true);
});

test("PH backs off from remaining drop when complexity headers are absent", async () => {
  let calls = 0;
  const source = productHuntSource({
    token: "ph_test",
    fetch: async () => {
      calls += 1;
      return jsonResponse(await readFile(plow, "utf8"), {
        "x-rate-limit-remaining": "5",
        "x-rate-limit-reset": "15",
      });
    },
  });
  const first = await source.fetch(query, null);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const second = await source.fetch(query, first.nextCursor);
  assert.deepEqual(second, { ok: false, error: "rate_limited", retryAfterMs: 15000 });
  assert.equal(calls, 1);
  assert.equal(phNextCost({ remaining: 5 }), PH_CONSERVATIVE_COST);
  assert.equal(phNextCost({ previousRemaining: 200, remaining: 120 }), 80);
  assert.equal(phShouldBackoff(5, undefined), true);
});

test("PH HTTP 429 is rate_limited", async () => {
  const source = productHuntSource({
    token: "ph_test",
    fetch: async () => new Response("", { status: 429, headers: { "retry-after": "3" } }),
  });
  assert.deepEqual(await source.fetch(query, null), { ok: false, error: "rate_limited", retryAfterMs: 3000 });
});

test("PH without a token stays off", async () => {
  let called = 0;
  const source = productHuntSource({
    token: "",
    fetch: async () => {
      called += 1;
      return new Response("", { status: 500 });
    },
  });
  assert.equal(source.enabled({ company: { name: "Plow" } }), false);
  assert.equal(called, 0);
});

test("phSlug turns a competitor name into a Product Hunt slug", () => {
  assert.equal(phSlug("Zonk Cloud"), "zonk-cloud");
});
