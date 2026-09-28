import { getConfig } from "../config.ts";
import { classifyBatch, CLASSIFY_BATCH_SIZE, CLASSIFY_LEASE_MS, CLASSIFY_TRANSPORT_MAX_AGE_MS, MAX_CLASSIFY_ATTEMPTS, MAX_CLASSIFY_TRANSPORT_ATTEMPTS, type ClassifyDeps, type ItemRow } from "../pipeline/classify.ts";
import { ROLES, type Role } from "../pipeline/route.ts";
import { sendToChat, type SendDeps, type SendResult } from "../notify/plow.ts";
import { type Store } from "../store/db.ts";
import { classifyAllowed, warnBudgetIfNeeded } from "../usage/budget.ts";
import { buildDigest } from "./build.ts";
import { renderDigest } from "./render.ts";

export async function classifyNewItems(store: Store, deps?: ClassifyDeps & SendDeps) {
  await warnBudgetIfNeeded(store, deps);
  const maxId = (store.db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM items").get() as { id: number }).id;
  let afterId = 0;
  for (;;) {
    const now = deps?.now?.() ?? new Date();
    if (!classifyAllowed(store, now)) return;
    const items = claimClassifyBatch(store, now, afterId, maxId);
    if (!items.length) return;
    afterId = items[items.length - 1].id;
    await classifyBatch(store, items, deps);
    await warnBudgetIfNeeded(store, deps);
  }
}

function claimClassifyBatch(store: Store, now: Date, afterId: number, maxId: number) {
  const nowIso = now.toISOString();
  const leaseUntil = new Date(now.getTime() + CLASSIFY_LEASE_MS).toISOString();
  const transportAgeLimit = new Date(now.getTime() - CLASSIFY_TRANSPORT_MAX_AGE_MS).toISOString();
  return store.tx(() => {
    const candidates = store.db.prepare(`SELECT id FROM items
      WHERE (state = 'new' OR (state = 'needs_review' AND classify_attempts < ?
        AND (classify_transport_attempts < ? OR fetched_at IS NULL OR fetched_at > ?)))
        AND (classify_claimed_until IS NULL OR classify_claimed_until <= ?)
        AND id > ? AND id <= ?
      ORDER BY id LIMIT ?`)
      .all(MAX_CLASSIFY_ATTEMPTS, MAX_CLASSIFY_TRANSPORT_ATTEMPTS, transportAgeLimit, nowIso, afterId, maxId, CLASSIFY_BATCH_SIZE) as { id: number }[];
    if (!candidates.length) return [];
    const ids = candidates.map(row => row.id);
    const placeholders = ids.map(() => "?").join(", ");
    const claimed = store.db.prepare(`UPDATE items SET classify_claimed_until = ?
      WHERE id IN (${placeholders}) AND (classify_claimed_until IS NULL OR classify_claimed_until <= ?)
      RETURNING id`).all(leaseUntil, ...ids, nowIso) as { id: number }[];
    if (!claimed.length) return [];
    const claimedIds = claimed.map(row => row.id);
    const claimedPlaceholders = claimedIds.map(() => "?").join(", ");
    return store.db.prepare(`SELECT * FROM items
      WHERE id IN (${claimedPlaceholders}) AND classify_claimed_until = ? ORDER BY id`)
      .all(...claimedIds, leaseUntil) as ItemRow[];
  });
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

export async function deliverDigest(store: Store, deps: SendDeps & ClassifyDeps & { key?: string; ownerOnly?: boolean } = {}): Promise<SendResult> {
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
  if (deps.ownerOnly) return dmResult;
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
