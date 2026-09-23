import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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

function chat(participants: number) {
  return { uid: "cht_1", participants: Array.from({ length: participants }, (_, i) => ({ type: i === 0 ? "agent" : "member", uid: `p${i}` })) };
}

test("the same key is delivered once", async t => {
  const store = await home(t);
  const posts: string[] = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "POST") posts.push(url);
    return new Response(JSON.stringify({ uid: "msg_1", participants: chat(2).participants }), { status: 200 });
  };
  assert.equal(await sendToChat("cht_dm", "hello", "k1", { store, fetch: fetchImpl }), "sent");
  assert.equal(await sendToChat("cht_dm", "hello", "k1", { store, fetch: fetchImpl }), "duplicate");
  assert.equal(posts.length, 1);
  assert.equal((store.db.prepare("SELECT COUNT(*) AS n FROM deliveries").get() as { n: number }).n, 1);
});

test("uncertain is not resent", async t => {
  const store = await home(t);
  let posts = 0;
  const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST") {
      posts += 1;
      return new Response("", { status: 500 });
    }
    return new Response(JSON.stringify(chat(2)), { status: 200 });
  };
  assert.equal(await sendToChat("cht_dm", "hello", "k2", { store, fetch: fetchImpl }), "uncertain");
  assert.equal(await sendToChat("cht_dm", "hello", "k2", { store, fetch: fetchImpl }), "uncertain");
  assert.equal(posts, 1);
});

test("PAUSE blocks group sends and still allows the owner DM", async t => {
  const store = await home(t);
  store.db.prepare("UPDATE flags SET paused = 1").run();
  const posts: string[] = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/chats/cht_group")) return new Response(JSON.stringify(chat(3)), { status: 200 });
    if (url.endsWith("/chats/cht_dm")) return new Response(JSON.stringify(chat(2)), { status: 200 });
    if (init?.method === "POST") {
      posts.push(url);
      return new Response(JSON.stringify({ uid: "msg_2" }), { status: 200 });
    }
    return new Response("", { status: 404 });
  };
  assert.equal(await sendToChat("cht_group", "hi", "kg", { store, fetch: fetchImpl }), "failed");
  assert.equal(await sendToChat("cht_dm", "hi", "kd", { store, fetch: fetchImpl }), "sent");
  assert.deepEqual(posts, ["http://plow.test/v1/chats/cht_dm/messages"]);
});
