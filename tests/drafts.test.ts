import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { saveConfig } from "../aha/config.ts";
import { draftAndNotify, draftReply, isBareHost, keepLink, stripOffListLinks, validateReply } from "../aha/responder/drafts.ts";
import { openStore } from "../aha/store/db.ts";

async function home(t: import("node:test").TestContext) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aha-drafts-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = openStore(dir);
  t.after(() => store.close());
  saveConfig(store, {
    company: { name: "Plow" },
    language: "en",
    links: ["https://plow.example/docs"],
  });
  return store;
}

function insertItem(store: ReturnType<typeof openStore>, over: {
  about?: string; lang?: string; body?: string; url?: string; category?: string; fetchedAt?: string;
} = {}) {
  store.db.prepare(`INSERT INTO items (source, external_id, url, author, title, body, published_at, fetched_at, state)
    VALUES ('hn', ?, ?, 'a', 'Plow queues', ?, '2026-09-22T00:00:00.000Z', ?, 'relevant')`)
    .run(String(Math.random()), over.url ?? "https://news.ycombinator.com/item?id=1", over.body ?? "Does plow queue jobs?", over.fetchedAt ?? "2026-09-22T00:00:00.000Z");
  const id = Number((store.db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id);
  store.db.prepare(`INSERT INTO classifications (item_id, sentiment, category, topic, language, is_question, urgency, about, confidence)
    VALUES (?, 0, ?, 'queues', ?, 1, 'low', ?, 0.9)`).run(id, over.category ?? "question", over.lang ?? "en", over.about ?? "self");
  return id;
}

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

const now = () => new Date("2026-09-23T12:00:00.000Z");

test("the validator removes links that are not on the owner's list", () => {
  const allowed = ["https://plow.example/docs"];
  const text = stripOffListLinks("See https://evil.example/x and https://plow.example/docs/ok", allowed);
  assert.equal(text.includes("evil.example"), false);
  assert.match(text, /plow\.example\/docs\/ok/);
});

test("the validator refuses prefix, userinfo, and schemeless off-list links", () => {
  const allowed = ["https://plow.co/docs"];
  assert.equal(keepLink("https://plow.co.evil.com/login", allowed), false);
  assert.equal(keepLink("https://plow.co@evil.com/login", allowed), false);
  assert.equal(keepLink("https://plow.co/docs/ok", allowed), true);
  const prefix = validateReply("See https://plow.co.evil.com/login thanks", { company: "Plow", lang: "en", url: null, links: allowed }, "strict");
  assert.equal(prefix.ok, false);
  const userinfo = validateReply("See https://plow.co@evil.com/login thanks", { company: "Plow", lang: "en", url: null, links: allowed }, "strict");
  assert.equal(userinfo.ok, false);
  const bare = validateReply("Visit evil.com/login thanks", { company: "Plow", lang: "en", url: null, links: allowed }, "strict");
  assert.equal(bare.ok, false);
  const www = validateReply("Visit www.evil.com thanks", { company: "Plow", lang: "en", url: null, links: allowed }, "strict");
  assert.equal(www.ok, false);
});

test("the validator does not treat Node.js-style names as schemeless hosts", () => {
  assert.equal(isBareHost("Node.js"), false);
  assert.equal(isBareHost("Next.js"), false);
  assert.equal(isBareHost("evil.com"), true);
  assert.equal(isBareHost("www.evil.com"), true);
  assert.equal(isBareHost("evil.com/login"), true);
  const kept = stripOffListLinks("Works with Node.js and Next.js thanks", []);
  assert.match(kept, /Node\.js/);
  assert.match(kept, /Next\.js/);
  const ctx = { company: "Plow", lang: "en" as const, url: null, links: [] };
  const result = validateReply("Works with Node.js and Next.js thanks", ctx);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.match(result.body, /Node\.js/);
    assert.match(result.body, /Next\.js/);
  }
});

test("the validator refuses expanded price and deadline promises", () => {
  const ctx = { company: "Plow", lang: "en" as const, url: null, links: [] };
  for (const body of ["$9 per month", "within 2 days", "next week", "50% off, guaranteed"]) {
    assert.equal(validateReply(body, ctx).ok, false, body);
  }
});

test("the validator sends unknown and mixed languages to review", () => {
  assert.equal(validateReply("Obrigado! We are on it.", { company: "Plow", lang: "pt", url: null }).ok, false);
  assert.equal(validateReply("Gracias por escribir", { company: "Plow", lang: "es", url: null }).ok, false);
});

test("the validator requires the language of the original post", () => {
  const en = validateReply("você não deveria usar isso", { company: "Plow", lang: "en", url: null });
  assert.equal(en.ok, false);
  const pt = validateReply("Obrigado pela pergunta sobre o produto", { company: "Plow", lang: "pt", url: null });
  assert.equal(pt.ok, true);
  if (pt.ok) assert.match(pt.body, /assistente de IA da Plow/);
});

test("the validator appends the AHA signature", () => {
  const result = validateReply("Thanks for asking about queues.", { company: "Plow", lang: "en", url: null });
  assert.equal(result.ok, true);
  if (result.ok) assert.match(result.body, /— AHA, AI assistant of Plow/);
});

test("the validator refuses empty text before adding a signature", () => {
  for (const text of ["", "   "]) {
    const result = validateReply(text, { company: "Plow", lang: "en", url: null });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "empty");
  }
});

test("draftReply strips off-list links, signs the body, and stores a pending draft", async t => {
  const store = await home(t);
  const itemId = insertItem(store);
  const draft = await draftReply(store, itemId, {
    complete: async () => ({ ok: true, value: { body: "Thanks for asking. See https://evil.example/x and https://plow.example/docs" } }),
  });
  assert.equal(draft.state, "pending");
  assert.equal(draft.body.includes("evil.example"), false);
  assert.match(draft.body, /plow\.example\/docs/);
  assert.match(draft.body, /AI assistant of Plow/);
  assert.equal((store.db.prepare("SELECT COUNT(*) AS n FROM drafts").get() as { n: number }).n, 1);
});

test("draftReply refuses a promise of time or price", async t => {
  const store = await home(t);
  const itemId = insertItem(store);
  await assert.rejects(
    () => draftReply(store, itemId, { complete: async () => ({ ok: true, value: { body: "Fix by Friday for $50" } }) }),
    /promise/,
  );
  assert.equal((store.db.prepare("SELECT COUNT(*) AS n FROM drafts").get() as { n: number }).n, 0);
});

test("a competitor item never gets a draft", async t => {
  const store = await home(t);
  const itemId = insertItem(store, { about: "competitor:zonk" });
  let called = 0;
  await assert.rejects(
    () => draftReply(store, itemId, { complete: async () => { called += 1; return { ok: true, value: { body: "hi" } }; } }),
    /competitor/,
  );
  assert.equal(called, 0);
  assert.equal((store.db.prepare("SELECT COUNT(*) AS n FROM drafts").get() as { n: number }).n, 0);
});

test("the worker drafts an eligible item and sends AHA-n to the role group", async t => {
  const store = await home(t);
  plowEnv(t);
  saveConfig(store, {
    company: { name: "Plow" },
    language: "en",
    links: ["https://plow.example/docs"],
    ownerChatUid: "cht_dm",
    roleChats: { marketing: "cht_marketing" },
  });
  const itemId = insertItem(store);
  const posts: { url: string; body: string }[] = [];
  await draftAndNotify(store, {
    now,
    complete: async () => ({ ok: true, value: { body: "Thanks for asking about Plow queues." } }),
    fetch: async (input, init) => {
      posts.push({ url: String(input), body: String(init?.body ?? "") });
      return Response.json({ uid: "msg_draft" });
    },
  });
  assert.equal((store.db.prepare("SELECT COUNT(*) AS n FROM drafts").get() as { n: number }).n, 1);
  assert.equal(posts.some(row => row.url.includes("/chats/cht_marketing/messages") && row.body.includes(`AHA-${itemId}`)), true);
});

test("an ignored item is not drafted again", async t => {
  const store = await home(t);
  plowEnv(t);
  saveConfig(store, {
    company: { name: "Plow" },
    language: "en",
    ownerChatUid: "cht_dm",
    roleChats: { marketing: "cht_marketing" },
  });
  const itemId = insertItem(store);
  store.db.prepare("INSERT INTO drafts (item_id, body, state) VALUES (?, 'ignored body', 'ignored')").run(itemId);
  let called = 0;
  await draftAndNotify(store, {
    now,
    complete: async () => {
      called += 1;
      return { ok: true, value: { body: "Thanks for asking about Plow queues." } };
    },
    fetch: async () => Response.json({ uid: "msg" }),
  });
  assert.equal(called, 0);
  assert.equal((store.db.prepare("SELECT COUNT(*) AS n FROM drafts").get() as { n: number }).n, 1);
  assert.equal((store.db.prepare("SELECT state FROM drafts WHERE item_id = ?").get(itemId) as { state: string }).state, "ignored");
});

test("a red-line item is escalated and sent to the routed role group", async t => {
  const store = await home(t);
  plowEnv(t);
  saveConfig(store, {
    company: { name: "Plow" },
    language: "en",
    ownerChatUid: "cht_dm",
    roleChats: { engenharia: "cht_engenharia", founder: "cht_founder" },
  });
  const itemId = insertItem(store, { category: "security" });
  store.db.prepare("UPDATE classifications SET urgency = 'high' WHERE item_id = ?").run(itemId);
  const posts: { url: string; body: string }[] = [];
  await draftAndNotify(store, {
    now,
    complete: async () => ({ ok: true, value: { body: "Thanks for asking about Plow queues." } }),
    fetch: async (input, init) => {
      posts.push({ url: String(input), body: String(init?.body ?? "") });
      return Response.json({ uid: "msg_esc" });
    },
  });
  assert.equal((store.db.prepare("SELECT state FROM items WHERE id = ?").get(itemId) as { state: string }).state, "escalated");
  assert.equal((store.db.prepare("SELECT COUNT(*) AS n FROM drafts").get() as { n: number }).n, 0);
  assert.equal(posts.some(row => row.url.includes("/chats/cht_engenharia/messages") && row.body.includes(`Escalado AHA-${itemId}`)), true);
  assert.equal(posts.some(row => row.url.includes("/chats/cht_founder/messages") && row.body.includes(`Escalado AHA-${itemId}`)), true);
});

test("draft failures are recorded and old items are not retried forever", async t => {
  const store = await home(t);
  plowEnv(t);
  saveConfig(store, { company: { name: "Plow" }, language: "en", ownerChatUid: "cht_dm", roleChats: { marketing: "cht_marketing" } });
  const failing = insertItem(store);
  const stale = insertItem(store, { fetchedAt: "2026-08-01T00:00:00.000Z" });
  let called = 0;
  const run = () => draftAndNotify(store, {
    now,
    complete: async () => {
      called += 1;
      return { ok: false, reason: "timeout" };
    },
    fetch: async () => Response.json({ uid: "msg" }),
  });
  await run();
  await run();
  await run();
  const afterLimit = called;
  await run();
  assert.equal(called, afterLimit);
  assert.equal(called, 3);
  const failRow = store.db.prepare("SELECT draft_attempts AS n, draft_error AS err FROM items WHERE id = ?").get(failing) as { n: number; err: string };
  assert.equal(failRow.n, 3);
  assert.match(failRow.err, /timeout/);
  const staleRow = store.db.prepare("SELECT draft_attempts AS n, draft_error AS err FROM items WHERE id = ?").get(stale) as { n: number; err: string };
  assert.equal(staleRow.n, 3);
  assert.match(staleRow.err, /too old/);
});
