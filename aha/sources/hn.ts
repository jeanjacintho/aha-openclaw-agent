import { type SourceAdapter, type FetchResult, type RawItem, type SourceQuery } from "./types.ts";
import { retryAfterMs } from "./http.ts";

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

export function uniqueTermsCaseInsensitive(terms: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const term of terms) {
    const trimmed = term.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}

function parseCursor(cursor: string | null): { termIndex: number; page: number } {
  if (!cursor) return { termIndex: 0, page: 0 };
  const [termIndex, page] = cursor.split(":");
  return { termIndex: Number(termIndex) || 0, page: Number(page) || 0 };
}

function encodeCursor(termIndex: number, page: number) {
  return `${termIndex}:${page}`;
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

async function read(response: Response, termIndex: number, termsCount: number, page: number): Promise<FetchResult> {
  if (response.status === 429) return { ok: false, error: "rate_limited", retryAfterMs: retryAfterMs(response.headers) };
  if (response.status === 401 || response.status === 403) return { ok: false, error: "auth" };
  if (!response.ok) return { ok: false, error: "unknown" };
  const payload = await response.json() as { hits?: Hit[]; page?: number; nbPages?: number };
  const nbPages = payload.nbPages ?? 0;
  let nextCursor: string | null;
  if (page + 1 < nbPages) nextCursor = encodeCursor(termIndex, page + 1);
  else if (termIndex + 1 < termsCount) nextCursor = encodeCursor(termIndex + 1, 0);
  else nextCursor = null;
  return {
    ok: true,
    items: (payload.hits ?? []).flatMap(hit => {
      const item = hitToItem(hit);
      return item ? [item] : [];
    }),
    nextCursor,
  };
}

export function hnSource(http: typeof fetch = fetch): SourceAdapter {
  return {
    id: "hn",
    enabled() {
      return true;
    },
    async fetch(query: SourceQuery, cursor: string | null): Promise<FetchResult> {
      const terms = uniqueTermsCaseInsensitive(query.terms);
      if (terms.length === 0) return { ok: true, items: [], nextCursor: null };
      const { termIndex, page } = parseCursor(cursor);
      const boundedIndex = termIndex < terms.length ? termIndex : 0;
      const term = terms[boundedIndex];
      const since = Math.floor(query.since.getTime() / 1000);
      const until = Math.floor(query.until.getTime() / 1000);
      // The HN Algolia API has no OR operator: "a OR b" is searched as the literal
      // required words "a", "OR", "b". Each term gets its own request instead.
      const url = `${HOST}?query=${encodeURIComponent(term)}&numericFilters=${encodeURIComponent(`created_at_i>${since},created_at_i<${until}`)}&hitsPerPage=50&page=${page}&typoTolerance=false`;
      try {
        return await read(await http(url), boundedIndex, terms.length, page);
      } catch {
        return { ok: false, error: "network" };
      }
    },
  };
}
