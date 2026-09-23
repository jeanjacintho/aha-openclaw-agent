import { type AhaConfig } from "../config.ts";
import { retryAfterMs } from "./http.ts";
import { type SourceAdapter, type FetchResult, type RawItem, type SourceQuery } from "./types.ts";

const GQL = "https://api.github.com/graphql";

const ISSUES_QUERY = `query($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    issues(first: 50, after: $after, orderBy: { field: UPDATED_AT, direction: DESC }, states: [OPEN, CLOSED]) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id number title url createdAt updatedAt body author { login }
        comments(last: 50) {
          nodes { id url createdAt body author { login } }
        }
      }
    }
  }
}`;

const DISCUSSIONS_QUERY = `query($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    discussions(first: 50, after: $after, orderBy: { field: UPDATED_AT, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id title url createdAt updatedAt body author { login }
        comments(last: 50) {
          nodes {
            id url createdAt body author { login }
            replies(last: 50) {
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

type IssueNode = {
  id?: string;
  number?: number;
  title?: string;
  url?: string;
  createdAt?: string;
  updatedAt?: string;
  body?: string;
  author?: { login?: string } | null;
  comments?: { nodes?: CommentNode[] };
};

type DiscussionNode = {
  id?: string;
  title?: string;
  url?: string;
  createdAt?: string;
  updatedAt?: string;
  body?: string;
  author?: { login?: string } | null;
  comments?: { nodes?: CommentNode[] };
};

type GraphQLError = { type?: string; message?: string };

type Repo = { owner: string; name: string };

type Kind = "issues" | "discussions";

type Cursor = { r: number; k: Kind; after: string | null };

export function parseGithubRepos(cfg: AhaConfig | null): Repo[] {
  const seen = new Set<string>();
  const result: Repo[] = [];
  for (const raw of cfg?.githubRepos ?? []) {
    const match = raw.trim().match(/^([^/\s]+)\/([^/\s]+)$/);
    if (!match) continue;
    const owner = match[1];
    const name = match[2].replace(/\.git$/, "");
    const key = `${owner.toLowerCase()}/${name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ owner, name });
  }
  return result;
}

function parseCursor(cursor: string | null): Cursor {
  if (!cursor) return { r: 0, k: "issues", after: null };
  try {
    const parsed = JSON.parse(cursor) as Cursor;
    return {
      r: Number(parsed.r) || 0,
      k: parsed.k === "discussions" ? "discussions" : "issues",
      after: parsed.after ?? null,
    };
  } catch {
    return { r: 0, k: "issues", after: null };
  }
}

function encodeCursor(cursor: Cursor) {
  return JSON.stringify(cursor);
}

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

function commentItems(nodes: CommentNode[] | undefined, parentUrl: string | undefined, query: SourceQuery): RawItem[] {
  return (nodes ?? []).flatMap(node => {
    const replies = commentItems(node.replies?.nodes, node.url || parentUrl, query);
    if (!node.id || !inWindow(node.createdAt, query)) return replies;
    return [{
      source: "github",
      externalId: node.id,
      url: node.url || parentUrl || "",
      author: node.author?.login || "",
      body: node.body || "",
      publishedAt: node.createdAt || "",
      parentUrl,
    }, ...replies];
  });
}

function issueItems(node: IssueNode, query: SourceQuery): RawItem[] {
  const comments = commentItems(node.comments?.nodes, node.url, query);
  if (!node.id || !inWindow(node.createdAt, query)) return comments;
  return [{
    source: "github",
    externalId: node.id,
    url: node.url || "",
    author: node.author?.login || "",
    title: node.title,
    body: node.body || node.title || "",
    publishedAt: node.createdAt || "",
  }, ...comments];
}

function discussionItems(node: DiscussionNode, query: SourceQuery): RawItem[] {
  const comments = commentItems(node.comments?.nodes, node.url, query);
  if (!node.id || !inWindow(node.createdAt, query)) return comments;
  return [{
    source: "github",
    externalId: node.id,
    url: node.url || "",
    author: node.author?.login || "",
    title: node.title,
    body: node.body || node.title || "",
    publishedAt: node.createdAt || "",
  }, ...comments];
}

export function githubSource(opts: { fetch?: typeof fetch; token?: string; repos?: Repo[] } = {}): SourceAdapter {
  const http = opts.fetch ?? fetch;
  const token = opts.token ?? "";
  const pinned = opts.repos;
  return {
    id: "github",
    enabled() {
      return token.length > 0 && (pinned?.length ?? 0) > 0;
    },
    async fetch(query: SourceQuery, cursor: string | null): Promise<FetchResult> {
      if (!token) return { ok: false, error: "auth" };
      const repos = pinned ?? [];
      if (repos.length === 0) return { ok: true, items: [], nextCursor: null };
      const state = parseCursor(cursor);
      if (state.r >= repos.length) return { ok: true, items: [], nextCursor: null };
      const repo = repos[state.r];
      const gql = state.k === "issues" ? ISSUES_QUERY : DISCUSSIONS_QUERY;
      try {
        const response = await http(GQL, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ query: gql, variables: { owner: repo.owner, name: repo.name, after: state.after } }),
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
          data?: {
            repository?: {
              issues?: { pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }; nodes?: IssueNode[] };
              discussions?: { pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }; nodes?: DiscussionNode[] };
            };
          };
          errors?: GraphQLError[];
        };
        if (payload.errors && payload.errors.length > 0) {
          const rateLimited = payload.errors.some(error => error.type === "RATE_LIMITED");
          return { ok: false, error: rateLimited ? "rate_limited" : "unknown" };
        }
        const repoData = payload.data?.repository;
        let items: RawItem[] = [];
        let hasNext = false;
        let endCursor: string | null = null;
        let pastWindow = false;
        if (state.k === "issues") {
          const conn = repoData?.issues;
          const nodes = conn?.nodes ?? [];
          items = nodes.flatMap(node => issueItems(node, query));
          hasNext = Boolean(conn?.pageInfo?.hasNextPage);
          endCursor = conn?.pageInfo?.endCursor ?? null;
          const oldest = nodes[nodes.length - 1];
          pastWindow = oldest !== undefined && Date.parse(oldest.updatedAt ?? "") < query.since.getTime();
        } else {
          const conn = repoData?.discussions;
          const nodes = conn?.nodes ?? [];
          items = nodes.flatMap(node => discussionItems(node, query));
          hasNext = Boolean(conn?.pageInfo?.hasNextPage);
          endCursor = conn?.pageInfo?.endCursor ?? null;
          const oldest = nodes[nodes.length - 1];
          pastWindow = oldest !== undefined && Date.parse(oldest.updatedAt ?? "") < query.since.getTime();
        }
        let next: Cursor | null = null;
        if (!pastWindow && hasNext && endCursor) next = { r: state.r, k: state.k, after: endCursor };
        else if (state.k === "issues") next = { r: state.r, k: "discussions", after: null };
        else if (state.r + 1 < repos.length) next = { r: state.r + 1, k: "issues", after: null };
        return { ok: true, items, nextCursor: next ? encodeCursor(next) : null };
      } catch {
        return { ok: false, error: "network" };
      }
    },
  };
}
