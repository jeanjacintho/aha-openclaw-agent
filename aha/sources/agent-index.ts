import { type SourceAdapter, type FetchResult, type RawItem, type SourceQuery } from "./types.ts";
import { retryAfterMs } from "./http.ts";

const GQL = "https://api.github.com/graphql";
const OWNER = "plow-pbc";
const REPO = "agent-index-comments";

const QUERY = `query($after: String) {
  repository(owner: "${OWNER}", name: "${REPO}") {
    discussions(first: 50, after: $after, orderBy: { field: UPDATED_AT, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      nodes {
        title url createdAt updatedAt
        comments(last: 100) {
          nodes {
            id url createdAt body author { login }
            replies(last: 100) {
              nodes { id url createdAt body author { login } }
            }
          }
        }
      }
    }
  }
}`;

type CommentNode = {
  id?: string;
  url?: string;
  createdAt?: string;
  body?: string;
  author?: { login?: string } | null;
  replies?: { nodes?: CommentNode[] };
};

type DiscussionNode = {
  title?: string;
  url?: string;
  updatedAt?: string;
  comments?: { nodes?: CommentNode[] };
};

type GraphQLError = { type?: string; message?: string };

// GitHub returns HTTP 403 both for auth failures and for primary/secondary
// rate limits. Rate limits carry either a Retry-After header (secondary) or
// X-RateLimit-Remaining: 0 with X-RateLimit-Reset (primary); anything else is auth.
function rateLimitFrom403(headers: Headers): { limited: boolean; retryAfterMs?: number } {
  const retryAfter = retryAfterMs(headers);
  if (retryAfter !== undefined) return { limited: true, retryAfterMs: retryAfter };
  if (headers.get("x-ratelimit-remaining") === "0") {
    const reset = headers.get("x-ratelimit-reset");
    const resetMs = reset ? Number(reset) * 1000 : undefined;
    return { limited: true, retryAfterMs: resetMs && Number.isFinite(resetMs) ? Math.max(0, resetMs - Date.now()) : undefined };
  }
  return { limited: false };
}

function inWindow(at: string | undefined, query: SourceQuery) {
  if (!at) return false;
  const ms = Date.parse(at);
  return Number.isFinite(ms) && ms >= query.since.getTime() && ms < query.until.getTime();
}

function toItem(node: CommentNode, parentUrl: string | undefined, query: SourceQuery): RawItem[] {
  const replies = (node.replies?.nodes ?? []).flatMap(reply => toItem(reply, node.url || parentUrl, query));
  if (!node.id || !inWindow(node.createdAt, query)) return replies;
  return [{
    source: "agent-index",
    externalId: node.id,
    url: node.url || parentUrl || "",
    author: node.author?.login || "",
    body: node.body || "",
    publishedAt: node.createdAt || "",
    parentUrl,
  }, ...replies];
}

export function agentIndexSource(opts: { fetch?: typeof fetch; token?: string; slug?: string } = {}): SourceAdapter {
  const http = opts.fetch ?? fetch;
  const token = opts.token ?? "";
  const slug = opts.slug ?? "";
  return {
    id: "agent-index",
    enabled() {
      return token.length > 0 && slug.length > 0;
    },
    async fetch(query: SourceQuery, cursor: string | null): Promise<FetchResult> {
      if (!token) return { ok: false, error: "auth" };
      try {
        const response = await http(GQL, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ query: QUERY, variables: { after: cursor } }),
        });
        if (response.status === 429) return { ok: false, error: "rate_limited", retryAfterMs: retryAfterMs(response.headers) };
        if (response.status === 403) {
          const rateLimit = rateLimitFrom403(response.headers);
          if (rateLimit.limited) return { ok: false, error: "rate_limited", retryAfterMs: rateLimit.retryAfterMs };
          return { ok: false, error: "auth" };
        }
        if (response.status === 401) return { ok: false, error: "auth" };
        if (!response.ok) return { ok: false, error: "unknown" };
        const payload = await response.json() as {
          data?: { repository?: { discussions?: { pageInfo?: { hasNextPage?: boolean; endCursor?: string }; nodes?: DiscussionNode[] } } };
          errors?: GraphQLError[];
        };
        // GraphQL returns HTTP 200 even when the query fails; an `errors` array
        // must not be read as "no mentions" (spec §6.5: unknown health, not zero).
        if (payload.errors && payload.errors.length > 0) {
          const rateLimited = payload.errors.some(error => error.type === "RATE_LIMITED");
          return { ok: false, error: rateLimited ? "rate_limited" : "unknown" };
        }
        const discussions = payload.data?.repository?.discussions;
        const nodes = discussions?.nodes ?? [];
        const prefix = `agent:${slug}`;
        const items = nodes
          .filter(node => (node.title || "").trim() === prefix || (node.title || "").startsWith(`${prefix} `))
          .flatMap(node => (node.comments?.nodes ?? []).flatMap(comment => toItem(comment, node.url, query)));
        // Discussions come back UPDATED_AT DESC: once the oldest node on this page
        // is already older than the window, every later page is older still, so
        // stop instead of walking the whole repository every round.
        const oldest = nodes[nodes.length - 1];
        const pastWindow = oldest !== undefined && Date.parse(oldest.updatedAt ?? "") < query.since.getTime();
        const next = !pastWindow && discussions?.pageInfo?.hasNextPage ? discussions.pageInfo.endCursor ?? null : null;
        return { ok: true, items, nextCursor: next };
      } catch {
        return { ok: false, error: "network" };
      }
    },
  };
}
