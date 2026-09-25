import { uniqueTermsCaseInsensitive } from "./hn.ts";
import { retryAfterMs } from "./http.ts";
import { type SourceAdapter, type FetchResult, type RawItem, type SourceQuery } from "./types.ts";
import { REDDIT_USER_AGENT, RedditAuthError, redditAuth, type RedditAuth } from "./reddit-auth.ts";

export { REDDIT_USER_AGENT };
const SEARCH = "https://oauth.reddit.com/search";

type Child = {
  kind?: string;
  data?: {
    id?: string;
    name?: string;
    author?: string;
    body?: string;
    title?: string;
    created_utc?: number;
    permalink?: string;
    subreddit?: string;
    link_id?: string;
    parent_id?: string;
  };
};

type Cursor = { i: number; after: string | null };

function parseCursor(cursor: string | null): Cursor {
  if (!cursor) return { i: 0, after: null };
  try {
    const parsed = JSON.parse(cursor) as Cursor;
    return { i: Number(parsed.i) || 0, after: parsed.after ?? null };
  } catch {
    return { i: 0, after: null };
  }
}

function redditUrl(permalink: string | undefined, name: string) {
  if (permalink) return permalink.startsWith("http") ? permalink : `https://www.reddit.com${permalink}`;
  return `https://www.reddit.com/${name}`;
}

function inWindow(createdUtc: number | undefined, query: SourceQuery) {
  if (createdUtc === undefined) return false;
  const ms = createdUtc * 1000;
  return ms >= query.since.getTime() && ms < query.until.getTime();
}

function toItem(child: Child): RawItem | undefined {
  const data = child.data;
  const name = data?.name || (data?.id ? `t1_${data.id}` : "");
  if (!name) return;
  const permalink = data?.permalink;
  const thread = data?.link_id || (data?.parent_id && data.parent_id !== name ? data.parent_id : undefined);
  return {
    source: "reddit",
    externalId: name,
    url: redditUrl(permalink, name),
    author: data?.author || "",
    title: data?.title,
    body: data?.body || data?.title || "",
    publishedAt: data?.created_utc ? new Date(data.created_utc * 1000).toISOString() : "",
    parentUrl: thread ? redditUrl(undefined, thread) : undefined,
  };
}

function oauthHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    "User-Agent": REDDIT_USER_AGENT,
    Accept: "application/json",
  };
}

// A request with a token that is renewed first when close to expiry, and once
// more if Reddit still answers 401 (revoked or expired early).
export async function withRedditToken(auth: RedditAuth, send: (token: string) => Promise<Response>): Promise<Response> {
  const first = await send(await auth.token());
  if (first.status !== 401) return first;
  auth.invalidate();
  return send(await auth.token());
}

export function redditSource(opts: { fetch?: typeof fetch; token?: string; auth?: RedditAuth } = {}): SourceAdapter {
  const http = opts.fetch ?? fetch;
  const auth = opts.auth ?? (opts.token ? redditAuth(opts.token) : undefined);
  return {
    id: "reddit",
    enabled() {
      return Boolean(auth);
    },
    async fetch(query: SourceQuery, cursor: string | null): Promise<FetchResult> {
      if (!auth) return { ok: false, error: "auth" };
      const terms = uniqueTermsCaseInsensitive(query.terms);
      if (terms.length === 0) return { ok: true, items: [], nextCursor: null };
      const state = parseCursor(cursor);
      const boundedIndex = state.i < terms.length ? state.i : 0;
      const term = terms[boundedIndex];
      const url = `${SEARCH}?q=${encodeURIComponent(term)}&sort=new&type=comment&limit=100${state.after ? `&after=${encodeURIComponent(state.after)}` : ""}`;
      try {
        let response: Response;
        try {
          response = await withRedditToken(auth, token => http(url, { headers: oauthHeaders(token) }));
        } catch (error) {
          if (error instanceof RedditAuthError) return { ok: false, error: "auth" };
          throw error;
        }
        if (response.status === 429) return { ok: false, error: "rate_limited", retryAfterMs: retryAfterMs(response.headers) };
        if (response.status === 401 || response.status === 403) return { ok: false, error: "auth" };
        if (!response.ok) return { ok: false, error: "unknown" };
        const payload = await response.json() as { data?: { after?: string | null; children?: Child[] } };
        const children = payload.data?.children ?? [];
        const items = children.flatMap(child => {
          const created = child.data?.created_utc;
          const item = inWindow(created, query) ? toItem(child) : undefined;
          return item ? [item] : [];
        });
        const after = payload.data?.after ?? null;
        let next: Cursor | null = null;
        if (after) next = { i: boundedIndex, after };
        else if (boundedIndex + 1 < terms.length) next = { i: boundedIndex + 1, after: null };
        return { ok: true, items, nextCursor: next ? JSON.stringify(next) : null };
      } catch {
        return { ok: false, error: "network" };
      }
    },
  };
}
