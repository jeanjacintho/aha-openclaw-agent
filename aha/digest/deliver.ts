import { getConfig } from "../config.ts";
import { classifyBatch, MAX_CLASSIFY_ATTEMPTS, type ClassifyDeps, type ItemRow } from "../pipeline/classify.ts";
import { ROLES, type Role } from "../pipeline/route.ts";
import { sendToChat, type SendDeps, type SendResult } from "../notify/plow.ts";
import { type Store } from "../store/db.ts";
import { classifyAllowed, warnBudgetIfNeeded } from "../usage/budget.ts";
import { buildDigest } from "./build.ts";
import { renderDigest } from "./render.ts";

export async function classifyNewItems(store: Store, deps?: ClassifyDeps & SendDeps) {
  const now = deps?.now?.() ?? new Date();
  await warnBudgetIfNeeded(store, deps);
  if (!classifyAllowed(store, now)) return;
  const items = store.db.prepare(`SELECT * FROM items
    WHERE state = 'new' OR (state = 'needs_review' AND classify_attempts < ?) ORDER BY id`).all(MAX_CLASSIFY_ATTEMPTS) as ItemRow[];
  for (let i = 0; i < items.length; i += 20) {
    if (!classifyAllowed(store, now)) return;
    await classifyBatch(store, items.slice(i, i + 20), deps);
    await warnBudgetIfNeeded(store, deps);
  }
}

export function scheduledDigestKey(day: string, role: Role = "founder", chatUid?: string) {
  return chatUid ? `digest:${day}:${role}:${chatUid}` : `digest:${day}:${role}`;
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
  const ownerDm = cfg?.ownerChatUid || process.env.AHA_OWNER_CHAT_UID;
  if (!ownerDm) throw new Error("owner DM is not configured");
  const until = (deps.now ?? (() => new Date()))();
  const tz = cfg?.tz || "UTC";
  const lang = cfg?.language || "pt";
  const founder = buildDigest(store, "founder", until, tz);
  const dmKey = deps.key ?? scheduledDigestKey(founder.day, "founder", ownerDm);
  const dmResult = await sendToChat(ownerDm, renderDigest(founder, lang), dmKey, {
    store, fetch: deps.fetch, now: deps.now,
  });
  for (const role of ROLES) {
    const chat = cfg?.roleChats?.[role];
    if (!chat || chat === ownerDm) continue;
    const model = buildDigest(store, role, until, tz);
    const key = deps.key ? `${deps.key}:${role}:${chat}` : scheduledDigestKey(model.day, role, chat);
    await sendToChat(chat, renderDigest(model, lang), key, {
      store, fetch: deps.fetch, now: deps.now,
    });
  }
  return dmResult;
}
