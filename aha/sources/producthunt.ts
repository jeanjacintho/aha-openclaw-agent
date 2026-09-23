import { uniqueTermsCaseInsensitive } from "./hn.ts";
import { phQueryComplexity, phRemaining, phResetMs, phShouldBackoff, retryAfterMs } from "./http.ts";
import { type SourceAdapter, type FetchResult, type RawItem, type SourceQuery } from "./types.ts";

const GQL = "https://api.producthunt.com/v2/api/graphql";

const QUERY = `query($slug: String!, $after: String) {
  post(slug: $slug) {
    id name slug url
    comments(first: 20, after: $after) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id body createdAt
          user { username }
        }
      }
    }
  }
}`;

type CommentNode = {
  id?: string;
  body?: string;
  createdAt?: string;
  user?: { username?: string } | null;
};

type PostNode = {
  id?: string;
  name?: string;
  slug?: string;
  url?: string;
  comments?: {
    pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
    edges?: { node?: CommentNode | null }[];
  };
};

type GraphQLError = { type?: string; message?: string };

type Cursor = {
  i: number;
  after: string | null;
  remaining?: number;
  cost?: number;
  resetMs?: number;
};

export function phSlug(term: string) {
  return term.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function slugsFrom(terms: string[]) {
  return uniqueTermsCaseInsensitive(terms.map(phSlug).filter(Boolean));
}

function parseCursor(cursor: string | null): Cursor {
  if (!cursor) return { i: 0, after: null };
  try {
    const parsed = JSON.parse(cursor) as Cursor;
    return {
      i: Number(parsed.i) || 0,
      after: parsed.after ?? null,
      remaining: parsed.remaining,
      cost: parsed.cost,
      resetMs: parsed.resetMs,
    };
  } catch {
    return { i: 0, after: null };
  }
}

function encodeCursor(cursor: Cursor) {
  return JSON.stringify(cursor);
}

function inWindow(at: string | undefined, query: SourceQuery) {
  if (!at) return false;
  const ms = Date.parse(at);
  return Number.isFinite(ms) && ms >= query.since.getTime() && ms < query.until.getTime();
}

function toItem(node: CommentNode, post: PostNode): RawItem | undefined {
  if (!node.id) return;
  const slug = post.slug || "post";
  const parentUrl = post.url || `https://www.producthunt.com/posts/${slug}`;
  return {
    source: "ph",
    externalId: node.id,
    url: `${parentUrl}#comment-${node.id}`,
    author: node.user?.username || "",
    title: post.name,
    body: node.body || "",
    publishedAt: node.createdAt || "",
    parentUrl,
  };
}

export function productHuntSource(opts: { fetch?: typeof fetch; token?: string } = {}): SourceAdapter {
  const http = opts.fetch ?? fetch;
  const token = opts.token ?? "";
  return {
    id: "ph",
    enabled() {
      return token.length > 0;
    },
    async fetch(query: SourceQuery, cursor: string | null): Promise<FetchResult> {
      if (!token) return { ok: false, error: "auth" };
      const slugs = slugsFrom(query.terms);
      if (slugs.length === 0) return { ok: true, items: [], nextCursor: null };
      const state = parseCursor(cursor);
      if (phShouldBackoff(state.remaining, state.cost)) {
        return { ok: false, error: "rate_limited", retryAfterMs: state.resetMs };
      }
      const boundedIndex = state.i < slugs.length ? state.i : 0;
      const slug = slugs[boundedIndex];
      try {
        const response = await http(GQL, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ query: QUERY, variables: { slug, after: state.after } }),
        });
        if (response.status === 429) {
          return { ok: false, error: "rate_limited", retryAfterMs: phResetMs(response.headers) };
        }
        if (response.status === 401 || response.status === 403) return { ok: false, error: "auth" };
        if (!response.ok) return { ok: false, error: "unknown" };
        const remaining = phRemaining(response.headers);
        const cost = phQueryComplexity(response.headers);
        const resetMs = phResetMs(response.headers);
        const payload = await response.json() as {
          data?: { post?: PostNode | null };
          errors?: GraphQLError[];
        };
        if (payload.errors && payload.errors.length > 0) {
          const rateLimited = payload.errors.some(error => /rate.?limit/i.test(error.type || "") || /rate.?limit/i.test(error.message || ""));
          return { ok: false, error: rateLimited ? "rate_limited" : "unknown", retryAfterMs: rateLimited ? resetMs : undefined };
        }
        const post = payload.data?.post;
        const edges = post?.comments?.edges ?? [];
        const items = post
          ? edges.flatMap(edge => {
            const item = edge.node && inWindow(edge.node.createdAt, query) ? toItem(edge.node, post) : undefined;
            return item ? [item] : [];
          })
          : [];
        const hasNext = Boolean(post?.comments?.pageInfo?.hasNextPage);
        const nextAfter = post?.comments?.pageInfo?.endCursor ?? null;
        let next: Cursor | null = null;
        if (hasNext && nextAfter) next = { i: boundedIndex, after: nextAfter, remaining, cost, resetMs };
        else if (boundedIndex + 1 < slugs.length) next = { i: boundedIndex + 1, after: null, remaining, cost, resetMs };
        return { ok: true, items, nextCursor: next ? encodeCursor(next) : null };
      } catch {
        return { ok: false, error: "network" };
      }
    },
  };
}
