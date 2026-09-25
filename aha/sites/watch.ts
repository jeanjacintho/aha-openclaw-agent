import { getConfig } from "../config.ts";
import { LatchError, latchClient, withBrowser, type LatchClient } from "../latch/bridge.ts";
import { insertItem, passesFilter1 } from "../pipeline/ingest.ts";
import { type Store } from "../store/db.ts";
import { blocksToRawItems, diffBlocks, extractBlocks } from "./extract.ts";
import { getCursor, listSites, recordSiteRun, saveCursor, type Site } from "./store.ts";

// D4: characters per page, and how far ahead of the digest the cycle runs.
export const SITE_MAX_CHARS = 12_000;
export const SITE_HOUR_OFFSET_FROM_DIGEST = 1;

export type SiteWatchReport = {
  visited: number;
  stored: number;
  degraded: { url: string; reason: string }[];
};

function reasonFor(error: unknown): string {
  if (error instanceof LatchError) return `${error.kind}: ${error.message}`;
  return error instanceof Error ? error.message : "failed";
}

function siteOrigins(url: string): string[] {
  const host = new URL(url).hostname;
  return [host, `*.${host}`];
}

function recordAggregateRun(store: Store, now: Date, status: "ok" | "degraded", detail: string | undefined) {
  store.db.prepare("INSERT INTO source_runs (source, window_start, window_end, status, detail) VALUES ('site', ?, ?, ?, ?)").run(
    now.toISOString(), now.toISOString(), status, detail?.slice(0, 500) ?? null,
  );
}

async function visitSite(store: Store, site: Site, cfg: NonNullable<ReturnType<typeof getConfig>>, now: Date, maxChars: number, browser: (action: string, args?: Record<string, unknown>) => Promise<Record<string, unknown>>): Promise<number> {
  await browser("goto", { url: site.url });
  const page = await browser("text", { max_chars: maxChars }) as { text?: string };
  const links = await browser("links", {}) as { links?: { href: string; text: string }[] };
  const blocks = extractBlocks({ url: site.url, text: page.text ?? "", links: links.links });
  const { newBlocks, nextCursor } = diffBlocks(blocks, getCursor(store, site.id));
  const candidates = blocksToRawItems({ url: site.url, label: site.label }, newBlocks, now);
  const kept = site.mode === "all" ? candidates : candidates.filter(item => passesFilter1(item, cfg));
  let stored = 0;
  for (const item of kept) stored += Number(insertItem(store, item, now));
  saveCursor(store, site.id, nextCursor);
  return stored;
}

/**
 * The daily Latch site watch (SW-5): one browser session for every active
 * site's origin, then each registered page in turn. New content since the
 * last visit is filtered (per site `mode`), classified and digested the same
 * way as every other source, once the next 15-minute ingest cycle runs.
 *
 * Latch unavailable, denied or paused degrades this run without touching the
 * 15-minute API polling, which is a separate job.
 */
export async function runSiteWatch(store: Store, deps: { latch?: LatchClient; now?: () => Date; maxChars?: number } = {}): Promise<SiteWatchReport> {
  const cfg = getConfig(store);
  const report: SiteWatchReport = { visited: 0, stored: 0, degraded: [] };
  if (!cfg) return report;
  const sites = listSites(store).filter(site => site.active);
  if (sites.length === 0) return report;
  const now = deps.now?.() ?? new Date();
  const maxChars = deps.maxChars ?? SITE_MAX_CHARS;
  const client = deps.latch ?? latchClient();
  const origins = [...new Set(sites.flatMap(site => siteOrigins(site.url)))];

  try {
    await withBrowser(client, origins, "AHA daily site watch: reading the pages the owner registered for this company", async browser => {
      for (const site of sites) {
        report.visited += 1;
        try {
          report.stored += await visitSite(store, site, cfg, now, maxChars, browser);
          recordSiteRun(store, site.id, "ok", undefined, now);
        } catch (error) {
          const reason = reasonFor(error);
          recordSiteRun(store, site.id, "degraded", reason, now);
          report.degraded.push({ url: site.url, reason });
        }
      }
    });
  } catch (error) {
    // The browser session itself never opened: every site is degraded the same way.
    const reason = reasonFor(error);
    for (const site of sites) recordSiteRun(store, site.id, "degraded", reason, now);
    recordAggregateRun(store, now, "degraded", reason);
    return { visited: 0, stored: 0, degraded: sites.map(site => ({ url: site.url, reason })) };
  }
  const detail = report.degraded.length > 0 ? report.degraded.map(d => `${d.url}: ${d.reason}`).join("; ") : undefined;
  recordAggregateRun(store, now, report.degraded.length > 0 ? "degraded" : "ok", detail);
  return report;
}
