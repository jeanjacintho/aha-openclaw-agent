import { getConfig } from "../config.ts";
import { sendToChat } from "../notify/plow.ts";
import { readSecrets } from "../secrets.ts";
import { type Store } from "../store/db.ts";
import { REDDIT_USER_AGENT, withRedditToken } from "../sources/reddit.ts";
import { RedditAuthError, redditAuth, type RedditAuth } from "../sources/reddit-auth.ts";
import { postLedgerKey, threadLedgerKey } from "./reddit-url.ts";

export { redditSubreddit, redditThreadId, threadLedgerKey, postLedgerKey } from "./reddit-url.ts";

type Draft = { id: number; itemId: number; body: string; state: string };

export type PostResult = "posted" | "uncertain" | "failed";

export type PostDeps = {
  fetch?: typeof fetch;
  now?: () => Date;
  token?: string;
  auth?: RedditAuth;
};

const COMMENT = "https://oauth.reddit.com/api/comment";
const INFO = "https://oauth.reddit.com/api/info";

function ymd(now: Date) {
  return now.toISOString().slice(0, 10);
}

function paused(store: Store) {
  return (store.db.prepare("SELECT paused FROM flags WHERE id = 1").get() as { paused: number } | undefined)?.paused !== 0;
}

function oauthHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    "User-Agent": REDDIT_USER_AGENT,
    Accept: "application/json",
  };
}

function ledgerState(store: Store, key: string) {
  return (store.db.prepare("SELECT state, url FROM ledger WHERE key = ?").get(key) as { state: string; url: string | null } | undefined);
}

function setLedger(store: Store, key: string, state: string, url: string | null) {
  store.db.prepare("UPDATE ledger SET state = ?, url = ? WHERE key = ?").run(state, url, key);
}

function takeKey(store: Store, key: string, url: string | null) {
  const inserted = store.db.prepare("INSERT INTO ledger (key, state, url) VALUES (?, 'posting', ?) ON CONFLICT (key) DO NOTHING").run(key, url);
  if (inserted.changes === 1) return true;
  const stolen = store.db.prepare("UPDATE ledger SET state = 'posting', url = ? WHERE key = ? AND state IN ('ready', 'failed')").run(url, key);
  return stolen.changes === 1;
}

function freezePosting(store: Store, key: string, url: string | null) {
  store.db.prepare("UPDATE ledger SET state = 'uncertain', url = ? WHERE key = ? AND state = 'posting'").run(url, key);
}

function haltFrom(state: string | undefined): PostResult | undefined {
  if (!state) return;
  if (state === "uncertain" || state === "posting") return "uncertain";
  if (state === "posted" || state === "verified") return "posted";
}

function claimKeys(store: Store, postKey: string, threadKey: string, url: string | null): PostResult | "owned" {
  return store.tx(() => {
    const post = ledgerState(store, postKey);
    const thread = ledgerState(store, threadKey);
    if (post?.state === "posting" || thread?.state === "posting") {
      freezePosting(store, postKey, url);
      freezePosting(store, threadKey, url);
      return "uncertain";
    }
    const halt = haltFrom(post?.state) ?? haltFrom(thread?.state);
    if (halt) return halt;
    const threadReadyForeign = thread?.state === "ready" && post?.state !== "ready" && post?.state !== "failed";
    if (threadReadyForeign) return "posted";
    if (!takeKey(store, postKey, url) || !takeKey(store, threadKey, url)) {
      freezePosting(store, postKey, url);
      freezePosting(store, threadKey, url);
      return haltFrom(ledgerState(store, postKey)?.state) ?? haltFrom(ledgerState(store, threadKey)?.state) ?? "uncertain";
    }
    return "owned";
  });
}

function commentId(payload: unknown): { id: string; permalink?: string } | undefined {
  const json = payload && typeof payload === "object" ? (payload as { json?: { data?: { things?: { data?: { name?: string; id?: string; permalink?: string } }[] }; errors?: unknown[] } }).json : undefined;
  if (json?.errors && json.errors.length > 0) return;
  const thing = json?.data?.things?.[0]?.data;
  const id = thing?.name || (thing?.id ? `t1_${thing.id}` : undefined);
  if (!id) return;
  return { id, permalink: thing?.permalink };
}

async function verify(http: typeof fetch, token: string, fullname: string) {
  const response = await http(`${INFO}?id=${encodeURIComponent(fullname)}`, { headers: oauthHeaders(token) });
  if (!response.ok) return false;
  const payload = await response.json() as { data?: { children?: { data?: { name?: string } }[] } };
  return (payload.data?.children ?? []).some(child => child.data?.name === fullname);
}

async function notifyUncertain(store: Store, itemId: number, key: string, deps: PostDeps) {
  const owner = getConfig(store)?.ownerChatUid || process.env.AHA_OWNER_CHAT_UID;
  if (!owner) return;
  const lang = getConfig(store)?.language || "en";
  const text = lang.startsWith("pt")
    ? `Post incerto AHA-${itemId}. Não vou repostar. Confira o thread.`
    : `Uncertain Reddit post for AHA-${itemId}. I will not retry. Check the thread.`;
  try {
    await sendToChat(owner, text, `uncertain:${key}`, { store, fetch: deps.fetch, now: deps.now });
  } catch {
    /* unit tests may omit Plow env */
  }
}

function finish(store: Store, postKey: string, threadKey: string, state: string, url: string | null) {
  setLedger(store, postKey, state, url);
  setLedger(store, threadKey, state, url);
}

export async function postReply(store: Store, draftId: number, deps: PostDeps = {}): Promise<PostResult> {
  const draft = store.db.prepare("SELECT id, item_id AS itemId, body, state FROM drafts WHERE id = ?").get(draftId) as Draft | undefined;
  if (!draft) return "failed";
  const item = store.db.prepare("SELECT source, external_id AS externalId, url FROM items WHERE id = ?").get(draft.itemId) as {
    source: string; externalId: string; url: string | null;
  } | undefined;
  if (!item) return "failed";
  if (item.source !== "reddit") return "failed";
  if (paused(store)) return "failed";
  const now = deps.now?.() ?? new Date();
  const day = ymd(now);
  const key = postLedgerKey(day, item.source, item.externalId, item.url);
  const thread = threadLedgerKey(item.source, item.externalId, item.url);
  const claimed = claimKeys(store, key, thread, item.url);
  if (claimed !== "owned") {
    if (claimed === "uncertain") await notifyUncertain(store, draft.itemId, key, deps);
    return claimed;
  }
  const http = deps.fetch ?? fetch;
  const auth = deps.auth ?? redditAuth(deps.token ?? readSecrets().reddit, { fetch: http });
  // Posting needs a token for the account: an app-only token can only search.
  if (!auth?.canPost) {
    finish(store, key, thread, "failed", item.url);
    return "failed";
  }
  const body = new URLSearchParams({ api_type: "json", thing_id: item.externalId, text: draft.body }).toString();
  let response: Response;
  try {
    // A 401 means Reddit refused the token, so nothing was posted and a
    // renewed token may try once more.
    response = await withRedditToken(auth, token => http(COMMENT, {
      method: "POST",
      headers: { ...oauthHeaders(token), "Content-Type": "application/x-www-form-urlencoded" },
      body,
    }));
  } catch (error) {
    if (error instanceof RedditAuthError) {
      finish(store, key, thread, "failed", item.url);
      return "failed";
    }
    finish(store, key, thread, "uncertain", item.url);
    await notifyUncertain(store, draft.itemId, key, deps);
    return "uncertain";
  }
  if (response.status === 401 || response.status === 403) {
    finish(store, key, thread, "failed", item.url);
    return "failed";
  }
  if (!response.ok) {
    const next = response.status >= 500 ? "uncertain" : "failed";
    finish(store, key, thread, next, item.url);
    if (next === "uncertain") await notifyUncertain(store, draft.itemId, key, deps);
    return next;
  }
  let parsed: { id: string; permalink?: string } | undefined;
  try {
    parsed = commentId(await response.json());
  } catch {
    finish(store, key, thread, "uncertain", item.url);
    await notifyUncertain(store, draft.itemId, key, deps);
    return "uncertain";
  }
  if (!parsed) {
    finish(store, key, thread, "failed", item.url);
    return "failed";
  }
  const postedUrl = parsed.permalink
    ? (parsed.permalink.startsWith("http") ? parsed.permalink : `https://www.reddit.com${parsed.permalink}`)
    : item.url;
  finish(store, key, thread, "posted", postedUrl);
  try {
    if (await verify(http, await auth.token(), parsed.id)) {
      finish(store, key, thread, "verified", postedUrl);
    }
  } catch {
    /* posted stands if the re-read fails */
  }
  return "posted";
}
