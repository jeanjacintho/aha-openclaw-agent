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

function lookup(store: Store, key: string) {
  return store.db.prepare("SELECT status FROM deliveries WHERE key = ?").get(key) as { status: string } | undefined;
}

function write(store: Store, key: string, chatUid: string, status: SendResult, messageUid: string | null, at: string) {
  store.db.prepare(`INSERT INTO deliveries (key, chat_uid, status, message_uid, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (key) DO UPDATE SET status = excluded.status, message_uid = excluded.message_uid, updated_at = excluded.updated_at`)
    .run(key, chatUid, status, messageUid, at, at);
}

async function isGroup(chatUid: string, http: typeof fetch) {
  const response = await http(`${apiBase()}/v1/chats/${chatUid}`, { headers: headers() });
  if (!response.ok) return true;
  const chat = await response.json() as { participants?: unknown[] };
  return (chat.participants?.length ?? 0) > 2;
}

function uncertainStatus(status: number) {
  return status === 408 || status === 424 || status >= 500;
}

export async function sendToChat(chatUid: string, text: string, key: string, deps: SendDeps = {}): Promise<SendResult> {
  const store = deps.store ?? openStore();
  const owned = !deps.store;
  try {
    const existing = lookup(store, key);
    if (existing?.status === "sent") return "duplicate";
    if (existing?.status === "uncertain") return "uncertain";
    if (existing) return existing.status as SendResult;
    const http = deps.fetch ?? fetch;
    if (paused(store) && await isGroup(chatUid, http)) return "failed";
    const at = (deps.now ?? (() => new Date()))().toISOString();
    let response: Response;
    try {
      response = await http(`${apiBase()}/v1/chats/${chatUid}/messages`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ body: text, attachment_uids: [] }),
      });
    } catch {
      write(store, key, chatUid, "uncertain", null, at);
      return "uncertain";
    }
    if (response.ok) {
      const payload = await response.json() as { uid?: string };
      write(store, key, chatUid, "sent", payload.uid ?? null, at);
      return "sent";
    }
    const status = uncertainStatus(response.status) ? "uncertain" : "failed";
    write(store, key, chatUid, status, null, at);
    return status;
  } finally {
    if (owned) store.close();
  }
}
