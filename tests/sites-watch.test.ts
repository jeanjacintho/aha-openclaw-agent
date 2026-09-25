import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { saveConfig } from "../aha/config.ts";
import { LatchError, type LatchClient } from "../aha/latch/bridge.ts";
import { addSite, getCursor, getSite } from "../aha/sites/store.ts";
import { runSiteWatch } from "../aha/sites/watch.ts";
import { openStore, type Store } from "../aha/store/db.ts";
import { siteHour } from "../aha/worker.ts";

async function home(t: import("node:test").TestContext) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aha-sitewatch-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = openStore(dir);
  t.after(() => store.close());
  saveConfig(store, { company: { name: "Plow", domain: "plow.co" } });
  return store;
}

// A page's canned answers to text/links, keyed by URL, plus a call log.
type PageAnswer = { text: string; links?: { href: string; text: string }[] };
function fakeLatch(pages: Record<string, PageAnswer | (() => PageAnswer)>, opts: { openFails?: LatchError; visited?: string[] } = {}): LatchClient {
  const visited = opts.visited ?? [];
  return {
    async call<T>(name: string, args: Record<string, unknown>): Promise<T> {
      if (name === "plow_browser_open") {
        if (opts.openFails) throw opts.openFails;
        return { session: "sess-1" } as T;
      }
      if (name === "plow_browser_close") return {} as T;
      if (name === "plow_browser" && args.action === "goto") {
        visited.push(String(args.url));
        if (!(String(args.url) in pages)) throw new LatchError("failed", `no fixture for ${args.url}`);
        return {} as T;
      }
      if (name === "plow_browser" && args.action === "text") {
        const current = visited[visited.length - 1];
        const page = pages[current];
        const resolved = typeof page === "function" ? page() : page;
        return { text: resolved.text } as T;
      }
      if (name === "plow_browser" && args.action === "links") {
        const current = visited[visited.length - 1];
        const page = pages[current];
        const resolved = typeof page === "function" ? page() : page;
        return { links: resolved.links ?? [] } as T;
      }
      throw new Error(`unexpected call ${name}`);
    },
  };
}

const NOW = new Date("2026-09-26T20:00:00.000Z");

test("siteHour runs an hour ahead of the digest, wrapping past midnight", () => {
  assert.deepEqual(siteHour({ hour: 9, tz: "America/Sao_Paulo" }), { hour: 8, tz: "America/Sao_Paulo" });
  assert.deepEqual(siteHour({ hour: 0, tz: "UTC" }), { hour: 23, tz: "UTC" });
});

test("no sites, or setup not done, does nothing", async t => {
  const store = await home(t);
  assert.deepEqual(await runSiteWatch(store, { latch: fakeLatch({}) }), { visited: 0, stored: 0, degraded: [] });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aha-sitewatch-nocfg-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const noCfg = openStore(dir);
  t.after(() => noCfg.close());
  addSite(noCfg, "https://blog.example.com/");
  assert.deepEqual(await runSiteWatch(noCfg, { latch: fakeLatch({}) }), { visited: 0, stored: 0, degraded: [] });
});

test("a first visit is a baseline: it records the page but stores nothing", async t => {
  const store = await home(t);
  const added = addSite(store, "https://blog.example.com/changelog");
  assert.equal(added.ok, true);
  if (!added.ok) return;
  const text = "We shipped a new onboarding flow for Plow that cuts setup time in half.\n\nAdded dark mode to the dashboard and fixed a sync bug that annoyed everyone.";
  const report = await runSiteWatch(store, { latch: fakeLatch({ "https://blog.example.com/changelog": { text } }), now: () => NOW });
  assert.deepEqual(report, { visited: 1, stored: 0, degraded: [] });
  assert.equal((store.db.prepare("SELECT COUNT(*) AS n FROM items").get() as { n: number }).n, 0);
  assert.equal(getCursor(store, added.site.id).length, 2);
  assert.equal(getSite(store, added.site.id)!.lastStatus, "ok");
});

test("a later visit stores only new content that mentions the company, in mentions mode", async t => {
  const store = await home(t);
  const added = addSite(store, "https://blog.example.com/changelog");
  assert.equal(added.ok, true);
  if (!added.ok) return;
  const baseline = "Old paragraph about something unrelated that was already here before we started watching.";
  await runSiteWatch(store, { latch: fakeLatch({ "https://blog.example.com/changelog": { text: baseline } }), now: () => NOW });
  const later = `${baseline}\n\nWe just integrated Plow into our onboarding so new teams sign up faster than ever.\n\nAlso fixed an unrelated typo in the footer copyright notice text here.`;
  const report = await runSiteWatch(store, { latch: fakeLatch({ "https://blog.example.com/changelog": { text: later } }), now: () => NOW });
  assert.equal(report.stored, 1);
  const item = { ...store.db.prepare("SELECT source, url, author, body, state FROM items").get() as Record<string, unknown> };
  assert.deepEqual(item, {
    source: "site", url: "https://blog.example.com/changelog", author: "blog.example.com",
    body: "We just integrated Plow into our onboarding so new teams sign up faster than ever.", state: "new",
  });
});

test("mode all keeps every new block, mentions or not", async t => {
  const store = await home(t);
  const added = addSite(store, "https://competitor.example.com/changelog", { mode: "all" });
  assert.equal(added.ok, true);
  if (!added.ok) return;
  await runSiteWatch(store, { latch: fakeLatch({ "https://competitor.example.com/changelog": { text: "baseline paragraph that is long enough to count as a block here." } }), now: () => NOW });
  const later = "baseline paragraph that is long enough to count as a block here.\n\nShipped a totally unrelated feature that never mentions any competitor by name.";
  const report = await runSiteWatch(store, { latch: fakeLatch({ "https://competitor.example.com/changelog": { text: later } }), now: () => NOW });
  assert.equal(report.stored, 1);
});

test("Latch unavailable when opening the session degrades every site with the same reason", async t => {
  const store = await home(t);
  const a = addSite(store, "https://a.example.com/");
  const b = addSite(store, "https://b.example.com/");
  assert.equal(a.ok && b.ok, true);
  if (!a.ok || !b.ok) return;
  const report = await runSiteWatch(store, { latch: fakeLatch({}, { openFails: new LatchError("unavailable", "Latch is not connected") }), now: () => NOW });
  assert.deepEqual(report, { visited: 0, stored: 0, degraded: [
    { url: "https://a.example.com", reason: "unavailable: Latch is not connected" },
    { url: "https://b.example.com", reason: "unavailable: Latch is not connected" },
  ] });
  assert.equal(getSite(store, a.site.id)!.lastStatus, "degraded");
  assert.equal(getSite(store, b.site.id)!.lastStatus, "degraded");
  const health = store.db.prepare("SELECT status, detail FROM source_runs WHERE source = 'site'").get() as { status: string; detail: string };
  assert.equal(health.status, "degraded");
  assert.match(health.detail, /unavailable: Latch is not connected/);
});

test("a single site failing does not stop the rest, and Latch's own scope refusal is classified as denied", async t => {
  const store = await home(t);
  const good = addSite(store, "https://good.example.com/");
  const scoped = addSite(store, "https://scoped.example.com/");
  assert.equal(good.ok && scoped.ok, true);
  if (!good.ok || !scoped.ok) return;
  const visited: string[] = [];
  const latch: LatchClient = {
    async call<T>(name: string, args: Record<string, unknown>): Promise<T> {
      if (name === "plow_browser_open") return { session: "sess-1" } as T;
      if (name === "plow_browser_close") return {} as T;
      if (name === "plow_browser" && args.action === "goto") {
        visited.push(String(args.url));
        if (String(args.url).includes("scoped")) throw new LatchError("denied", "scoped.example.com is outside the approved origins");
        return {} as T;
      }
      if (name === "plow_browser" && args.action === "text") return { text: "A brand new paragraph mentioning Plow for the very first time here." } as T;
      if (name === "plow_browser" && args.action === "links") return { links: [] } as T;
      throw new Error(`unexpected call ${name}`);
    },
  };
  const report = await runSiteWatch(store, { latch, now: () => NOW });
  assert.equal(report.visited, 2);
  assert.equal(report.degraded.length, 1);
  assert.equal(report.degraded[0].reason, "denied: scoped.example.com is outside the approved origins");
  assert.equal(getSite(store, good.site.id)!.lastStatus, "ok");
  assert.equal(getSite(store, scoped.site.id)!.lastStatus, "degraded");
  const health = store.db.prepare("SELECT status FROM source_runs WHERE source = 'site'").get() as { status: string };
  assert.equal(health.status, "degraded");
});
