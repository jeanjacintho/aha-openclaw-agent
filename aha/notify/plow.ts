import { getConfig } from "../config.ts";
import { openStore, type Store } from "../store/db.ts";

export type SendResult = "sent" | "duplicate" | "uncertain" | "failed";

export type SendDeps = {
  fetch?: typeof fetch;
  store?: Store;
  now?: () => Date;
};

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

function claim(store: Store, key: string, chatUid: string, at: string) {
  const inserted = store.db.prepare(`INSERT INTO deliveries (key, chat_uid, status, message_uid, created_at, updated_at)
    VALUES (?, ?, 'uncertain', NULL, ?, ?) ON CONFLICT (key) DO NOTHING`).run(key, chatUid, at, at);
  if (inserted.changes === 1) return "owned";
  const retried = store.db.prepare(`UPDATE deliveries SET status = 'uncertain', chat_uid = ?, updated_at = ?
    WHERE key = ? AND status = 'failed'`).run(chatUid, at, key);
  if (retried.changes === 1) return "owned";
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
    const claimed = claim(store, key, chatUid, at);
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
      });
    } catch {
      return "uncertain";
    }
    if (response.ok) {
      try {
        const payload = await response.json() as { uid?: string };
        finish(store, key, "sent", payload.uid ?? null, at);
        return "sent";
      } catch {
        return "uncertain";
      }
    }
    if (uncertainStatus(response.status)) return "uncertain";
    finish(store, key, "failed", null, at);
    return "failed";
  } finally {
    if (owned) store.close();
  }
}
