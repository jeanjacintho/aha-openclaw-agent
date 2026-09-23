import { getConfig } from "../config.ts";
import { sendToChat, type SendDeps } from "../notify/plow.ts";
import { type Store } from "../store/db.ts";
import { dailyTotals } from "./ledger.ts";

export const DEFAULT_DAILY_TOKEN_BUDGET = 2_000_000;

export function utcDay(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

export function tokensOn(day: string) {
  return dailyTotals(day).reduce((sum, row) => sum + row.input + row.output, 0);
}

export function tokenBudget(store?: Store | null) {
  const env = Number(process.env.AHA_TOKEN_BUDGET);
  if (Number.isFinite(env) && env > 0) return env;
  const configured = store ? getConfig(store)?.tokenBudget : undefined;
  if (typeof configured === "number" && Number.isFinite(configured) && configured > 0) return configured;
  return DEFAULT_DAILY_TOKEN_BUDGET;
}

export function classifyAllowed(store: Store, now = new Date()) {
  return tokensOn(utcDay(now)) < tokenBudget(store);
}

export function llmAllowed(store: Store, now = new Date()) {
  return classifyAllowed(store, now);
}

export async function warnBudgetIfNeeded(store: Store, deps: SendDeps = {}) {
  const now = deps.now?.() ?? new Date();
  const day = utcDay(now);
  const budget = tokenBudget(store);
  const used = tokensOn(day);
  if (used < budget * 0.8) return;
  const cfg = getConfig(store);
  const owner = cfg?.ownerChatUid || process.env.AHA_OWNER_CHAT_UID;
  if (!owner) return;
  const lang = cfg?.language || "en";
  const pct = Math.min(100, Math.round((used / budget) * 100));
  const at80 = lang.startsWith("pt")
    ? `Orçamento de tokens em ${pct}% hoje (${used}/${budget}). Classificação para em 100%.`
    : `Token budget at ${pct}% today (${used}/${budget}). Classification stops at 100%.`;
  try {
    await sendToChat(owner, at80, `budget:${day}:80`, { store, fetch: deps.fetch, now: deps.now });
  } catch {
    /* unit tests may omit Plow env */
  }
  if (used < budget) return;
  const at100 = lang.startsWith("pt")
    ? `Orçamento de tokens esgotado (100%) hoje (${used}/${budget}). Classificação e rascunhos param.`
    : `Token budget exhausted (100%) today (${used}/${budget}). Classification and drafts stop.`;
  try {
    await sendToChat(owner, at100, `budget:${day}:100`, { store, fetch: deps.fetch, now: deps.now });
  } catch {
    /* unit tests may omit Plow env */
  }
}
