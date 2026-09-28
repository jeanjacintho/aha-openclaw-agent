import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { saveConfig } from "../aha/config.ts";
import { writeSecrets } from "../aha/secrets.ts";
import { runWorkerStages } from "../aha/worker.ts";
import { REDDIT_RECONCILE_CLOCK_SKEW_MS, REDDIT_RECONCILE_GRACE_MS, REDDIT_RECONCILE_LIMIT, REDDIT_RECONCILE_MAX_AGE_MS, REDDIT_STALE_POSTING_MS, reconcileRedditPosts } from "../aha/responder/reconcile.ts";
import { recordDraftEvent } from "../aha/responder/draft-events.ts";
import { checkPolicy } from "../aha/responder/policy.ts";
import { postReply } from "../aha/responder/post.ts";
import { openStore } from "../aha/store/db.ts";

const NOW = new Date("2026-09-23T12:00:00.000Z");
const BODY = "Thanks for asking about Plow queues.\n— AHA, AI assistant of Plow";
const ITEM_URL = "https://www.reddit.com/r/testaha/comments/xyz/title/abc/";
const environment = { ...process.env };

function env(t: import("node:test").TestContext, values: Record<string, string | undefined>) {
  t.after(() => {
    for (const key of Object.keys({ ...values, ...process.env })) {
      if (key in environment) process.env[key] = environment[key];
      else delete process.env[key];
    }
  });
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function fixture(t: import("node:test").TestContext, options: {
  attemptAgoMs?: number; posts?: number; uncertainDelayMs?: number; ledgerState?: "uncertain" | "posting";
} = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aha-reconcile-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  env(t, { AHA_HOME: dir, PLOW_API_BASE: "http://plow.test", PLOW_AGENT_TOKEN: "tok" });
  const store = openStore(dir);
  t.after(() => store.close());
  saveConfig(store, { company: { name: "Plow", aliases: ["plow"] }, language: "en", ownerChatUid: "cht_dm" });
  writeSecrets(dir, { reddit: { clientId: "id", clientSecret: "secret", username: "aha", password: "secret" } });
  const attemptAt = new Date(NOW.getTime() - (options.attemptAgoMs ?? 20 * 60 * 1000));
  const posts: { itemId: number; draftId: number; postKey: string; threadKey: string; externalId: string }[] = [];
  for (let i = 0; i < (options.posts ?? 1); i++) {
    const externalId = i === 0 ? "t1_abc" : `t1_item${i}`;
    const itemUrl = i === 0 ? ITEM_URL : `https://www.reddit.com/r/testaha/comments/post${i}/title/`;
    store.db.prepare(`INSERT INTO items (source, external_id, url, author, title, body, published_at, fetched_at, state)
      VALUES ('reddit', ?, ?, 'bob', 'Title', 'Does plow queue jobs?', ?, ?, 'relevant')`)
      .run(externalId, itemUrl, attemptAt.toISOString(), attemptAt.toISOString());
    const itemId = Number((store.db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id);
    store.db.prepare(`INSERT INTO classifications (item_id, sentiment, category, topic, language, is_question, urgency, about, confidence)
      VALUES (?, 0, 'question', 'queues', 'en', 1, 'low', 'self', 0.9)`).run(itemId);
    const hash = createHash("sha256").update(BODY).digest("hex");
    store.db.prepare(`INSERT INTO drafts (item_id, body, state, approved_sha256, approved_at)
      VALUES (?, ?, 'approved', ?, ?)`)
      .run(itemId, BODY, hash, attemptAt.toISOString());
    const draftId = Number((store.db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id);
    recordDraftEvent(store, { draftId, itemId, actor: "owner", action: "approved", body: BODY, at: attemptAt });
    const postKey = `post:2026-09-23:reddit:testaha:${externalId}`;
    const threadKey = `thread:reddit:t3_${i === 0 ? "xyz" : `post${i}`}`;
    const ledgerState = options.ledgerState ?? "uncertain";
    store.db.prepare("INSERT INTO ledger (key, state, url) VALUES (?, ?, ?)").run(postKey, ledgerState, itemUrl);
    store.db.prepare("INSERT INTO ledger (key, state, url) VALUES (?, ?, ?)").run(threadKey, ledgerState, itemUrl);
    if (ledgerState === "uncertain") {
      recordDraftEvent(store, {
        draftId, itemId, actor: "system", action: "uncertain", body: BODY,
        at: new Date(attemptAt.getTime() + (options.uncertainDelayMs ?? 0)),
      });
    }
    posts.push({ itemId, draftId, postKey, threadKey, externalId });
  }
  return { store, posts, attemptAt };
}

function commentFor(post: { externalId: string }, createdAt: number, body = BODY) {
  return {
    name: "t1_reconciled", parent_id: post.externalId, body, author: "aha",
    created_utc: createdAt / 1000, permalink: "/r/testaha/comments/xyz/title/reconciled/",
  };
}

function jsonListing(comments: unknown[]) {
  return Response.json({ data: { children: comments.map(data => ({ kind: "t1", data })) } });
}

function state(store: ReturnType<typeof openStore>, key: string) {
  return (store.db.prepare("SELECT state, url FROM ledger WHERE key = ?").get(key) as { state: string; url: string | null });
}

function latestEvent(store: ReturnType<typeof openStore>, draftId: number) {
  return store.db.prepare("SELECT action, detail FROM draft_events WHERE draft_id = ? ORDER BY id DESC LIMIT 1").get(draftId) as {
    action: string; detail: string | null;
  };
}

function makeFetcher(listing: () => Response) {
  const urls: string[] = [];
  const messages: string[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    urls.push(url);
    if (url.includes("/comments?")) {
      assert.ok(init?.signal instanceof AbortSignal);
      assert.match(url, /sort=new&limit=100/);
      return listing();
    }
    if (url.includes("/messages")) {
      messages.push(String(init?.body ?? ""));
      return Response.json({ uid: `message-${messages.length}` });
    }
    return new Response("not found", { status: 404 });
  };
  return { fetch, urls, messages };
}

const testAuth = { token: async () => "access-token", invalidate() {}, canPost: true };

test("an uncertain Reddit post found in the user's comments becomes verified and notifies once", async t => {
  const { store, posts, attemptAt } = await fixture(t, { uncertainDelayMs: 30_000 });
  const fetch = makeFetcher(() => jsonListing([commentFor(posts[0], attemptAt.getTime() + 10_000)]));
  const deps = { auth: testAuth, fetch: fetch.fetch, now: () => NOW };
  const result = await reconcileRedditPosts(store, deps);
  assert.deepEqual(result, { checked: 1, reconciled: 1, absent: 0, expired: 0 });
  assert.equal(state(store, posts[0].postKey).state, "verified");
  assert.equal(state(store, posts[0].threadKey).state, "verified");
  assert.match(state(store, posts[0].postKey).url ?? "", /reconciled/);
  assert.deepEqual({ ...latestEvent(store, posts[0].draftId) }, { action: "reconciled", detail: null });
  assert.equal(fetch.messages.length, 1);
  assert.match(JSON.parse(fetch.messages[0]).body, /publication confirmed/);
  await reconcileRedditPosts(store, deps);
  assert.equal(fetch.urls.filter(url => url.includes("/comments?")).length, 1);
  assert.equal(fetch.messages.length, 1);
});

test("a comment created before the uncertain event but after approval is still found", async t => {
  const { store, posts, attemptAt } = await fixture(t, { uncertainDelayMs: 30_000 });
  const fetch = makeFetcher(() => jsonListing([commentFor(posts[0], attemptAt.getTime() + 10_000)]));
  const result = await reconcileRedditPosts(store, { auth: testAuth, fetch: fetch.fetch, now: () => NOW });
  assert.deepEqual(result, { checked: 1, reconciled: 1, absent: 0, expired: 0 });
  assert.equal(state(store, posts[0].postKey).state, "verified");
});

test("a comment older than approved_at minus the clock margin does not match", async t => {
  const { store, posts, attemptAt } = await fixture(t, { uncertainDelayMs: 30_000 });
  const fetch = makeFetcher(() => jsonListing([commentFor(posts[0], attemptAt.getTime() - REDDIT_RECONCILE_CLOCK_SKEW_MS - 1000)]));
  const result = await reconcileRedditPosts(store, { auth: testAuth, fetch: fetch.fetch, now: () => NOW });
  assert.deepEqual(result, { checked: 1, reconciled: 0, absent: 1, expired: 0 });
  assert.equal(state(store, posts[0].postKey).state, "absent");
  assert.equal(latestEvent(store, posts[0].draftId).action, "absent");
});

test("an old posting ledger is frozen as uncertain and reconciled", async t => {
  const { store, posts, attemptAt } = await fixture(t, { ledgerState: "posting" });
  const fetch = makeFetcher(() => jsonListing([commentFor(posts[0], attemptAt.getTime() + 10_000)]));
  const result = await reconcileRedditPosts(store, { auth: testAuth, fetch: fetch.fetch, now: () => NOW });
  assert.deepEqual(result, { checked: 1, reconciled: 1, absent: 0, expired: 0 });
  const events = store.db.prepare(`SELECT action, detail FROM draft_events WHERE draft_id = ? ORDER BY id`).all(posts[0].draftId) as {
    action: string; detail: string | null;
  }[];
  assert.deepEqual(events.map(event => [event.action, event.detail]), [["approved", null], ["uncertain", "stale_posting"], ["reconciled", null]]);
  assert.equal(state(store, posts[0].postKey).state, "verified");
});

test("a recent posting ledger is left alone while its send may still be in progress", async t => {
  const { store, posts } = await fixture(t, { attemptAgoMs: REDDIT_STALE_POSTING_MS - 1000, ledgerState: "posting" });
  const fetch = makeFetcher(() => { throw new Error("must not list while posting is recent"); });
  const result = await reconcileRedditPosts(store, { auth: testAuth, fetch: fetch.fetch, now: () => NOW });
  assert.deepEqual(result, { checked: 0, reconciled: 0, absent: 0, expired: 0 });
  assert.equal(state(store, posts[0].postKey).state, "posting");
  assert.equal(fetch.urls.length, 0);
  assert.equal(latestEvent(store, posts[0].draftId).action, "approved");
});

test("a covered listing after the grace period marks a post absent", async t => {
  const { store, posts } = await fixture(t);
  const fetch = makeFetcher(() => jsonListing([]));
  const result = await reconcileRedditPosts(store, { auth: testAuth, fetch: fetch.fetch, now: () => NOW });
  assert.deepEqual(result, { checked: 1, reconciled: 0, absent: 1, expired: 0 });
  assert.equal(state(store, posts[0].postKey).state, "absent");
  assert.equal(state(store, posts[0].threadKey).state, "absent");
  assert.deepEqual({ ...latestEvent(store, posts[0].draftId) }, { action: "absent", detail: null });
  assert.equal(fetch.messages.length, 1);
  assert.match(JSON.parse(fetch.messages[0]).body, /was not found/);
  assert.equal(await postReply(store, posts[0].draftId, { auth: testAuth, fetch: fetch.fetch, now: () => NOW }), "failed");
  assert.equal(state(store, posts[0].postKey).state, "absent");

  store.db.prepare(`INSERT INTO items (source, external_id, url, author, title, body, published_at, fetched_at, state)
    VALUES ('reddit', 't1_other', ?, 'bob', 'Title', 'Does plow queue jobs?', ?, ?, 'relevant')`)
    .run(ITEM_URL, NOW.toISOString(), NOW.toISOString());
  const itemId = Number((store.db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id);
  store.db.prepare(`INSERT INTO classifications (item_id, sentiment, category, topic, language, is_question, urgency, about, confidence)
    VALUES (?, 0, 'question', 'queues', 'en', 1, 'low', 'self', 0.9)`).run(itemId);
  const draft = { id: 999, itemId, body: BODY, state: "pending" };
  assert.deepEqual(checkPolicy(store, draft, NOW), { allow: true });
});

test("a full listing that does not reach the attempt time keeps the post uncertain", async t => {
  const { store, posts, attemptAt } = await fixture(t);
  const recent = Array.from({ length: REDDIT_RECONCILE_LIMIT }, (_, i) => commentFor(posts[0], attemptAt.getTime() + 60_000 + i * 1000, `other ${i}`));
  const fetch = makeFetcher(() => jsonListing(recent));
  const result = await reconcileRedditPosts(store, { auth: testAuth, fetch: fetch.fetch, now: () => NOW });
  assert.deepEqual(result, { checked: 1, reconciled: 0, absent: 0, expired: 0 });
  assert.equal(state(store, posts[0].postKey).state, "uncertain");
  assert.equal(fetch.messages.length, 0);
});

test("a successful but empty listing inside the grace period keeps the post uncertain", async t => {
  const { store, posts } = await fixture(t, { attemptAgoMs: REDDIT_RECONCILE_GRACE_MS - 1000 });
  const fetch = makeFetcher(() => jsonListing([]));
  const result = await reconcileRedditPosts(store, { auth: testAuth, fetch: fetch.fetch, now: () => NOW });
  assert.deepEqual(result, { checked: 1, reconciled: 0, absent: 0, expired: 0 });
  assert.equal(state(store, posts[0].postKey).state, "uncertain");
  assert.equal(fetch.messages.length, 0);
});

test("a failed comments listing keeps every post uncertain", async t => {
  const { store, posts } = await fixture(t);
  const fetch = makeFetcher(() => new Response("unavailable", { status: 503 }));
  const result = await reconcileRedditPosts(store, { auth: testAuth, fetch: fetch.fetch, now: () => NOW });
  assert.deepEqual(result, { checked: 1, reconciled: 0, absent: 0, expired: 0 });
  assert.equal(state(store, posts[0].postKey).state, "uncertain");
  assert.equal(fetch.messages.length, 0);
});

test("uncertain posts expire once after 48 hours without a conclusion", async t => {
  const { store, posts } = await fixture(t, { attemptAgoMs: REDDIT_RECONCILE_MAX_AGE_MS + 1000 });
  const fetch = makeFetcher(() => { throw new Error("must not list expired posts"); });
  const deps = { auth: testAuth, fetch: fetch.fetch, now: () => NOW };
  assert.deepEqual(await reconcileRedditPosts(store, deps), { checked: 0, reconciled: 0, absent: 0, expired: 1 });
  assert.equal(state(store, posts[0].postKey).state, "uncertain");
  assert.deepEqual({ ...latestEvent(store, posts[0].draftId) }, { action: "reconcile_expired", detail: null });
  assert.deepEqual(await reconcileRedditPosts(store, deps), { checked: 0, reconciled: 0, absent: 0, expired: 0 });
  assert.equal(fetch.urls.length, 0);
});

test("one comments listing reconciles every uncertain Reddit post in the cycle", async t => {
  const { store, posts, attemptAt } = await fixture(t, { posts: 3 });
  const fetch = makeFetcher(() => jsonListing(posts.map(post => commentFor(post, attemptAt.getTime() + 60_000))));
  const result = await reconcileRedditPosts(store, { auth: testAuth, fetch: fetch.fetch, now: () => NOW });
  assert.deepEqual(result, { checked: 3, reconciled: 3, absent: 0, expired: 0 });
  assert.equal(fetch.urls.filter(url => url.includes("/comments?")).length, 1);
  assert.equal(fetch.messages.length, 3);
  for (const post of posts) {
    assert.equal(state(store, post.postKey).state, "verified");
    assert.deepEqual({ ...latestEvent(store, post.draftId) }, { action: "reconciled", detail: null });
  }
});

test("a Reddit reconciliation stage failure is logged and later worker stages continue", async t => {
  const errors: string[] = [];
  const completed: string[] = [];
  t.mock.method(console, "error", (line: string) => errors.push(line));
  await runWorkerStages([
    { name: "reddit reconciliation", run: () => { throw new Error("list failed"); } },
    { name: "notification retries", run: () => { completed.push("notification retries"); } },
  ]);
  assert.deepEqual(errors, ["aha: worker stage reddit reconciliation failed: list failed"]);
  assert.deepEqual(completed, ["notification retries"]);
});
