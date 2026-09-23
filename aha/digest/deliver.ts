import { getConfig, type AhaConfig } from "../config.ts";
import { classifyBatch, type ClassifyDeps, type ItemRow } from "../pipeline/classify.ts";
import { sendToChat, type SendDeps, type SendResult } from "../notify/plow.ts";
import { type Store } from "../store/db.ts";
import { buildDigest } from "./build.ts";
import { renderDigest } from "./render.ts";

export async function classifyNewItems(store: Store, deps?: ClassifyDeps) {
  const items = store.db.prepare("SELECT * FROM items WHERE state = 'new' ORDER BY id").all() as ItemRow[];
  for (let i = 0; i < items.length; i += 20) await classifyBatch(store, items.slice(i, i + 20), deps);
}

export async function deliverDigest(store: Store, deps: SendDeps & ClassifyDeps = {}): Promise<SendResult> {
  await classifyNewItems(store, deps);
  const cfg = getConfig(store);
  const chat = cfg?.ownerChatUid || process.env.AHA_OWNER_CHAT_UID;
  if (!chat) throw new Error("owner DM is not configured");
  const until = (deps.now ?? (() => new Date()))();
  const model = buildDigest(store, "founder", until, cfg?.tz || "UTC");
  const text = renderDigest(model, cfg?.language || "pt");
  return sendToChat(chat, text, `digest:${model.day}:founder`, { store, fetch: deps.fetch, now: deps.now });
}
