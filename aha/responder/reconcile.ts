import { getConfig } from "../config.ts";
import { sendToChat, type SendResult } from "../notify/plow.ts";
import { readSecrets } from "../secrets.ts";
import { redditAuth, type RedditAuth } from "../sources/reddit-auth.ts";
import { REDDIT_USER_AGENT } from "../sources/reddit.ts";
import { withHttpTimeout } from "../sources/http.ts";
import { type Store } from "../store/db.ts";
import { recordDraftEvent } from "./draft-events.ts";
import { normalizeRedditBody, unescapeRedditBody } from "./post.ts";
import { threadLedgerKey } from "./reddit-url.ts";

export const REDDIT_RECONCILE_LIMIT = 100;
export const REDDIT_RECONCILE_GRACE_MS = 10 * 60 * 1000;
export const REDDIT_RECONCILE_MAX_AGE_MS = 48 * 60 * 60 * 1000;
export const REDDIT_RECONCILE_CLOCK_SKEW_MS = 2 * 60 * 1000;
export const REDDIT_STALE_POSTING_MS = 15 * 60 * 1000;
const USER_AGENT = REDDIT_USER_AGENT;
const COMMENTS = "https://oauth.reddit.com/user";

type RedditComment = {
  name?: string;
  parent_id?: string;
  body?: string;
  author?: string;
  permalink?: string;
  created_utc?: number;
};

type PendingPost = {
  postKey: string;
  threadKey: string;
  itemId: number;
  externalId: string;
  itemUrl: string | null;
  draftId: number;
  body: string;
  lowerBoundAt: number;
  graceStartedAt: number;
  expiresAt: number;
};

export type ReconcileDeps = { fetch?: typeof fetch; now?: () => Date; auth?: RedditAuth };

function isRedditCredentials(value: unknown): value is { username: string } {
  return Boolean(value && typeof value === "object" && typeof (value as { username?: unknown }).username === "string"
    && (value as { username: string }).username.trim());
}

function freezeStalePosting(store: Store, now: Date) {
  const rows = store.db.prepare(`SELECT key, url FROM ledger
    WHERE key GLOB 'post:*:reddit:*' AND state = 'posting' ORDER BY key`).all() as { key: string; url: string | null }[];
  let frozen = 0;
  for (const row of rows) {
    const externalId = row.key.split(":").at(-1);
    if (!externalId) continue;
    const item = store.db.prepare(`SELECT id, external_id AS externalId, url FROM items
      WHERE source = 'reddit' AND external_id = ? ORDER BY id DESC LIMIT 1`).get(externalId) as {
      id: number; externalId: string; url: string | null;
    } | undefined;
    if (!item) continue;
    const draft = store.db.prepare(`SELECT id, body, approved_at AS approvedAt FROM drafts
      WHERE item_id = ? AND state = 'approved' ORDER BY id DESC LIMIT 1`).get(item.id) as {
      id: number; body: string; approvedAt: string | null;
    } | undefined;
    const approvedAt = draft?.approvedAt ? Date.parse(draft.approvedAt) : Number.NaN;
    if (!draft || !Number.isFinite(approvedAt) || now.getTime() - approvedAt < REDDIT_STALE_POSTING_MS) continue;
    const threadKey = threadLedgerKey("reddit", item.externalId, item.url ?? row.url);
    const recovered = store.tx(() => {
      const states = store.db.prepare("SELECT key, state FROM ledger WHERE key IN (?, ?)").all(row.key, threadKey) as {
        key: string; state: string;
      }[];
      if (states.length !== 2 || states.some(entry => entry.state !== "posting")) return false;
      store.db.prepare("UPDATE ledger SET state = 'uncertain' WHERE key IN (?, ?) AND state = 'posting'").run(row.key, threadKey);
      recordDraftEvent(store, {
        draftId: draft.id,
        itemId: item.id,
        actor: "system",
        action: "uncertain",
        body: draft.body,
        detail: "stale_posting",
        // approved_at is written before the HTTP request and is the best available
        // attempt timestamp when a crash prevented a later outcome event.
        at: new Date(approvedAt),
      });
      return true;
    });
    if (recovered) frozen += 1;
  }
  return frozen;
}

function getPendingPosts(store: Store, now: Date): { active: PendingPost[]; expired: PendingPost[] } {
  const rows = store.db.prepare(`SELECT key, url FROM ledger
    WHERE key GLOB 'post:*:reddit:*' AND state = 'uncertain' ORDER BY key`).all() as { key: string; url: string | null }[];
  const active: PendingPost[] = [];
  const expired: PendingPost[] = [];
  for (const row of rows) {
    const externalId = row.key.split(":").at(-1);
    if (!externalId) continue;
    const item = store.db.prepare(`SELECT id, external_id AS externalId, url FROM items
      WHERE source = 'reddit' AND external_id = ? ORDER BY id DESC LIMIT 1`).get(externalId) as {
      id: number; externalId: string; url: string | null;
    } | undefined;
    if (!item) continue;
    const draft = store.db.prepare(`SELECT id, body, approved_at AS approvedAt FROM drafts WHERE item_id = ? AND state = 'approved'
      ORDER BY id DESC LIMIT 1`).get(item.id) as { id: number; body: string; approvedAt: string | null } | undefined;
    if (!draft) continue;
    const approvedAt = draft.approvedAt ? Date.parse(draft.approvedAt) : Number.NaN;
    if (!Number.isFinite(approvedAt)) continue;
    const expiredEvent = store.db.prepare(`SELECT 1 FROM draft_events WHERE draft_id = ? AND action = 'reconcile_expired' LIMIT 1`)
      .get(draft.id);
    if (expiredEvent) continue;
    const attempt = store.db.prepare(`SELECT at FROM draft_events WHERE draft_id = ? AND action = 'uncertain'
      ORDER BY at DESC, id DESC LIMIT 1`).get(draft.id) as { at: string } | undefined;
    const uncertainAt = attempt ? Date.parse(attempt.at) : Number.NaN;
    if (!Number.isFinite(uncertainAt)) continue;
    const graceStartedAt = Math.max(uncertainAt, approvedAt);
    const post: PendingPost = {
      postKey: row.key,
      threadKey: threadLedgerKey("reddit", item.externalId, item.url ?? row.url),
      itemId: item.id,
      externalId: item.externalId,
      itemUrl: item.url ?? row.url,
      draftId: draft.id,
      body: draft.body,
      lowerBoundAt: approvedAt - REDDIT_RECONCILE_CLOCK_SKEW_MS,
      graceStartedAt,
      expiresAt: Math.max(uncertainAt, approvedAt),
    };
    if (now.getTime() - post.expiresAt >= REDDIT_RECONCILE_MAX_AGE_MS) expired.push(post);
    else active.push(post);
  }
  return { active, expired };
}

function commentMatches(comment: RedditComment, post: PendingPost, username: string) {
  if (comment.parent_id !== post.externalId || typeof comment.body !== "string") return false;
  if (typeof comment.author !== "string" || comment.author.toLowerCase() !== username.toLowerCase()) return false;
  if (typeof comment.created_utc !== "number" || !Number.isFinite(comment.created_utc)) return false;
  if (comment.created_utc * 1000 < post.lowerBoundAt) return false;
  return normalizeRedditBody(unescapeRedditBody(comment.body)) === normalizeRedditBody(post.body);
}

function commentUrl(permalink: string | undefined, fallback: string | null) {
  if (!permalink) return fallback;
  return permalink.startsWith("http") ? permalink : `https://www.reddit.com${permalink}`;
}

function setLedgerState(store: Store, post: PendingPost, state: "verified" | "absent", url: string | null) {
  store.db.prepare("UPDATE ledger SET state = ?, url = ? WHERE key IN (?, ?)")
    .run(state, url, post.postKey, post.threadKey);
}

async function notifyResolution(store: Store, post: PendingPost, outcome: "found" | "absent", url: string | null, deps: ReconcileDeps) {
  const owner = getConfig(store)?.ownerChatUid || process.env.AHA_OWNER_CHAT_UID;
  if (!owner) return;
  const lang = getConfig(store)?.language || "en";
  const retried = Boolean(store.db.prepare("SELECT 1 FROM draft_events WHERE draft_id = ? AND action = 'retried' LIMIT 1")
    .get(post.draftId));
  const noticeKey = retried ? `${outcome}-after-retry` : outcome;
  const text = outcome === "found"
    ? (lang.startsWith("pt")
      ? `Publicação AHA-${post.itemId} confirmada no Reddit: ${url ?? "link indisponível"}`
      : `AHA-${post.itemId} Reddit publication confirmed: ${url ?? "link unavailable"}`)
    : (lang.startsWith("pt")
      ? retried
        ? `A publicação AHA-${post.itemId} não foi encontrada após o reenvio. Não haverá outro reenvio; você pode publicar manualmente.`
        : `A publicação AHA-${post.itemId} não foi encontrada no Reddit. Responda RETRY AHA-${post.itemId} para reenviar uma única vez.`
      : retried
        ? `AHA-${post.itemId} was not found after the retry. It will not be retried again; you may publish manually.`
        : `AHA-${post.itemId} was not found on Reddit. Reply RETRY AHA-${post.itemId} to retry once.`);
  try {
    const result: SendResult = await sendToChat(owner, text, `reddit-reconcile:${noticeKey}:${post.postKey}`, {
      store, fetch: deps.fetch, now: deps.now,
    });
    if (result !== "sent" && result !== "duplicate") {
      console.error(`aha: Reddit reconciliation ${outcome} notice for AHA-${post.itemId} was not delivered (${result})`);
    }
  } catch {
    console.error(`aha: Reddit reconciliation ${outcome} notice for AHA-${post.itemId} failed`);
  }
}

function recordResolution(store: Store, post: PendingPost, action: "reconciled" | "absent" | "reconcile_expired", state?: "verified" | "absent", url?: string | null) {
  store.tx(() => {
    if (state) setLedgerState(store, post, state, url ?? null);
    recordDraftEvent(store, {
      draftId: post.draftId,
      itemId: post.itemId,
      actor: "system",
      action,
      body: post.body,
    });
  });
}

export async function reconcileRedditPosts(store: Store, deps: ReconcileDeps = {}) {
  const secrets = readSecrets();
  if (!isRedditCredentials(secrets.reddit)) return { checked: 0, reconciled: 0, absent: 0, expired: 0 };
  const username = secrets.reddit.username;
  const now = deps.now?.() ?? new Date();
  freezeStalePosting(store, now);
  const { active, expired } = getPendingPosts(store, now);
  for (const post of expired) recordResolution(store, post, "reconcile_expired");
  if (active.length === 0) return { checked: 0, reconciled: 0, absent: 0, expired: expired.length };

  const http = deps.fetch ?? fetch;
  const auth = deps.auth ?? redditAuth(secrets.reddit, { fetch: http });
  if (!auth) return { checked: 0, reconciled: 0, absent: 0, expired: expired.length };
  let response: Response;
  let comments: RedditComment[];
  try {
    const token = await auth.token();
    const url = `${COMMENTS}/${encodeURIComponent(username)}/comments?sort=new&limit=${REDDIT_RECONCILE_LIMIT}`;
    response = await http(url, withHttpTimeout({
      headers: { Authorization: `Bearer ${token}`, "User-Agent": USER_AGENT, Accept: "application/json" },
    }));
    if (!response.ok) throw new Error(`http ${response.status}`);
    const payload = await response.json() as { data?: { children?: { data?: RedditComment }[] } };
    const children = payload.data?.children;
    if (!Array.isArray(children) || children.some(child => !child.data
      || typeof child.data.created_utc !== "number" || !Number.isFinite(child.data.created_utc))) {
      throw new Error("invalid comments listing");
    }
    comments = children.map(child => child.data!);
  } catch {
    return { checked: active.length, reconciled: 0, absent: 0, expired: expired.length };
  }

  let reconciled = 0;
  let absent = 0;
  const oldestCreatedAt = comments.reduce<number | undefined>((oldest, comment) => {
    const timestamp = comment.created_utc;
    if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) return oldest;
    const ms = timestamp * 1000;
    return oldest === undefined || ms < oldest ? ms : oldest;
  }, undefined);
  const listingIsShort = comments.length < REDDIT_RECONCILE_LIMIT;

  for (const post of active) {
    const found = comments.find(comment => commentMatches(comment, post, username));
    if (found) {
      const url = commentUrl(found.permalink, post.itemUrl);
      recordResolution(store, post, "reconciled", "verified", url);
      reconciled += 1;
      await notifyResolution(store, post, "found", url, deps);
      continue;
    }
    const pastGrace = now.getTime() - post.graceStartedAt >= REDDIT_RECONCILE_GRACE_MS;
    const listingCoversAttempt = listingIsShort || (oldestCreatedAt !== undefined && oldestCreatedAt <= post.lowerBoundAt);
    if (listingCoversAttempt && pastGrace) {
      recordResolution(store, post, "absent", "absent", post.itemUrl);
      absent += 1;
      await notifyResolution(store, post, "absent", post.itemUrl, deps);
    }
  }
  return { checked: active.length, reconciled, absent, expired: expired.length };
}
