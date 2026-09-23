import { createHmac, randomBytes } from "node:crypto";
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { ahaHome } from "../home.ts";
import { type Store } from "./db.ts";

export const RETENTION_DAYS = 90;
export const FORGET_AUTHOR_SOURCES = ["hn", "reddit", "github", "ph", "agent-index"] as const;

export class ForgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ForgetError";
  }
}

export function looksLikeUrl(raw: string) {
  const text = raw.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return true;
  if (/^www\./i.test(text)) return true;
  return /^[\w.-]+\.[a-z]{2,}([/:?#]|$)/i.test(text);
}

export function normalizeUrl(raw: string) {
  try {
    const trimmed = raw.trim();
    const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
    const url = new URL(withScheme);
    if (url.protocol !== "http:" && url.protocol !== "https:") return;
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    const path = url.pathname.replace(/\/+$/, "");
    const search = url.search.replace(/\/+$/, "");
    const hash = url.hash.replace(/\/+$/, "").toLowerCase();
    return `https://${host}${path}${search}${hash}`;
  } catch {
    return;
  }
}

export function normalizeAuthor(raw: string) {
  return raw.trim().replace(/^u\//i, "").replace(/^@/, "").toLowerCase();
}

function sourceOf(value: string) {
  return FORGET_AUTHOR_SOURCES.find(id => id === value.toLowerCase());
}

export function parseForgetNeedle(raw: string): { kind: "url"; url: string } | { kind: "author"; source: string; handle: string } {
  const needle = raw.trim();
  if (!needle) throw new ForgetError("urlOrAuthor is required");
  if (looksLikeUrl(needle)) {
    const url = normalizeUrl(needle);
    if (!url) throw new ForgetError("url is not valid");
    return { kind: "url", url };
  }
  const split = needle.match(/^([a-z0-9_-]+):(.+)$/i);
  const source = split ? sourceOf(split[1]) : undefined;
  const handle = split ? normalizeAuthor(split[2]) : "";
  if (!source || !handle) {
    throw new ForgetError("author must be source:handle (e.g. hn:alice, reddit:alice)");
  }
  return { kind: "author", source, handle };
}

function deleteItems(store: Store, ids: number[]) {
  for (const id of ids) {
    store.db.prepare("DELETE FROM drafts WHERE item_id = ?").run(id);
    store.db.prepare("DELETE FROM feedback_examples WHERE item_id = ?").run(id);
    store.db.prepare("DELETE FROM classifications WHERE item_id = ?").run(id);
    const ident = store.db.prepare("SELECT source, external_id, url FROM items WHERE id = ?").get(id) as {
      source: string; external_id: string; url: string | null;
    } | undefined;
    if (ident) {
      store.db.prepare("DELETE FROM ledger WHERE key LIKE ? OR key = ?").run(
        `post:%:${ident.source}:${ident.external_id}`,
        `thread:${ident.source}:${ident.external_id}`,
      );
      if (ident.url) store.db.prepare("DELETE FROM ledger WHERE url = ?").run(ident.url);
    }
    store.db.prepare("DELETE FROM items WHERE id = ?").run(id);
  }
  return ids.length;
}

function redactText(store: Store, ids: number[]) {
  const expiredItemIds: number[] = [];
  for (const id of ids) {
    store.db.prepare("UPDATE items SET body = '', title = '', author = '' WHERE id = ?").run(id);
    const pending = store.db.prepare("UPDATE drafts SET body = '', state = 'expired' WHERE item_id = ? AND state = 'pending'").run(id);
    if (pending.changes > 0) expiredItemIds.push(id);
  }
  return { redacted: ids.length, expiredItemIds };
}

export type PruneResult = { processed: number; expiredItemIds: number[] };

export function pruneExpired(store: Store, now = new Date()): PruneResult {
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const rows = store.db.prepare(`SELECT items.id, items.state,
      EXISTS(SELECT 1 FROM drafts WHERE drafts.item_id = items.id AND drafts.state = 'pending') AS pending_draft
    FROM items
    WHERE (fetched_at IS NOT NULL AND fetched_at != '' AND fetched_at < ?)
       OR ((fetched_at IS NULL OR fetched_at = '') AND published_at IS NOT NULL AND published_at < ?)`)
    .all(cutoff, cutoff) as { id: number; state: string; pending_draft: number }[];
  const redact: number[] = [];
  const remove: number[] = [];
  for (const row of rows) {
    if (row.state === "assigned" || row.state === "escalated" || row.pending_draft) redact.push(row.id);
    else remove.push(row.id);
  }
  return store.tx(() => {
    const redacted = redactText(store, redact);
    const deleted = deleteItems(store, remove);
    return { processed: redacted.redacted + deleted, expiredItemIds: redacted.expiredItemIds };
  });
}

export type ForgetOpts = { actor?: string; at?: Date; home?: string };

function matchingIds(store: Store, parsed: ReturnType<typeof parseForgetNeedle>) {
  if (parsed.kind === "url") {
    const rows = store.db.prepare("SELECT id, url FROM items WHERE url IS NOT NULL AND url != ''").all() as { id: number; url: string }[];
    return rows.filter(row => normalizeUrl(row.url) === parsed.url).map(row => row.id);
  }
  const rows = store.db.prepare("SELECT id, source, author FROM items WHERE source = ? AND author IS NOT NULL AND author != ''").all(parsed.source) as {
    id: number; source: string; author: string;
  }[];
  return rows.filter(row => normalizeAuthor(row.author) === parsed.handle).map(row => row.id);
}

function forgetKeyPath(home: string) {
  return `${home}/forget.key`;
}

export function forgetHmacSecret(home = ahaHome()) {
  mkdirSync(home, { recursive: true });
  const file = forgetKeyPath(home);
  try {
    const existing = readFileSync(file, "utf8").trim();
    if (existing.length >= 32) return existing;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const secret = randomBytes(32).toString("hex");
  try {
    const fd = openSync(file, "wx", 0o600);
    try {
      writeSync(fd, `${secret}\n`);
    } finally {
      closeSync(fd);
    }
    chmodSync(file, 0o600);
    return secret;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return readFileSync(file, "utf8").trim();
  }
}

function targetHash(parsed: ReturnType<typeof parseForgetNeedle>, home: string) {
  const value = parsed.kind === "url" ? `url:${parsed.url}` : `author:${parsed.source}:${parsed.handle}`;
  return createHmac("sha256", forgetHmacSecret(home)).update(value).digest("hex");
}

function purgeDeletedBytes(store: Store) {
  try { store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch { /* no WAL */ }
  try { store.db.exec("VACUUM"); } catch { /* in-memory or locked */ }
  try { store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch { /* no WAL */ }
}

export function forgetByUrlOrAuthor(store: Store, urlOrAuthor: string, opts: ForgetOpts = {}) {
  const parsed = parseForgetNeedle(urlOrAuthor);
  const home = opts.home ?? ahaHome();
  const ids = matchingIds(store, parsed);
  const deleted = store.tx(() => {
    const n = deleteItems(store, ids);
    store.db.prepare("INSERT INTO forget_audit (target_hash, at, actor, deleted) VALUES (?, ?, ?, ?)").run(
      targetHash(parsed, home),
      (opts.at ?? new Date()).toISOString(),
      opts.actor ?? "unknown",
      n,
    );
    return n;
  });
  purgeDeletedBytes(store);
  return deleted;
}
