import { type SourceAdapter, type FetchResult, type RawItem, type SourceQuery } from "./types.ts";

const HOST = "https://hn.algolia.com/api/v1/search_by_date";

export function htmlToText(html: string) {
  return html
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\s*\/\s*p\s*>/gi, "\n")
    .replace(/<\s*p(?:\s[^>]*)?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

type Hit = {
  objectID?: string;
  author?: string;
  title?: string;
  story_title?: string;
  url?: string;
  story_url?: string;
  comment_text?: string;
  story_text?: string;
  created_at?: string;
  created_at_i?: number;
  parent_id?: number;
  story_id?: number;
};

function itemUrl(id: string) {
  return `https://news.ycombinator.com/item?id=${id}`;
}

function hitToItem(hit: Hit): RawItem | undefined {
  const externalId = hit.objectID;
  if (!externalId) return;
  const title = hit.title || hit.story_title;
  const body = htmlToText(hit.comment_text || hit.story_text || title || "");
  const publishedAt = hit.created_at || (hit.created_at_i ? new Date(hit.created_at_i * 1000).toISOString() : "");
  return {
    source: "hn",
    externalId,
    url: itemUrl(externalId),
    author: hit.author || "",
    title,
    body,
    publishedAt,
    parentUrl: hit.parent_id ? itemUrl(String(hit.parent_id)) : hit.story_url,
  };
}

function retryAfterMs(headers: Headers) {
  const raw = headers.get("retry-after");
  if (!raw) return;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return seconds * 1000;
}

async function read(response: Response): Promise<FetchResult> {
  if (response.status === 429) return { ok: false, error: "rate_limited", retryAfterMs: retryAfterMs(response.headers) };
  if (response.status === 401 || response.status === 403) return { ok: false, error: "auth" };
  if (!response.ok) return { ok: false, error: "unknown" };
  const payload = await response.json() as { hits?: Hit[]; page?: number; nbPages?: number };
  const page = payload.page ?? 0;
  const nbPages = payload.nbPages ?? 0;
  return {
    ok: true,
    items: (payload.hits ?? []).flatMap(hit => {
      const item = hitToItem(hit);
      return item ? [item] : [];
    }),
    nextCursor: page + 1 < nbPages ? String(page + 1) : null,
  };
}

export function hnSource(http: typeof fetch = fetch): SourceAdapter {
  return {
    id: "hn",
    enabled() {
      return true;
    },
    async fetch(query: SourceQuery, cursor: string | null): Promise<FetchResult> {
      const page = cursor ? Number(cursor) : 0;
      const terms = query.terms.filter(Boolean).join(" OR ");
      const since = Math.floor(query.since.getTime() / 1000);
      const until = Math.floor(query.until.getTime() / 1000);
      const url = `${HOST}?query=${encodeURIComponent(terms)}&numericFilters=${encodeURIComponent(`created_at_i>${since},created_at_i<${until}`)}&hitsPerPage=50&page=${page}`;
      try {
        return await read(await http(url));
      } catch {
        return { ok: false, error: "network" };
      }
    },
  };
}
