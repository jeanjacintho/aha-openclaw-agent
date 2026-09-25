import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { saveConfig } from "../aha/config.ts";
import { writeSecrets } from "../aha/secrets.ts";
import { autonomyLevel, confirmAutonomy, itemAutonomy, L2_STREAK, recordDecision } from "../aha/responder/autonomy.ts";
import { draftAndNotify } from "../aha/responder/drafts.ts";
import { postReply, redditSubreddit } from "../aha/responder/post.ts";
import { clearRedditTokenCache, redditAuth } from "../aha/sources/reddit-auth.ts";
import { REDDIT_USER_AGENT } from "../aha/sources/reddit.ts";
import { openStore } from "../aha/store/db.ts";
import { type Draft } from "../aha/responder/drafts.ts";

async function home(t: import("node:test").TestContext) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aha-reddit-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const previous = process.env.AHA_HOME;
  t.after(() => {
    if (previous === undefined) delete process.env.AHA_HOME;
    else process.env.AHA_HOME = previous;
  });
  process.env.AHA_HOME = dir;
  const store = openStore(dir);
  t.after(() => store.close());
  saveConfig(store, { company: { name: "Plow", aliases: ["plow"] }, language: "en", ownerChatUid: "cht_dm" });
  writeSecrets(dir, { reddit: "reddit_user_token" });
  return { store, dir };
}

function seedReddit(store: ReturnType<typeof openStore>, over: { externalId?: string; category?: string; source?: string; url?: string } = {}) {
  const source = over.source ?? "reddit";
  const url = over.url ?? "https://www.reddit.com/r/testaha/comments/xyz/title/abc/";
  store.db.prepare(`INSERT INTO items (source, external_id, url, author, title, body, published_at, fetched_at, state)
    VALUES (?, ?, ?, 'bob', 't', 'Does plow queue jobs?', '2026-09-22T12:00:00.000Z', '2026-09-22T12:00:00.000Z', 'relevant')`)
    .run(source, over.externalId ?? "t1_abc", url);
  const itemId = Number((store.db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id);
  store.db.prepare(`INSERT INTO classifications (item_id, sentiment, category, topic, language, is_question, urgency, about, confidence)
    VALUES (?, 0, ?, 'queues', 'en', 1, 'low', 'self', 0.9)`).run(itemId, over.category ?? "question");
  store.db.prepare("INSERT INTO drafts (item_id, body, state) VALUES (?, ?, 'pending')")
    .run(itemId, "Thanks for asking about Plow queues.\n— AHA, AI assistant of Plow");
  const draft = store.db.prepare("SELECT id, item_id AS itemId, body, state FROM drafts WHERE item_id = ?").get(itemId) as Draft;
  return { itemId, draft };
}

const posted = {
  json: { errors: [], data: { things: [{ data: { name: "t1_posted", permalink: "/r/testaha/comments/xyz/title/posted/" } }] } },
};
const verified = { data: { children: [{ data: { name: "t1_posted" } }] } };

test("redditSubreddit reads r/name from the permalink", () => {
  assert.equal(redditSubreddit("https://www.reddit.com/r/testaha/comments/xyz/title/abc/"), "testaha");
});

test("five unchanged approvals suggest L2 and the owner must confirm", async t => {
  const { store } = await home(t);
  const { draft } = seedReddit(store);
  let suggested = 0;
  for (let i = 0; i < L2_STREAK; i++) {
    const result = recordDecision(store, draft, "approved");
    if (result.suggest) suggested += 1;
  }
  assert.equal(suggested, 1);
  assert.equal(autonomyLevel(store, "reddit", "question"), "L1");
  assert.deepEqual(confirmAutonomy(store, "reddit", "question"), { ok: true, level: "L2" });
  assert.equal(autonomyLevel(store, "reddit", "question"), "L2");
});

test("an edit or ignore drops autonomy to L1 immediately", async t => {
  const { store } = await home(t);
  const { draft } = seedReddit(store);
  for (let i = 0; i < L2_STREAK; i++) recordDecision(store, draft, "approved");
  confirmAutonomy(store, "reddit", "question");
  assert.equal(autonomyLevel(store, "reddit", "question"), "L2");
  recordDecision(store, draft, "edited");
  assert.equal(autonomyLevel(store, "reddit", "question"), "L1");
  for (let i = 0; i < L2_STREAK + 1; i++) recordDecision(store, draft, "approved");
  confirmAutonomy(store, "reddit", "question");
  recordDecision(store, draft, "ignored");
  assert.equal(autonomyLevel(store, "reddit", "question"), "L1");
  for (let i = 0; i < L2_STREAK; i++) recordDecision(store, draft, "approved");
  confirmAutonomy(store, "reddit", "question");
  assert.equal(autonomyLevel(store, "reddit", "question"), "L2");
});

test("postReply writes posting then posted and verifies", async t => {
  const { store } = await home(t);
  const { draft } = seedReddit(store);
  const urls: string[] = [];
  const result = await postReply(store, draft.id, {
    token: "reddit_user_token",
    now: () => new Date("2026-09-23T12:00:00.000Z"),
    fetch: async (input, init) => {
      urls.push(`${init?.method ?? "GET"} ${String(input)}`);
      const h = new Headers(init?.headers);
      assert.equal(h.get("authorization"), "Bearer reddit_user_token");
      assert.equal(h.get("user-agent"), REDDIT_USER_AGENT);
      if (String(input).includes("/api/comment")) return Response.json(posted);
      return Response.json(verified);
    },
  });
  assert.equal(result, "posted");
  assert.match(urls[0], /POST https:\/\/oauth.reddit.com\/api\/comment/);
  const row = store.db.prepare("SELECT state FROM ledger WHERE key = ?").get("post:2026-09-23:reddit:testaha:t1_abc") as { state: string };
  assert.equal(row.state, "verified");
});

test("uncertain ledger is never posted again", async t => {
  const { store } = await home(t);
  const { draft } = seedReddit(store);
  store.db.prepare("INSERT INTO ledger (key, state, url) VALUES ('post:2026-09-23:reddit:testaha:t1_abc', 'uncertain', NULL)").run();
  let called = 0;
  const result = await postReply(store, draft.id, {
    token: "tok",
    now: () => new Date("2026-09-23T12:00:00.000Z"),
    fetch: async () => {
      called += 1;
      return Response.json(posted);
    },
  });
  assert.equal(result, "uncertain");
  assert.equal(called, 0);
});

test("a network error after the send is uncertain, not failed, and never retries HTTP", async t => {
  const { store } = await home(t);
  const { draft } = seedReddit(store);
  let called = 0;
  const first = await postReply(store, draft.id, {
    token: "tok",
    now: () => new Date("2026-09-23T12:00:00.000Z"),
    fetch: async () => {
      called += 1;
      throw new Error("socket hang up");
    },
  });
  assert.equal(first, "uncertain");
  assert.equal(called, 1);
  const row = store.db.prepare("SELECT state FROM ledger WHERE key = ?").get("post:2026-09-23:reddit:testaha:t1_abc") as { state: string };
  assert.equal(row.state, "uncertain");
  const second = await postReply(store, draft.id, {
    token: "tok",
    now: () => new Date("2026-09-23T12:00:00.000Z"),
    fetch: async () => {
      called += 1;
      return Response.json(posted);
    },
  });
  assert.equal(second, "uncertain");
  assert.equal(called, 1);
});

test("PAUSE blocks L2 posting", async t => {
  const { store } = await home(t);
  const { draft } = seedReddit(store);
  store.db.prepare("UPDATE flags SET paused = 1").run();
  let called = 0;
  const result = await postReply(store, draft.id, {
    token: "tok",
    fetch: async () => {
      called += 1;
      return Response.json(posted);
    },
  });
  assert.equal(result, "failed");
  assert.equal(called, 0);
  assert.equal(itemAutonomy(store, "self", "reddit", "question"), "L1");
});

test("Reddit token comes from secrets, never from a prompt string", async t => {
  const { store, dir } = await home(t);
  const { draft } = seedReddit(store);
  const auths: string[] = [];
  await postReply(store, draft.id, {
    now: () => new Date("2026-09-23T12:00:00.000Z"),
    fetch: async (_input, init) => {
      auths.push(new Headers(init?.headers).get("authorization") ?? "");
      return Response.json(posted);
    },
  });
  assert.deepEqual(auths.filter(value => value.includes("reddit_user_token")), ["Bearer reddit_user_token", "Bearer reddit_user_token"]);
  const prompt = await fs.readFile(new URL("../prompt/AGENTS.md", import.meta.url), "utf8");
  assert.equal(prompt.includes("reddit_user_token"), false);
  const secrets = JSON.parse(await fs.readFile(path.join(dir, "secrets.json"), "utf8")) as { reddit: string };
  assert.equal(secrets.reddit, "reddit_user_token");
});

function plowEnv(t: import("node:test").TestContext) {
  const prevBase = process.env.PLOW_API_BASE;
  const prevTok = process.env.PLOW_AGENT_TOKEN;
  process.env.PLOW_API_BASE = "http://plow.test";
  process.env.PLOW_AGENT_TOKEN = "tok";
  t.after(() => {
    if (prevBase === undefined) delete process.env.PLOW_API_BASE; else process.env.PLOW_API_BASE = prevBase;
    if (prevTok === undefined) delete process.env.PLOW_AGENT_TOKEN; else process.env.PLOW_AGENT_TOKEN = prevTok;
  });
}

test("L2 auto-post runs checkPolicy and will not send a 4th subreddit reply", async t => {
  const { store } = await home(t);
  plowEnv(t);
  const { draft } = seedReddit(store);
  for (let i = 0; i < L2_STREAK; i++) recordDecision(store, draft, "approved");
  confirmAutonomy(store, "reddit", "question");
  for (let i = 0; i < 3; i++) {
    store.db.prepare("INSERT INTO ledger (key, state, url) VALUES (?, 'verified', NULL)").run(`post:2026-09-23:reddit:testaha:t1_old${i}`);
  }
  store.db.prepare(`INSERT INTO items (source, external_id, url, author, title, body, published_at, fetched_at, state)
    VALUES ('reddit', 't1_new', 'https://www.reddit.com/r/testaha/comments/zzz/title/new/', 'bob', 't', 'Does plow queue jobs?', '2026-09-22T12:00:00.000Z', '2026-09-22T12:00:00.000Z', 'relevant')`).run();
  const itemId = Number((store.db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id);
  store.db.prepare(`INSERT INTO classifications (item_id, sentiment, category, topic, language, is_question, urgency, about, confidence)
    VALUES (?, 0, 'question', 'queues', 'en', 1, 'low', 'self', 0.9)`).run(itemId);
  let comments = 0;
  await draftAndNotify(store, {
    now: () => new Date("2026-09-23T12:00:00.000Z"),
    complete: async () => ({ ok: true, value: { body: "Thanks for asking about Plow queues." } }),
    fetch: async (input) => {
      if (String(input).includes("/api/comment")) comments += 1;
      if (String(input).includes("/api/comment")) return Response.json(posted);
      if (String(input).includes("/api/info")) return Response.json(verified);
      return Response.json({ uid: "msg" });
    },
  });
  assert.equal(comments, 0);
});

test("a stuck posting ledger is treated as uncertain and never resent", async t => {
  const { store } = await home(t);
  const { draft } = seedReddit(store);
  store.db.prepare("INSERT INTO ledger (key, state, url) VALUES ('post:2026-09-23:reddit:testaha:t1_abc', 'posting', NULL)").run();
  let called = 0;
  const result = await postReply(store, draft.id, {
    token: "tok",
    now: () => new Date("2026-09-23T12:00:00.000Z"),
    fetch: async () => {
      called += 1;
      return Response.json(posted);
    },
  });
  assert.equal(result, "uncertain");
  assert.equal(called, 0);
  const row = store.db.prepare("SELECT state FROM ledger WHERE key = ?").get("post:2026-09-23:reddit:testaha:t1_abc") as { state: string };
  assert.equal(row.state, "uncertain");
});

test("a concurrent postReply on posting does not send a second HTTP comment", async t => {
  const { store } = await home(t);
  const { draft } = seedReddit(store);
  let inner: string | undefined;
  const result = await postReply(store, draft.id, {
    token: "tok",
    now: () => new Date("2026-09-23T12:00:00.000Z"),
    fetch: async (input) => {
      if (String(input).includes("/api/comment")) {
        inner = await postReply(store, draft.id, {
          token: "tok",
          now: () => new Date("2026-09-23T12:00:00.000Z"),
          fetch: async () => {
            throw new Error("second http");
          },
        });
        return Response.json(posted);
      }
      return Response.json(verified);
    },
  });
  assert.equal(result, "posted");
  assert.equal(inner, "uncertain");
});

test("one Reddit reply per thread uses the post id, not the comment id", async t => {
  const { store } = await home(t);
  const first = seedReddit(store, { externalId: "t1_abc", url: "https://www.reddit.com/r/testaha/comments/xyz/title/abc/" });
  await postReply(store, first.draft.id, {
    token: "tok",
    now: () => new Date("2026-09-23T12:00:00.000Z"),
    fetch: async (input) => String(input).includes("/api/comment") ? Response.json(posted) : Response.json(verified),
  });
  const second = seedReddit(store, { externalId: "t1_def", url: "https://www.reddit.com/r/testaha/comments/xyz/title/def/" });
  let comments = 0;
  const result = await postReply(store, second.draft.id, {
    token: "tok",
    now: () => new Date("2026-09-23T12:00:00.000Z"),
    fetch: async (input) => {
      if (String(input).includes("/api/comment")) comments += 1;
      return Response.json(posted);
    },
  });
  assert.equal(result, "posted");
  assert.equal(comments, 0);
});

test("a complaint drops autonomy to L1 immediately", async t => {
  const { store } = await home(t);
  const { draft } = seedReddit(store);
  for (let i = 0; i < L2_STREAK; i++) recordDecision(store, draft, "approved");
  confirmAutonomy(store, "reddit", "question");
  assert.equal(autonomyLevel(store, "reddit", "question"), "L2");
  recordDecision(store, draft, "complaint");
  assert.equal(autonomyLevel(store, "reddit", "question"), "L1");
});

test("approvals on sources that never post do not suggest L2", async t => {
  const { store } = await home(t);
  const { draft } = seedReddit(store, { source: "hn", url: "https://news.ycombinator.com/item?id=1", externalId: "1" });
  let suggested = 0;
  for (let i = 0; i < L2_STREAK; i++) {
    if (recordDecision(store, draft, "approved").suggest) suggested += 1;
  }
  assert.equal(suggested, 0);
  assert.equal(autonomyLevel(store, "hn", "question"), "L1");
});

test("L2 confirm rejects a category outside the whitelist", async t => {
  const { store } = await home(t);
  const { draft } = seedReddit(store, { category: "bug" });
  for (let i = 0; i < L2_STREAK; i++) recordDecision(store, draft, "approved");
  assert.deepEqual(confirmAutonomy(store, "reddit", "bug"), { ok: false, reason: "not in whitelist" });
  assert.equal(autonomyLevel(store, "reddit", "bug"), "L1");
});

test("approving a just-edited draft does not count toward the L2 streak", async t => {
  const { store } = await home(t);
  const { draft } = seedReddit(store);
  recordDecision(store, draft, "approved");
  recordDecision(store, draft, "edited");
  let suggested = 0;
  for (let i = 0; i < L2_STREAK; i++) {
    if (recordDecision(store, draft, "approved").suggest) suggested += 1;
  }
  assert.equal(suggested, 0);
  if (recordDecision(store, draft, "approved").suggest) suggested += 1;
  assert.equal(suggested, 1);
});

test("an uncertain post notifies the owner", async t => {
  const { store } = await home(t);
  plowEnv(t);
  const { draft } = seedReddit(store);
  const posts: string[] = [];
  await postReply(store, draft.id, {
    token: "tok",
    now: () => new Date("2026-09-23T12:00:00.000Z"),
    fetch: async (input, init) => {
      if (String(input).includes("/messages")) {
        posts.push(String(init?.body ?? ""));
        return Response.json({ uid: "msg" });
      }
      throw new Error("socket hang up");
    },
  });
  assert.equal(posts.some(body => body.includes("Uncertain Reddit post") && body.includes("AHA-")), true);
});


test("an app-only Reddit token never posts", async t => {
  const { store } = await home(t);
  const { draft } = seedReddit(store);
  const methods: string[] = [];
  const result = await postReply(store, draft.id, {
    auth: redditAuth({ clientId: "cid", clientSecret: "cs" }),
    fetch: async (input, init) => { methods.push(`${init?.method ?? "GET"} ${String(input)}`); return Response.json({}); },
  });
  assert.equal(result, "failed");
  assert.deepEqual(methods, []);
});

test("a reply whose token Reddit refused is sent once more with a renewed token", async t => {
  clearRedditTokenCache();
  t.after(clearRedditTokenCache);
  const { store } = await home(t);
  const { draft } = seedReddit(store);
  let issued = 0;
  const comments: string[] = [];
  const http: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/api/v1/access_token")) return Response.json({ access_token: `tok${++issued}`, expires_in: 3600 });
    if (url.includes("/api/comment")) {
      comments.push(new Headers(init?.headers).get("authorization") ?? "");
      return comments.length === 1 ? new Response("", { status: 401 }) : Response.json(posted);
    }
    return Response.json(verified);
  };
  const result = await postReply(store, draft.id, {
    fetch: http,
    now: () => new Date("2026-09-23T12:00:00.000Z"),
    auth: redditAuth({ clientId: "cid", clientSecret: "cs", username: "plowbot", password: "pw" }, { fetch: http }),
  });
  assert.equal(result, "posted");
  assert.deepEqual(comments, ["Bearer tok1", "Bearer tok2"]);
});
