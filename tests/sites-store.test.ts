import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { addSite, getCursor, getSite, listSites, MAX_SITES, normalizeSiteUrl, recordSiteRun, removeSite, saveCursor } from "../aha/sites/store.ts";
import { openStore } from "../aha/store/db.ts";

async function home(t: import("node:test").TestContext) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aha-sites-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = openStore(dir);
  t.after(() => store.close());
  return store;
}

test("normalizeSiteUrl accepts a public https page and rejects everything a scoped watch should not visit", () => {
  assert.deepEqual(normalizeSiteUrl("https://blog.example.com/changelog/"), { ok: true, url: "https://blog.example.com/changelog" });
  assert.deepEqual(normalizeSiteUrl("HTTPS://Example.com/a#section"), { ok: true, url: "https://example.com/a" });
  for (const bad of [
    "http://example.com", "ftp://example.com/x", "not a url",
    "https://localhost/x", "https://127.0.0.1/x", "https://[::1]/x", "https://box.local/x", "https://intranet/x",
  ]) {
    assert.equal(normalizeSiteUrl(bad).ok, false, bad);
  }
});

test("addSite dedupes by normalized URL and enforces the site limit", async t => {
  const store = await home(t);
  const first = addSite(store, "https://example.com/blog/");
  assert.equal(first.ok, true);
  const dup = addSite(store, "https://EXAMPLE.com/blog");
  assert.equal(dup.ok, false);
  if (!dup.ok) assert.equal(dup.reason, "duplicate");
  for (let i = 0; i < MAX_SITES - 1; i++) {
    const result = addSite(store, `https://example${i}.com/`);
    assert.equal(result.ok, true, `site ${i}`);
  }
  assert.equal(listSites(store).length, MAX_SITES);
  const over = addSite(store, "https://over-limit.example.com/");
  assert.equal(over.ok, false);
  if (!over.ok) assert.equal(over.reason, "limit");
});

test("addSite records the label and mode, defaulting to mentions", async t => {
  const store = await home(t);
  const mentions = addSite(store, "https://example.com/");
  assert.equal(mentions.ok, true);
  if (mentions.ok) assert.deepEqual({ label: mentions.site.label, mode: mentions.site.mode, active: mentions.site.active }, { label: null, mode: "mentions", active: true });
  const labeled = addSite(store, "https://competitor.example.com/changelog", { label: "Competitor changelog", mode: "all" });
  assert.equal(labeled.ok, true);
  if (labeled.ok) assert.deepEqual({ label: labeled.site.label, mode: labeled.site.mode }, { label: "Competitor changelog", mode: "all" });
});

test("removeSite works by id or by URL, normalized or not", async t => {
  const store = await home(t);
  const a = addSite(store, "https://a.example.com/");
  const b = addSite(store, "https://b.example.com/path/");
  assert.equal(a.ok && b.ok, true);
  if (!a.ok || !b.ok) return;
  assert.equal(removeSite(store, a.site.id), true);
  assert.equal(getSite(store, a.site.id), undefined);
  assert.equal(removeSite(store, "https://B.example.com/path"), true);
  assert.equal(listSites(store).length, 0);
  assert.equal(removeSite(store, 999), false);
  assert.equal(removeSite(store, "https://never-added.example.com/"), false);
});

test("the cursor tracks blocks already seen, capped, and survives a reopen", async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aha-sites-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let store = openStore(dir);
  const added = addSite(store, "https://example.com/");
  assert.equal(added.ok, true);
  if (!added.ok) return;
  assert.deepEqual(getCursor(store, added.site.id), []);
  saveCursor(store, added.site.id, ["h1", "h2"]);
  assert.deepEqual(getCursor(store, added.site.id), ["h1", "h2"]);
  const many = Array.from({ length: 600 }, (_, i) => `h${i}`);
  saveCursor(store, added.site.id, many);
  assert.equal(getCursor(store, added.site.id).length, 500);
  assert.deepEqual(getCursor(store, added.site.id).slice(-2), ["h598", "h599"]);
  store.close();
  store = openStore(dir);
  assert.equal(getCursor(store, added.site.id).length, 500);
  store.close();
});

test("recordSiteRun updates status without touching the cursor", async t => {
  const store = await home(t);
  const added = addSite(store, "https://example.com/");
  assert.equal(added.ok, true);
  if (!added.ok) return;
  saveCursor(store, added.site.id, ["h1"]);
  const now = new Date("2026-09-26T09:00:00.000Z");
  recordSiteRun(store, added.site.id, "degraded", "unavailable: Latch is not connected", now);
  const site = getSite(store, added.site.id)!;
  assert.deepEqual({ lastRunAt: site.lastRunAt, lastStatus: site.lastStatus, lastDetail: site.lastDetail }, {
    lastRunAt: now.toISOString(), lastStatus: "degraded", lastDetail: "unavailable: Latch is not connected",
  });
  assert.deepEqual(getCursor(store, added.site.id), ["h1"]);
});
