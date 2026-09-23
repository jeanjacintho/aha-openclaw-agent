import { readSecrets } from "../secrets.ts";
import { type Store } from "../store/db.ts";
import { REDDIT_USER_AGENT } from "../sources/reddit.ts";

type Draft = { id: number; itemId: number; body: string; state: string };

export type PostResult = "posted" | "uncertain" | "failed";

export type PostDeps = {
  fetch?: typeof fetch;
  now?: () => Date;
  token?: string;
};

const COMMENT = "https://oauth.reddit.com/api/comment";
const INFO = "https://oauth.reddit.com/api/info";

export function redditSubreddit(url: string | null | undefined) {
  const match = (url ?? "").match(/reddit\.com\/r\/([^/?#]+)/i);
  if (match) return match[1].toLowerCase();
}

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

function postKey(day: string, source: string, externalId: string, url: string | null) {
  const sub = source === "reddit" ? redditSubreddit(url) : undefined;
  if (sub) return `post:${day}:reddit:${sub}:${externalId}`;
  return `post:${day}:${source}:${externalId}`;
}

function threadKey(source: string, externalId: string) {
  return `thread:${source}:${externalId}`;
}

function ledgerState(store: Store, key: string) {
  return (store.db.prepare("SELECT state, url FROM ledger WHERE key = ?").get(key) as { state: string; url: string | null } | undefined);
}

function writeLedger(store: Store, key: string, state: string, url: string | null) {
  store.db.prepare("INSERT INTO ledger (key, state, url) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET state = excluded.state, url = excluded.url")
    .run(key, state, url);
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
  const key = postKey(day, item.source, item.externalId, item.url);
  const thread = threadKey(item.source, item.externalId);
  for (const existing of [ledgerState(store, key), ledgerState(store, thread)]) {
    if (!existing) continue;
    if (existing.state === "uncertain") return "uncertain";
    if (existing.state === "posted" || existing.state === "verified") return "posted";
  }
  const token = deps.token ?? readSecrets().reddit ?? "";
  if (!token) return "failed";
  writeLedger(store, key, "posting", item.url);
  writeLedger(store, thread, "posting", item.url);
  const http = deps.fetch ?? fetch;
  const body = new URLSearchParams({ api_type: "json", thing_id: item.externalId, text: draft.body }).toString();
  let response: Response;
  try {
    response = await http(COMMENT, {
      method: "POST",
      headers: { ...oauthHeaders(token), "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
  } catch {
    writeLedger(store, key, "uncertain", item.url);
    writeLedger(store, thread, "uncertain", item.url);
    return "uncertain";
  }
  if (response.status === 401 || response.status === 403) {
    writeLedger(store, key, "failed", item.url);
    writeLedger(store, thread, "failed", item.url);
    return "failed";
  }
  if (!response.ok) {
    const next = response.status >= 500 ? "uncertain" : "failed";
    writeLedger(store, key, next, item.url);
    writeLedger(store, thread, next, item.url);
    return next;
  }
  let parsed: { id: string; permalink?: string } | undefined;
  try {
    parsed = commentId(await response.json());
  } catch {
    writeLedger(store, key, "uncertain", item.url);
    writeLedger(store, thread, "uncertain", item.url);
    return "uncertain";
  }
  if (!parsed) {
    writeLedger(store, key, "failed", item.url);
    writeLedger(store, thread, "failed", item.url);
    return "failed";
  }
  const postedUrl = parsed.permalink
    ? (parsed.permalink.startsWith("http") ? parsed.permalink : `https://www.reddit.com${parsed.permalink}`)
    : item.url;
  writeLedger(store, key, "posted", postedUrl);
  writeLedger(store, thread, "posted", postedUrl);
  try {
    if (await verify(http, token, parsed.id)) {
      writeLedger(store, key, "verified", postedUrl);
      writeLedger(store, thread, "verified", postedUrl);
    }
  } catch {
    /* posted stands if the re-read fails */
  }
  return "posted";
}
