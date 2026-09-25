import { getConfig, type AhaConfig } from "../config.ts";
import { type Store } from "../store/db.ts";
import { type RawItem, type SourceAdapter, type SourceQuery } from "../sources/types.ts";

export type IngestReport = {
  sources: { id: string; status: "ok" | "error" | "limitada"; stored: number; detail?: string }[];
};

const DAY_MS = 24 * 60 * 60 * 1000;

export function termsFrom(cfg: AhaConfig) {
  const raw = [
    cfg.company.name,
    cfg.company.product,
    ...(cfg.company.aliases ?? []),
    cfg.company.domain,
    ...(cfg.competitors ?? []),
  ].filter((value): value is string => Boolean(value && value.trim()));
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of raw) {
    const key = value.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function escapeRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// A name counts only as a whole word: "plow" matches "Plow", "plow's" and
// "plow.co", not "plowshares", "plowed" or "snowplow". Letters and digits on
// either side make it part of another word.
export function mentionsTerm(text: string, term: string) {
  const needle = term.trim();
  if (!needle) return false;
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(needle)}(?![\\p{L}\\p{N}])`, "iu").test(text);
}

export function passesFilter1(item: RawItem, cfg: AhaConfig) {
  // The url is left out of the searched text: a domain like "plow-pbc" can
  // appear in a source's own URL (e.g. the Agent Index repo path) without the
  // content itself mentioning the company, which used to let unrelated items
  // pass by accident.
  const text = `${item.title ?? ""} ${item.body}`;
  const hay = text.toLowerCase();
  // Negatives stay substring matches: they are exclusions the owner chose, and
  // excluding "plowing" should also exclude "plowings".
  const negative = (cfg.company.negative ?? []).map(word => word.toLowerCase());
  const passesNegative = !negative.some(word => word && hay.includes(word));
  // Agent Index comments already live inside an `agent:<slug>` discussion for
  // this company, and GitHub issues/discussions come from a configured product
  // repo, so they are on-topic by construction; only the negative word check
  // still applies (spec §6.2 is about disambiguating a bare mention).
  if (item.source === "agent-index" || item.source === "github") return passesNegative;
  if (!termsFrom(cfg).some(term => mentionsTerm(text, term))) return false;
  return passesNegative;
}

function queryFor(cfg: AhaConfig, now: Date, window?: { since: Date; until: Date }): SourceQuery {
  if (window) return { since: window.since, until: window.until, terms: termsFrom(cfg) };
  return { since: new Date(now.getTime() - DAY_MS), until: now, terms: termsFrom(cfg) };
}

export function insertItem(store: Store, item: RawItem, now: Date) {
  return store.db.prepare(`INSERT INTO items (source, external_id, url, author, title, body, published_at, fetched_at, state)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'new')
    ON CONFLICT (source, external_id) DO NOTHING`).run(
    item.source, item.externalId, item.url, item.author, item.title ?? null, item.body, item.publishedAt, now.toISOString(),
  ).changes;
}

function recordRun(store: Store, source: string, query: SourceQuery, status: string, detail: string | undefined) {
  store.db.prepare("INSERT INTO source_runs (source, window_start, window_end, status, detail) VALUES (?, ?, ?, ?, ?)").run(
    source, query.since.toISOString(), query.until.toISOString(), status, detail ?? null,
  );
}

const MAX_PAGES_PER_SOURCE = 500;

// `fetchImpl` is part of the public contract from spec §9.2; adapters already
// carry their own injected `fetch` from construction, so runIngest itself has
// nothing to pass it to today. Kept for interface compatibility with future
// adapters/tests that may want a shared default.
export async function runIngest(store: Store, adapters: SourceAdapter[], now: Date, _fetchImpl?: typeof fetch, window?: { since: Date; until: Date }): Promise<IngestReport> {
  const cfg = getConfig(store);
  if (!cfg) return { sources: [] };
  const query = queryFor(cfg, now, window);
  const sources: IngestReport["sources"] = [];
  for (const adapter of adapters) {
    if (!adapter.enabled(cfg)) continue;
    let stored = 0;
    let cursor: string | null = null;
    let status: IngestReport["sources"][number]["status"] = "ok";
    let detail: string | undefined;
    try {
      let pages = 0;
      do {
        const result = await adapter.fetch(query, cursor);
        if (!result.ok) {
          status = result.error === "rate_limited" ? "limitada" : "error";
          detail = result.error;
          break;
        }
        for (const item of result.items) {
          if (!passesFilter1(item, cfg)) continue;
          stored += Number(insertItem(store, item, now));
        }
        cursor = result.nextCursor;
        pages += 1;
        if (pages >= MAX_PAGES_PER_SOURCE && cursor) {
          status = "error";
          detail = "too_many_pages";
          break;
        }
      } while (cursor);
    } catch (error) {
      status = "error";
      detail = error instanceof Error ? error.message : "unknown";
    }
    recordRun(store, adapter.id, query, status, detail);
    sources.push({ id: adapter.id, status, stored, detail });
  }
  return { sources };
}
