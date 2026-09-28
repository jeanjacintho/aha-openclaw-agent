import { getConfig } from "../config.ts";
import { openStore, type Store } from "../store/db.ts";

export type SendResult = "sent" | "duplicate" | "uncertain" | "failed";

export type SendDeps = {
  fetch?: typeof fetch;
  store?: Store;
  now?: () => Date;
  timeoutMs?: number;
};

export const DELIVERY_RETRY_GRACE_MS = 5 * 60 * 1000;

function apiBase() {
  const base = process.env.PLOW_API_BASE?.replace(/\/$/, "");
  if (!base) throw new Error("PLOW_API_BASE is required");
  return base;
}

function headers() {
  const token = process.env.PLOW_AGENT_TOKEN;
  if (!token) throw new Error("PLOW_AGENT_TOKEN is required");
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

function paused(store: Store) {
  const row = store.db.prepare("SELECT paused FROM flags WHERE id = 1").get() as { paused: number } | undefined;
  return (row?.paused ?? 0) !== 0;
}

function ownerChatUid(store: Store) {
  return getConfig(store)?.ownerChatUid || process.env.AHA_OWNER_CHAT_UID;
}

function lookup(store: Store, key: string) {
  return store.db.prepare("SELECT status FROM deliveries WHERE key = ?").get(key) as { status: string } | undefined;
}

function claim(store: Store, key: string, chatUid: string, text: string, at: string) {
  const inserted = store.db.prepare(`INSERT INTO deliveries (key, chat_uid, status, message_uid, created_at, updated_at, body)
    VALUES (?, ?, 'uncertain', NULL, ?, ?, ?) ON CONFLICT (key) DO NOTHING`).run(key, chatUid, at, at, text);
  if (inserted.changes === 1) return "owned";
  const retried = store.db.prepare(`UPDATE deliveries SET status = 'uncertain', chat_uid = ?, body = ?, updated_at = ?
    WHERE key = ? AND status = 'failed'`).run(chatUid, text, at, key);
  if (retried.changes === 1) return "owned";
  const retryBefore = new Date(Date.parse(at) - DELIVERY_RETRY_GRACE_MS).toISOString();
  const reclaimed = store.db.prepare(`UPDATE deliveries SET status = 'uncertain', chat_uid = ?, body = ?, updated_at = ?
    WHERE key = ? AND status = 'uncertain' AND updated_at <= ?`).run(chatUid, text, at, key, retryBefore);
  if (reclaimed.changes === 1) return "owned";
  return lookup(store, key)?.status ?? "uncertain";
}

function finish(store: Store, key: string, status: "sent" | "failed" | "uncertain", messageUid: string | null, at: string) {
  store.db.prepare("UPDATE deliveries SET status = ?, message_uid = ?, updated_at = ? WHERE key = ?").run(status, messageUid, at, key);
}

function uncertainStatus(status: number) {
  return status === 408 || status === 424 || status >= 500;
}

export async function sendToChat(chatUid: string, text: string, key: string, deps: SendDeps = {}): Promise<SendResult> {
  const store = deps.store ?? openStore();
  const owned = !deps.store;
  try {
    const http = deps.fetch ?? fetch;
    if (paused(store) && chatUid !== ownerChatUid(store)) return "failed";
    const at = (deps.now ?? (() => new Date()))().toISOString();
    const claimed = claim(store, key, chatUid, text, at);
    if (claimed !== "owned") {
      if (claimed === "sent") return "duplicate";
      return claimed as SendResult;
    }
    let response: Response;
    try {
      response = await http(`${apiBase()}/v1/chats/${chatUid}/messages`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ body: text, attachment_uids: [] }),
        signal: AbortSignal.timeout(deps.timeoutMs ?? 10_000),
      });
    } catch {
      finish(store, key, "uncertain", null, (deps.now ?? (() => new Date()))().toISOString());
      return "uncertain";
    }
    if (response.ok) {
      try {
        const payload = await response.json() as { uid?: string };
        finish(store, key, "sent", payload.uid ?? null, at);
        return "sent";
      } catch {
        finish(store, key, "uncertain", null, (deps.now ?? (() => new Date()))().toISOString());
        return "uncertain";
      }
    }
    if (uncertainStatus(response.status)) {
      finish(store, key, "uncertain", null, (deps.now ?? (() => new Date()))().toISOString());
      return "uncertain";
    }
    finish(store, key, "failed", null, at);
    return "failed";
  } finally {
    if (owned) store.close();
  }
}

export async function retryUncertainDeliveries(
  store: Store,
  now = new Date(),
  deps: Pick<SendDeps, "fetch" | "timeoutMs"> = {},
) {
  const retryBefore = new Date(now.getTime() - DELIVERY_RETRY_GRACE_MS).toISOString();
  const rows = store.db.prepare(`SELECT key, chat_uid AS chatUid, body FROM deliveries
    WHERE status = 'uncertain' AND body IS NOT NULL AND updated_at <= ? ORDER BY updated_at, key`).all(retryBefore) as {
    key: string; chatUid: string; body: string;
  }[];
  const unrecoverable = store.db.prepare(`UPDATE deliveries SET status = 'failed', updated_at = ?
    WHERE status = 'uncertain' AND body IS NULL AND updated_at <= ?`).run(now.toISOString(), retryBefore).changes;
  if (unrecoverable > 0) {
    console.error(`aha: ${unrecoverable} old uncertain notification(s) could not be retried because their message text was not stored`);
  }
  for (const row of rows) {
    try {
      const result = await sendToChat(row.chatUid, row.body, row.key, { store, fetch: deps.fetch, timeoutMs: deps.timeoutMs, now: () => now });
      if (result !== "sent" && result !== "duplicate") {
        console.error(`aha: notification ${row.key} retry was not delivered (${result})`);
      }
    } catch (error) {
      console.error(`aha: notification ${row.key} retry failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return rows.length;
}
