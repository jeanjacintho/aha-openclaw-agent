import { type Store } from "./db.ts";

export const RETENTION_DAYS = 90;

function deleteItems(store: Store, ids: number[]) {
  return store.tx(() => {
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
  });
}

export function pruneExpired(store: Store, now = new Date()) {
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const rows = store.db.prepare(`SELECT id FROM items
    WHERE (fetched_at IS NOT NULL AND fetched_at != '' AND fetched_at < ?)
       OR ((fetched_at IS NULL OR fetched_at = '') AND published_at IS NOT NULL AND published_at < ?)`)
    .all(cutoff, cutoff) as { id: number }[];
  return deleteItems(store, rows.map(row => row.id));
}

export function forgetByUrlOrAuthor(store: Store, urlOrAuthor: string) {
  const needle = urlOrAuthor.trim();
  if (!needle) return 0;
  const rows = store.db.prepare("SELECT id FROM items WHERE url = ? OR author = ?").all(needle, needle) as { id: number }[];
  return deleteItems(store, rows.map(row => row.id));
}
