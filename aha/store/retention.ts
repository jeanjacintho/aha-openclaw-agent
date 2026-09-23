import { createHash } from "node:crypto";
import { type Store } from "./db.ts";

export const RETENTION_DAYS = 90;

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
    return `https://${host}${path}${search}`;
  } catch {
    return;
  }
}

export function normalizeAuthor(raw: string) {
  return raw.trim().replace(/^u\//i, "").replace(/^@/, "").toLowerCase();
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
  for (const id of ids) {
    store.db.prepare("UPDATE items SET body = '', title = '', author = '' WHERE id = ?").run(id);
    store.db.prepare("UPDATE drafts SET body = '' WHERE item_id = ?").run(id);
  }
  return ids.length;
}

export function pruneExpired(store: Store, now = new Date()) {
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
  return store.tx(() => redactText(store, redact) + deleteItems(store, remove));
}

export type ForgetOpts = { actor?: string; at?: Date };

function matchingIds(store: Store, needle: string) {
  if (looksLikeUrl(needle)) {
    const target = normalizeUrl(needle);
    if (!target) return [];
    const rows = store.db.prepare("SELECT id, url FROM items WHERE url IS NOT NULL AND url != ''").all() as { id: number; url: string }[];
    return rows.filter(row => normalizeUrl(row.url) === target).map(row => row.id);
  }
  const handle = normalizeAuthor(needle);
  if (!handle) return [];
  const rows = store.db.prepare("SELECT id, source, author FROM items WHERE author IS NOT NULL AND author != ''").all() as {
    id: number; source: string; author: string;
  }[];
  return rows.filter(row => normalizeAuthor(row.author) === handle).map(row => row.id);
}

function targetHash(needle: string) {
  const kind = looksLikeUrl(needle) ? "url" : "author";
  const value = kind === "url" ? (normalizeUrl(needle) ?? needle.trim().toLowerCase()) : normalizeAuthor(needle);
  return createHash("sha256").update(`${kind}:${value}`).digest("hex");
}

export function forgetByUrlOrAuthor(store: Store, urlOrAuthor: string, opts: ForgetOpts = {}) {
  const needle = urlOrAuthor.trim();
  if (!needle) return 0;
  const ids = matchingIds(store, needle);
  const deleted = store.tx(() => {
    const n = deleteItems(store, ids);
    store.db.prepare("INSERT INTO forget_audit (target_hash, at, actor, deleted) VALUES (?, ?, ?, ?)").run(
      targetHash(needle),
      (opts.at ?? new Date()).toISOString(),
      opts.actor ?? "unknown",
      n,
    );
    return n;
  });
  try { store.db.exec("VACUUM"); } catch { /* in-memory or locked */ }
  return deleted;
}
