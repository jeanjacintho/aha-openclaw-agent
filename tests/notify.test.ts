import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { saveConfig } from "../aha/config.ts";
import { sendToChat } from "../aha/notify/plow.ts";
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

test("HTTP 200 with a non-JSON body stays uncertain and is not posted again", async t => {
  const store = await home(t);
  let posts = 0;
  const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST") {
      posts += 1;
      return new Response("not-json", { status: 200 });
    }
    return new Response("", { status: 404 });
  };
  assert.equal(await sendToChat("cht_dm", "hello", "k-json", { store, fetch: fetchImpl }), "uncertain");
  assert.equal(await sendToChat("cht_dm", "hello", "k-json", { store, fetch: fetchImpl }), "uncertain");
  assert.equal(posts, 1);
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
