import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { saveConfig } from "../aha/config.ts";
import { DELIVERY_MAX_AGE_MS, DELIVERY_RETRY_GRACE_MS, retryUncertainDeliveries, sendToChat } from "../aha/notify/plow.ts";
import { openStore } from "../aha/store/db.ts";

const environment = { ...process.env };
function env(t: import("node:test").TestContext, values: Record<string, string | undefined>) {
  t.after(() => { for (const key of Object.keys({ ...values, ...process.env })) if (key in environment) process.env[key] = environment[key]; else delete process.env[key]; });
  for (const [key, value] of Object.entries(values)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
}

async function home(t: import("node:test").TestContext) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aha-notify-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  env(t, { AHA_HOME: dir, PLOW_API_BASE: "http://plow.test", PLOW_AGENT_TOKEN: "tok" });
  const store = openStore(dir);
  t.after(() => store.close());
  return store;
}

test("the same key is delivered once", async t => {
  const store = await home(t);
  const posts: string[] = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "POST") posts.push(url);
    return new Response(JSON.stringify({ uid: "msg_1" }), { status: 200 });
  };
  assert.equal(await sendToChat("cht_dm", "hello", "k1", { store, fetch: fetchImpl }), "sent");
  assert.equal(await sendToChat("cht_dm", "hello", "k1", { store, fetch: fetchImpl }), "duplicate");
  assert.equal(posts.length, 1);
  assert.equal((store.db.prepare("SELECT COUNT(*) AS n FROM deliveries").get() as { n: number }).n, 1);
  assert.equal((store.db.prepare("SELECT body FROM deliveries WHERE key = 'k1'").get() as { body: string | null }).body, null);
});

test("two overlapping sends with the same key post once", async t => {
  const store = await home(t);
  let posts = 0;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST") {
      posts += 1;
      await held;
      return new Response(JSON.stringify({ uid: "msg_race" }), { status: 200 });
    }
    return new Response("", { status: 404 });
  };
  const first = sendToChat("cht_dm", "hello", "k-race", { store, fetch: fetchImpl });
  const second = sendToChat("cht_dm", "hello", "k-race", { store, fetch: fetchImpl });
  assert.equal(posts, 1);
  assert.equal((store.db.prepare("SELECT status FROM deliveries WHERE key = 'k-race'").get() as { status: string }).status, "uncertain");
  release();
  const results = await Promise.all([first, second]);
  assert.equal(posts, 1);
  assert.ok(results.includes("sent"));
  assert.ok(results.includes("uncertain"));
  assert.equal((store.db.prepare("SELECT status FROM deliveries WHERE key = 'k-race'").get() as { status: string }).status, "sent");
});

test("uncertain is not resent", async t => {
  const store = await home(t);
  let posts = 0;
  const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST") {
      posts += 1;
      return new Response("", { status: 500 });
    }
    return new Response("", { status: 404 });
  };
  assert.equal(await sendToChat("cht_dm", "hello", "k2", { store, fetch: fetchImpl }), "uncertain");
  assert.equal(await sendToChat("cht_dm", "hello", "k2", { store, fetch: fetchImpl }), "uncertain");
  assert.equal(posts, 1);
});

test("an uncertain delivery is blocked during grace and can be reclaimed after it", async t => {
  const store = await home(t);
  const now = new Date("2026-09-23T12:00:00.000Z");
  const insert = store.db.prepare(`INSERT INTO deliveries (key, chat_uid, status, created_at, updated_at, body)
    VALUES (?, 'cht_dm', 'uncertain', ?, ?, 'hello')`);
  const recentAt = new Date(now.getTime() - DELIVERY_RETRY_GRACE_MS + 1).toISOString();
  insert.run("k-recent", recentAt, recentAt);
  const oldAt = new Date(now.getTime() - DELIVERY_RETRY_GRACE_MS - 1).toISOString();
  insert.run("k-old", oldAt, oldAt);
  const posts: string[] = [];
  const fetchImpl = async (input: RequestInfo | URL) => {
    posts.push(String(input));
    return Response.json({ uid: "msg_retry" });
  };

  assert.equal(await sendToChat("cht_dm", "hello", "k-recent", { store, fetch: fetchImpl, now: () => now }), "uncertain");
  assert.equal(await sendToChat("cht_dm", "hello", "k-old", { store, fetch: fetchImpl, now: () => now }), "sent");
  assert.equal(posts.length, 1);
});

test("periodic retry resends stale uncertain deliveries with their stored body", async t => {
  const store = await home(t);
  const now = new Date("2026-09-23T12:00:00.000Z");
  const at = new Date(now.getTime() - DELIVERY_RETRY_GRACE_MS - 1).toISOString();
  store.db.prepare(`INSERT INTO deliveries (key, chat_uid, status, created_at, updated_at, body)
    VALUES ('k-periodic', 'cht_dm', 'uncertain', ?, ?, 'persisted text')`).run(at, at);
  store.db.prepare(`INSERT INTO deliveries (key, chat_uid, status, created_at, updated_at, body)
    VALUES ('k-failed-periodic', 'cht_dm', 'failed', ?, ?, 'do not retry')`).run(at, at);
  let body = "";
  const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit) => {
    body = JSON.parse(String(init?.body)).body;
    return Response.json({ uid: "msg_retry" });
  };

  assert.equal(await retryUncertainDeliveries(store, now, { fetch: fetchImpl }), 1);
  assert.equal(body, "persisted text");
  assert.equal((store.db.prepare("SELECT status FROM deliveries WHERE key = 'k-periodic'").get() as { status: string }).status, "sent");
  assert.equal((store.db.prepare("SELECT status FROM deliveries WHERE key = 'k-failed-periodic'").get() as { status: string }).status, "failed");
});

test("periodic retry discards uncertain deliveries after 24 hours and clears their body", async t => {
  const store = await home(t);
  const now = new Date("2026-09-23T12:00:00.000Z");
  const at = new Date(now.getTime() - DELIVERY_MAX_AGE_MS - 1).toISOString();
  store.db.prepare(`INSERT INTO deliveries (key, chat_uid, status, created_at, updated_at, body)
    VALUES ('k-expired', 'cht_dm', 'uncertain', ?, ?, 'expired body')`).run(at, at);
  let posts = 0;
  const fetchImpl = async () => {
    posts += 1;
    return Response.json({ uid: "unexpected" });
  };

  assert.equal(await retryUncertainDeliveries(store, now, { fetch: fetchImpl }), 0);
  const row = store.db.prepare("SELECT status, body FROM deliveries WHERE key = 'k-expired'").get() as { status: string; body: string | null };
  assert.equal(row.status, "failed");
  assert.equal(row.body, null);
  assert.equal(posts, 0);
});

test("a fetch timeout returns uncertain instead of hanging", async t => {
  const store = await home(t);
  const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit) => await new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) return reject(new Error("signal missing"));
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    if (signal.aborted) reject(signal.reason);
  });

  assert.equal(await sendToChat("cht_dm", "hello", "k-timeout", { store, fetch: fetchImpl, timeoutMs: 5 }), "uncertain");
  assert.equal((store.db.prepare("SELECT status FROM deliveries WHERE key = 'k-timeout'").get() as { status: string }).status, "uncertain");
});

test("HTTP 200 with a non-JSON body is terminal even after the grace period", async t => {
  const store = await home(t);
  const now = new Date("2026-09-23T12:00:00.000Z");
  let posts = 0;
  const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST") {
      posts += 1;
      return new Response("not-json", { status: 200 });
    }
    return new Response("", { status: 404 });
  };
  assert.equal(await sendToChat("cht_dm", "hello", "k-json", { store, fetch: fetchImpl, now: () => now }), "sent");
  assert.equal(await sendToChat("cht_dm", "hello", "k-json", { store, fetch: fetchImpl, now: () => new Date(now.getTime() + DELIVERY_RETRY_GRACE_MS + 1) }), "duplicate");
  assert.equal(await retryUncertainDeliveries(store, new Date(now.getTime() + DELIVERY_RETRY_GRACE_MS + 1), { fetch: fetchImpl }), 0);
  assert.equal(posts, 1);
  assert.equal((store.db.prepare("SELECT body FROM deliveries WHERE key = 'k-json'").get() as { body: string | null }).body, null);
});

test("a failed key is retried", async t => {
  const store = await home(t);
  let posts = 0;
  const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST") {
      posts += 1;
      if (posts === 1) return new Response("", { status: 400 });
      return new Response(JSON.stringify({ uid: "msg_retry" }), { status: 200 });
    }
    return new Response("", { status: 404 });
  };
  assert.equal(await sendToChat("cht_dm", "hello", "k-fail", { store, fetch: fetchImpl }), "failed");
  assert.equal((store.db.prepare("SELECT body FROM deliveries WHERE key = 'k-fail'").get() as { body: string | null }).body, null);
  assert.equal(await sendToChat("cht_dm", "hello", "k-fail", { store, fetch: fetchImpl }), "sent");
  assert.equal(posts, 2);
});

test("PAUSE blocks every chat except the configured owner DM and does not GET chats", async t => {
  const store = await home(t);
  saveConfig(store, { company: { name: "Plow" }, ownerChatUid: "cht_dm" });
  store.db.prepare("UPDATE flags SET paused = 1").run();
  const urls: string[] = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    urls.push(`${init?.method ?? "GET"} ${String(input)}`);
    if (init?.method === "POST") return new Response(JSON.stringify({ uid: "msg_2" }), { status: 200 });
    return new Response("", { status: 404 });
  };
  assert.equal(await sendToChat("cht_group", "hi", "kg", { store, fetch: fetchImpl }), "failed");
  assert.equal(await sendToChat("cht_dm", "hi", "kd", { store, fetch: fetchImpl }), "sent");
  assert.deepEqual(urls, ["POST http://plow.test/v1/chats/cht_dm/messages"]);
});
