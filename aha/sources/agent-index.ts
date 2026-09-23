import { type SourceAdapter, type FetchResult, type RawItem, type SourceQuery } from "./types.ts";

const GQL = "https://api.github.com/graphql";
const OWNER = "plow-pbc";
const REPO = "agent-index-comments";

const QUERY = `query($after: String) {
  repository(owner: "${OWNER}", name: "${REPO}") {
    discussions(first: 50, after: $after, orderBy: { field: UPDATED_AT, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      nodes {
        title url createdAt
        comments(first: 100) {
          nodes {
            id url createdAt body author { login }
            replies(first: 100) {
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
  comments?: { nodes?: CommentNode[] };
};

function retryAfterMs(headers: Headers) {
  const raw = headers.get("retry-after");
  if (!raw) return;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return seconds * 1000;
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
        if (response.status === 401 || response.status === 403) return { ok: false, error: "auth" };
        if (!response.ok) return { ok: false, error: "unknown" };
        const payload = await response.json() as {
          data?: { repository?: { discussions?: { pageInfo?: { hasNextPage?: boolean; endCursor?: string }; nodes?: DiscussionNode[] } } };
        };
        const discussions = payload.data?.repository?.discussions;
        const prefix = `agent:${slug}`;
        const items = (discussions?.nodes ?? [])
          .filter(node => (node.title || "").trim() === prefix || (node.title || "").startsWith(`${prefix} `))
          .flatMap(node => (node.comments?.nodes ?? []).flatMap(comment => toItem(comment, node.url, query)));
        const next = discussions?.pageInfo?.hasNextPage ? discussions.pageInfo.endCursor ?? null : null;
        return { ok: true, items, nextCursor: next };
      } catch {
        return { ok: false, error: "network" };
      }
    },
  };
}
