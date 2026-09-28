import { createHash } from "node:crypto";
import { getConfig } from "../config.ts";
import { sendToChat } from "../notify/plow.ts";
import { readSecrets } from "../secrets.ts";
import { type Store } from "../store/db.ts";
import { REDDIT_USER_AGENT, withRedditToken } from "../sources/reddit.ts";
import { RedditAuthError, redditAuth, type RedditAuth } from "../sources/reddit-auth.ts";
import { withHttpTimeout } from "../sources/http.ts";
import { postingLimitReasons, postingPaused } from "./policy.ts";
import { postLedgerKey, threadLedgerKey } from "./reddit-url.ts";
import { recordDraftEvent, type DraftEventAction, type DraftEventDetail } from "./draft-events.ts";

export { redditSubreddit, redditThreadId, threadLedgerKey, postLedgerKey } from "./reddit-url.ts";

type Draft = { id: number; itemId: number; body: string; state: string; approvedSha256: string | null; approvedAt: string | null };

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

type PostClaimResult = PostResult | "owned" | "already_posted" | "already_absent" | "retry_refused" | "thread_taken";

function claimKeys(store: Store, postKey: string, threadKey: string, url: string | null): PostClaimResult {
  return store.tx(() => {
    const post = ledgerState(store, postKey);
    const thread = ledgerState(store, threadKey);
    if (post?.state === "posting" || thread?.state === "posting") {
      freezePosting(store, postKey, url);
      freezePosting(store, threadKey, url);
      return "uncertain";
    }
    if (post?.state === "posted" || post?.state === "verified") return "already_posted";
    if (thread?.state === "posted" || thread?.state === "verified") return "thread_taken";
    if (post?.state === "absent" || thread?.state === "absent") return "already_absent";
    if (post?.state === "uncertain" || thread?.state === "uncertain") return "uncertain";
    const threadReadyForeign = thread?.state === "ready" && post?.state !== "ready" && post?.state !== "failed";
    if (threadReadyForeign) return "thread_taken";
    if (!takeKey(store, postKey, url) || !takeKey(store, threadKey, url)) {
      freezePosting(store, postKey, url);
      freezePosting(store, threadKey, url);
      const currentPost = ledgerState(store, postKey)?.state;
      const currentThread = ledgerState(store, threadKey)?.state;
      if (currentPost === "posted" || currentPost === "verified") return "already_posted";
      if (currentThread === "posted" || currentThread === "verified") return "thread_taken";
      return "uncertain";
    }
    return "owned";
  });
}

type RetryClaim = {
  originalPostKey: string;
  retryPostKey: string;
  threadKey: string;
  url: string | null;
  draftId: number;
  itemId: number;
  body: string;
  approvedSha256: string;
  approvedAt: string;
  actor: string;
};

function claimAbsentRetry(store: Store, claim: RetryClaim): PostClaimResult {
  return store.tx(() => {
    const originalPost = ledgerState(store, claim.originalPostKey);
    const thread = ledgerState(store, claim.threadKey);
    if (originalPost?.state !== "absent" || thread?.state !== "absent") return "retry_refused";
    if (store.db.prepare("SELECT 1 FROM draft_events WHERE draft_id = ? AND action = 'retried' LIMIT 1").get(claim.draftId)) {
      return "retry_refused";
    }
    if (postingPaused(store) || postingLimitReasons(store, claim.itemId, new Date(claim.approvedAt)).length > 0) return "retry_refused";
    if (claim.retryPostKey !== claim.originalPostKey && ledgerState(store, claim.retryPostKey)) return "retry_refused";
    const draftUpdate = store.db.prepare(`UPDATE drafts SET approved_at = ?
      WHERE id = ? AND state = 'approved' AND body = ? AND approved_sha256 = ?`)
      .run(claim.approvedAt, claim.draftId, claim.body, claim.approvedSha256);
    if (draftUpdate.changes !== 1) return "retry_refused";
    if (claim.retryPostKey === claim.originalPostKey) {
      const postUpdate = store.db.prepare("UPDATE ledger SET state = 'posting', url = ? WHERE key = ? AND state = 'absent'")
        .run(claim.url, claim.originalPostKey);
      if (postUpdate.changes !== 1) throw new Error("absent post key changed during retry claim");
    } else {
      const inserted = store.db.prepare("INSERT INTO ledger (key, state, url) VALUES (?, 'posting', ?)")
        .run(claim.retryPostKey, claim.url);
      if (inserted.changes !== 1) throw new Error("retry post key could not be claimed");
    }
    const threadUpdate = store.db.prepare("UPDATE ledger SET state = 'posting', url = ? WHERE key = ? AND state = 'absent'")
      .run(claim.url, claim.threadKey);
    if (threadUpdate.changes !== 1) throw new Error("absent thread key changed during retry claim");
    recordDraftEvent(store, {
      draftId: claim.draftId,
      itemId: claim.itemId,
      actor: claim.actor,
      action: "retried",
      body: claim.body,
      at: new Date(claim.approvedAt),
    });
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

type VerifyResult = { status: "verified" } | { status: "mismatch"; detail: "parent_mismatch" | "body_mismatch" | "author_mismatch" | "removed" } | { status: "unavailable" };

export function normalizeRedditBody(value: string) {
  return value
    .replace(/\r\n?/g, "\n")
    .split("\n").map(line => line.replace(/[ \t]+$/g, "")).join("\n")
    .trimEnd();
}

export function unescapeRedditBody(value: string) {
  return value.replace(/&(amp|lt|gt);/g, entity => ({ "&amp;": "&", "&lt;": "<", "&gt;": ">" })[entity]!);
}

async function verify(
  http: typeof fetch,
  token: string,
  fullname: string,
  parentId: string,
  approvedBody: string,
  expectedAuthor?: string,
): Promise<VerifyResult> {
  const response = await http(`${INFO}?id=${encodeURIComponent(fullname)}`, withHttpTimeout({ headers: oauthHeaders(token) }));
  if (!response.ok) return { status: "unavailable" };
  const payload = await response.json() as { data?: { children?: { data?: {
    name?: string; parent_id?: string; body?: string; author?: string;
  } }[] } };
  const comment = (payload.data?.children ?? []).find(child => child.data?.name === fullname)?.data;
  if (!comment || typeof comment.parent_id !== "string" || typeof comment.body !== "string") return { status: "unavailable" };
  const body = normalizeRedditBody(unescapeRedditBody(comment.body));
  if (body === "[removed]" || body === "[deleted]") return { status: "mismatch", detail: "removed" };
  if (comment.parent_id !== parentId) return { status: "mismatch", detail: "parent_mismatch" };
  if (body !== normalizeRedditBody(approvedBody)) return { status: "mismatch", detail: "body_mismatch" };
  if (expectedAuthor) {
    if (typeof comment.author !== "string") return { status: "unavailable" };
    if (comment.author.toLowerCase() !== expectedAuthor.toLowerCase()) return { status: "mismatch", detail: "author_mismatch" };
  }
  return { status: "verified" };
}

async function notifyUncertain(store: Store, itemId: number, key: string, deps: PostDeps) {
  const owner = getConfig(store)?.ownerChatUid || process.env.AHA_OWNER_CHAT_UID;
  if (!owner) return;
  const lang = getConfig(store)?.language || "en";
  const text = lang.startsWith("pt")
    ? `Post incerto AHA-${itemId}. Vou conferir automaticamente e aviso você quando houver uma confirmação.`
    : `Uncertain Reddit post for AHA-${itemId}. I will check automatically and let you know when it is resolved.`;
  try {
    await sendToChat(owner, text, `uncertain:${key}`, { store, fetch: deps.fetch, now: deps.now });
  } catch {
    /* unit tests may omit Plow env */
  }
}

async function notifyVerificationMismatch(
  store: Store,
  itemId: number,
  key: string,
  detail: "parent_mismatch" | "body_mismatch" | "author_mismatch" | "removed",
  url: string | null,
  deps: PostDeps,
) {
  const owner = getConfig(store)?.ownerChatUid || process.env.AHA_OWNER_CHAT_UID;
  if (!owner) return;
  const lang = getConfig(store)?.language || "en";
  const reason = {
    parent_mismatch: { pt: "a resposta caiu em outro comentário ou post", en: "the reply landed under a different comment or post" },
    body_mismatch: { pt: "o texto publicado difere do aprovado", en: "the published text differs from the approved text" },
    author_mismatch: { pt: "a resposta foi publicada por outra conta", en: "the reply was posted by another account" },
    removed: { pt: "a resposta foi removida pela moderação", en: "the reply was removed by moderators" },
  }[detail];
  const text = lang.startsWith("pt")
    ? `Verificação do post AHA-${itemId}: ${reason.pt}. Confira: ${url ?? "link indisponível"}`
    : `AHA-${itemId} post verification: ${reason.en}. Check: ${url ?? "link unavailable"}`;
  try {
    await sendToChat(owner, text, `verify:${key}`, { store, fetch: deps.fetch, now: deps.now });
  } catch {
    /* unit tests may omit Plow env */
  }
}

function finish(store: Store, postKey: string, threadKey: string, state: string, url: string | null) {
  setLedger(store, postKey, state, url);
  setLedger(store, threadKey, state, url);
}

function releaseReadyReservation(store: Store, postKey: string, threadKey: string, url: string | null) {
  store.tx(() => {
    store.db.prepare(`DELETE FROM ledger WHERE state = 'ready' AND url IS ?
      AND key IN (?, ?)`).run(url, postKey, threadKey);
  });
}

export async function postReply(store: Store, draftId: number, deps: PostDeps = {}): Promise<PostResult> {
  return postReplyInternal(store, draftId, deps);
}

export async function retryAbsentPost(store: Store, draftId: number, actor: string, deps: PostDeps = {}): Promise<PostResult> {
  return postReplyInternal(store, draftId, deps, actor);
}

async function postReplyInternal(store: Store, draftId: number, deps: PostDeps, retryActor?: string): Promise<PostResult> {
  const draft = store.db.prepare(`SELECT id, item_id AS itemId, body, state,
      approved_sha256 AS approvedSha256, approved_at AS approvedAt FROM drafts WHERE id = ?`).get(draftId) as Draft | undefined;
  if (!draft) return "failed";
  const event = (action: DraftEventAction, detail?: DraftEventDetail) =>
    recordDraftEvent(store, { draftId: draft.id, itemId: draft.itemId, actor: "system", action, body: draft.body, detail, at: deps.now?.() });
  const item = store.db.prepare("SELECT source, external_id AS externalId, url FROM items WHERE id = ?").get(draft.itemId) as {
    source: string; externalId: string; url: string | null;
  } | undefined;
  if (!item) {
    event("failed", "item_missing");
    return "failed";
  }
  if (item.source !== "reddit") {
    event("failed", "unsupported_source");
    return "failed";
  }
  const now = deps.now?.() ?? new Date();
  const approvedAt = draft.approvedAt ? new Date(draft.approvedAt) : undefined;
  const reservationDay = approvedAt && Number.isFinite(approvedAt.getTime()) ? approvedAt : now;
  const originalPostKey = postLedgerKey(ymd(reservationDay), item.source, item.externalId, item.url);
  const key = postLedgerKey(ymd(retryActor ? now : reservationDay), item.source, item.externalId, item.url);
  const thread = threadLedgerKey(item.source, item.externalId, item.url);
  const approvedHashMatches = Boolean(draft.approvedSha256)
    && createHash("sha256").update(draft.body).digest("hex") === draft.approvedSha256;
  if (draft.state !== "approved" || !approvedHashMatches) {
    releaseReadyReservation(store, key, thread, item.url);
    event("post_refused", draft.state !== "approved" ? "not_approved" : "hash_mismatch");
    return "failed";
  }
  if (postingPaused(store)) {
    releaseReadyReservation(store, key, thread, item.url);
    event("post_refused", "paused");
    return "failed";
  }
  const claimed = retryActor
    ? claimAbsentRetry(store, {
      originalPostKey, retryPostKey: key, threadKey: thread, url: item.url, draftId: draft.id,
      itemId: draft.itemId, body: draft.body, approvedSha256: draft.approvedSha256!, approvedAt: now.toISOString(), actor: retryActor,
    })
    : claimKeys(store, key, thread, item.url);
  if (claimed !== "owned") {
    if (claimed === "uncertain") await notifyUncertain(store, draft.itemId, key, deps);
    if (claimed === "already_posted") {
      event("post_refused", "already_posted");
      return "posted";
    }
    if (claimed === "thread_taken") {
      event("post_refused", "thread_taken");
      return "failed";
    }
    if (claimed === "already_absent") {
      event("post_refused", "already_absent");
      return "failed";
    }
    if (claimed === "retry_refused") {
      event("post_refused", "already_absent");
      return "failed";
    }
    event(claimed === "uncertain" ? "uncertain" : "failed");
    return claimed;
  }
  const http = deps.fetch ?? fetch;
  const auth = deps.auth ?? redditAuth(deps.token ?? readSecrets().reddit, { fetch: http });
  // Posting needs a token for the account: an app-only token can only search.
  if (!auth?.canPost) {
    finish(store, key, thread, "failed", item.url);
    event("failed", "cannot_post");
    return "failed";
  }
  const body = new URLSearchParams({ api_type: "json", thing_id: item.externalId, text: draft.body }).toString();
  let response: Response;
  try {
    // A 401 means Reddit refused the token, so nothing was posted and a
    // renewed token may try once more.
    response = await withRedditToken(auth, token => http(COMMENT, withHttpTimeout({
      method: "POST",
      headers: { ...oauthHeaders(token), "Content-Type": "application/x-www-form-urlencoded" },
      body,
    })));
  } catch (error) {
    if (error instanceof RedditAuthError) {
      finish(store, key, thread, "failed", item.url);
      event("failed", "auth_error");
      return "failed";
    }
    finish(store, key, thread, "uncertain", item.url);
    event("uncertain", "network_error");
    await notifyUncertain(store, draft.itemId, key, deps);
    return "uncertain";
  }
  if (response.status === 401 || response.status === 403) {
    finish(store, key, thread, "failed", item.url);
    event("failed", `http_${response.status}`);
    return "failed";
  }
  if (!response.ok) {
    const next = response.status >= 500 ? "uncertain" : "failed";
    finish(store, key, thread, next, item.url);
    event(next, `http_${response.status}`);
    if (next === "uncertain") await notifyUncertain(store, draft.itemId, key, deps);
    return next;
  }
  let parsed: { id: string; permalink?: string } | undefined;
  try {
    parsed = commentId(await response.json());
  } catch {
    finish(store, key, thread, "uncertain", item.url);
    event("uncertain", "response_invalid");
    await notifyUncertain(store, draft.itemId, key, deps);
    return "uncertain";
  }
  if (!parsed) {
    finish(store, key, thread, "failed", item.url);
    event("failed", "response_invalid");
    return "failed";
  }
  const postedUrl = parsed.permalink
    ? (parsed.permalink.startsWith("http") ? parsed.permalink : `https://www.reddit.com${parsed.permalink}`)
    : item.url;
  finish(store, key, thread, "posted", postedUrl);
  event("posted");
  let verification: VerifyResult;
  try {
    const credential = readSecrets().reddit;
    const expectedAuthor = typeof credential === "object" ? credential.username : undefined;
    verification = await verify(http, await auth.token(), parsed.id, item.externalId, draft.body, expectedAuthor);
  } catch {
    verification = { status: "unavailable" };
  }
  if (verification.status === "verified") {
    finish(store, key, thread, "verified", postedUrl);
    event("verified");
  } else if (verification.status === "mismatch") {
    event("verify_mismatch", verification.detail);
    await notifyVerificationMismatch(store, draft.itemId, key, verification.detail, postedUrl, deps);
  } else {
    event("verify_unavailable", "verify_unavailable");
  }
  return "posted";
}
