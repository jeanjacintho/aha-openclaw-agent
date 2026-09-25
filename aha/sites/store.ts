import { type Store } from "../store/db.ts";

export const MAX_SITES = 20;

export type SiteMode = "mentions" | "all";

export type Site = {
  id: number;
  url: string;
  label: string | null;
  mode: SiteMode;
  active: boolean;
  lastRunAt: string | null;
  lastStatus: string | null;
  lastDetail: string | null;
  createdAt: string;
};

type SiteRow = {
  id: number; url: string; label: string | null; mode: string; active: number;
  cursor_json: string; last_run_at: string | null; last_status: string | null; last_detail: string | null; created_at: string;
};

function fromRow(row: SiteRow): Site {
  return {
    id: row.id, url: row.url, label: row.label, mode: row.mode === "all" ? "all" : "mentions",
    active: row.active !== 0, lastRunAt: row.last_run_at, lastStatus: row.last_status, lastDetail: row.last_detail,
    createdAt: row.created_at,
  };
}

const IPV4 = /^(\d{1,3}\.){3}\d{1,3}$/;

/**
 * A registered site is a specific page the owner named, not a place to
 * search: https only, a real-looking public host. Returns the canonical URL
 * (scheme lowercased, no trailing slash, no fragment) or a reason it was refused.
 */
export function normalizeSiteUrl(input: string): { ok: true; url: string } | { ok: false; reason: string } {
  let parsed: URL;
  try {
    parsed = new URL(input.trim());
  } catch {
    return { ok: false, reason: "not a valid URL" };
  }
  if (parsed.protocol !== "https:") return { ok: false, reason: "must be an https URL" };
  const host = parsed.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local") || host === "" || IPV4.test(host) || host === "::1" || host.startsWith("[")) {
    return { ok: false, reason: "must be a public hostname, not localhost or an IP address" };
  }
  if (!host.includes(".")) return { ok: false, reason: "must be a public hostname" };
  parsed.hash = "";
  const path = parsed.pathname.replace(/\/+$/, "");
  return { ok: true, url: `${parsed.protocol}//${host}${path}${parsed.search}` };
}

export function listSites(store: Store): Site[] {
  return (store.db.prepare("SELECT * FROM sites ORDER BY id").all() as SiteRow[]).map(fromRow);
}

export function getSite(store: Store, ref: number | string): Site | undefined {
  const row = typeof ref === "number"
    ? store.db.prepare("SELECT * FROM sites WHERE id = ?").get(ref) as SiteRow | undefined
    : store.db.prepare("SELECT * FROM sites WHERE url = ?").get(ref) as SiteRow | undefined;
  return row ? fromRow(row) : undefined;
}

export type AddSiteResult =
  | { ok: true; site: Site }
  | { ok: false; reason: "invalid_url" | "duplicate" | "limit"; message: string };

export function addSite(store: Store, rawUrl: string, opts: { label?: string; mode?: SiteMode } = {}): AddSiteResult {
  const normalized = normalizeSiteUrl(rawUrl);
  if (!normalized.ok) return { ok: false, reason: "invalid_url", message: normalized.reason };
  const existing = getSite(store, normalized.url);
  if (existing) return { ok: false, reason: "duplicate", message: `already watching ${normalized.url}` };
  const count = (store.db.prepare("SELECT COUNT(*) AS n FROM sites").get() as { n: number }).n;
  if (count >= MAX_SITES) return { ok: false, reason: "limit", message: `at most ${MAX_SITES} sites are watched at once` };
  store.db.prepare(`INSERT INTO sites (url, label, mode, active, cursor_json, created_at) VALUES (?, ?, ?, 1, '{}', ?)`).run(
    normalized.url, opts.label?.trim() || null, opts.mode ?? "mentions", new Date().toISOString(),
  );
  return { ok: true, site: getSite(store, normalized.url)! };
}

export function removeSite(store: Store, ref: number | string): boolean {
  let site: Site | undefined;
  if (typeof ref === "number") {
    site = getSite(store, ref);
  } else {
    const normalized = normalizeSiteUrl(ref);
    site = getSite(store, normalized.ok ? normalized.url : ref);
  }
  if (!site) return false;
  store.db.prepare("DELETE FROM sites WHERE id = ?").run(site.id);
  return true;
}

/** Block hashes already seen on a site, capped so the row cannot grow forever. */
const MAX_CURSOR_ENTRIES = 500;

export function getCursor(store: Store, id: number): string[] {
  const row = store.db.prepare("SELECT cursor_json FROM sites WHERE id = ?").get(id) as { cursor_json: string } | undefined;
  if (!row) return [];
  try {
    const parsed = JSON.parse(row.cursor_json) as { seen?: string[] };
    return Array.isArray(parsed.seen) ? parsed.seen : [];
  } catch {
    return [];
  }
}

export function saveCursor(store: Store, id: number, seen: string[]) {
  const capped = seen.slice(-MAX_CURSOR_ENTRIES);
  store.db.prepare("UPDATE sites SET cursor_json = ? WHERE id = ?").run(JSON.stringify({ seen: capped }), id);
}

export function recordSiteRun(store: Store, id: number, status: string, detail: string | undefined, now: Date) {
  store.db.prepare("UPDATE sites SET last_run_at = ?, last_status = ?, last_detail = ? WHERE id = ?").run(
    now.toISOString(), status, detail ?? null, id,
  );
}
