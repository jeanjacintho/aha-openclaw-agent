import { getConfig, type AhaConfig } from "../config.ts";
import { type Store } from "../store/db.ts";
import { type RawItem, type SourceAdapter, type SourceQuery } from "../sources/types.ts";

export type IngestReport = {
  sources: { id: string; status: "ok" | "error" | "limitada"; stored: number; detail?: string }[];
};

const DAY_MS = 24 * 60 * 60 * 1000;

export function termsFrom(cfg: AhaConfig) {
  return [...new Set([cfg.company.name, ...(cfg.company.aliases ?? []), cfg.company.domain].filter((value): value is string => Boolean(value && value.trim())))];
}

export function passesFilter1(item: RawItem, cfg: AhaConfig) {
  const hay = `${item.title ?? ""} ${item.body} ${item.url}`.toLowerCase();
  const aliases = termsFrom(cfg).map(term => term.toLowerCase());
  if (!aliases.some(term => hay.includes(term.toLowerCase()))) return false;
  return !(cfg.company.negative ?? []).some(word => word && hay.includes(word.toLowerCase()));
}

function queryFor(cfg: AhaConfig, now: Date): SourceQuery {
  return { since: new Date(now.getTime() - DAY_MS), until: now, terms: termsFrom(cfg) };
}

function insertItem(store: Store, item: RawItem, now: Date) {
  return store.db.prepare(`INSERT INTO items (source, external_id, url, author, title, body, published_at, fetched_at, state)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'new')
    ON CONFLICT (source, external_id) DO NOTHING`).run(
    item.source, item.externalId, item.url, item.author, item.title ?? null, item.body, item.publishedAt, now.toISOString(),
  ).changes;
}

function recordRun(store: Store, source: string, query: SourceQuery, status: string, detail: string | undefined, stored: number) {
  store.db.prepare("INSERT INTO source_runs (source, window_start, window_end, status, detail) VALUES (?, ?, ?, ?, ?)").run(
    source, query.since.toISOString(), query.until.toISOString(), status, detail ?? (stored ? String(stored) : null),
  );
}

export async function runIngest(store: Store, adapters: SourceAdapter[], now: Date, _fetchImpl?: typeof fetch): Promise<IngestReport> {
  const cfg = getConfig(store);
  if (!cfg) return { sources: [] };
  const query = queryFor(cfg, now);
  const sources: IngestReport["sources"] = [];
  for (const adapter of adapters) {
    if (!adapter.enabled(cfg)) continue;
    let stored = 0;
    let cursor: string | null = null;
    let status: IngestReport["sources"][number]["status"] = "ok";
    let detail: string | undefined;
    try {
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
      } while (cursor);
    } catch (error) {
      status = "error";
      detail = error instanceof Error ? error.message : "unknown";
    }
    recordRun(store, adapter.id, query, status, detail, stored);
    sources.push({ id: adapter.id, status, stored, detail });
  }
  return { sources };
}
