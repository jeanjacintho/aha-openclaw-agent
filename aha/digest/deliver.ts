import { getConfig } from "../config.ts";
import { classifyBatch, type ClassifyDeps, type ItemRow } from "../pipeline/classify.ts";
import { sendToChat, type SendDeps, type SendResult } from "../notify/plow.ts";
import { type Store } from "../store/db.ts";
import { buildDigest } from "./build.ts";
import { renderDigest } from "./render.ts";

export async function classifyNewItems(store: Store, deps?: ClassifyDeps) {
  const items = store.db.prepare("SELECT * FROM items WHERE state = 'new' ORDER BY id").all() as ItemRow[];
  for (let i = 0; i < items.length; i += 20) await classifyBatch(store, items.slice(i, i + 20), deps);
}

export function scheduledDigestKey(day: string) {
  return `digest:${day}:founder`;
}

export function digestNowKey(at: Date) {
  return `digest:now:${at.toISOString()}`;
}

export function digestSendReply(result: SendResult): { sent: true } | { sent: false; reason: string } {
  if (result === "sent") return { sent: true };
  if (result === "duplicate") return { sent: false, reason: "already sent" };
  return { sent: false, reason: result };
}

export async function deliverDigest(store: Store, deps: SendDeps & ClassifyDeps & { key?: string } = {}): Promise<SendResult> {
  await classifyNewItems(store, deps);
  const cfg = getConfig(store);
  const chat = cfg?.ownerChatUid || process.env.AHA_OWNER_CHAT_UID;
  if (!chat) throw new Error("owner DM is not configured");
  const until = (deps.now ?? (() => new Date()))();
  const model = buildDigest(store, "founder", until, cfg?.tz || "UTC");
  const text = renderDigest(model, cfg?.language || "pt");
  const key = deps.key ?? scheduledDigestKey(model.day);
  return sendToChat(chat, text, key, { store, fetch: deps.fetch, now: deps.now });
}
