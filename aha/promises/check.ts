import { getConfig } from "../config.ts";
import { sendToChat, type SendDeps } from "../notify/plow.ts";
import { routeItem, type Role } from "../pipeline/route.ts";
import { normalizeTopic } from "../pipeline/topics.ts";
import { type Store } from "../store/db.ts";

export type PromiseRow = {
  id: number;
  topic: string;
  due: string;
  owner: string;
  status: string;
};

export type PromiseResult = {
  id: number;
  topic: string;
  due: string;
  owner: string;
  result: "resolvida" | "sem sinal" | "persiste";
  before: number;
  after: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_DAYS = 7;

export function parseDue(due: string): Date {
  const trimmed = due.trim();
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? `${trimmed}T00:00:00.000Z` : trimmed;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) throw new Error("due must be a date");
  return at;
}

const COUNTED_STATES = new Set(["relevant", "assigned", "escalated"]);

function windowCounts(store: Store, topic: string, start: Date, end: Date) {
  const want = normalizeTopic(topic);
  const rows = store.db.prepare(`SELECT items.state AS state, classifications.topic AS topic, classifications.about AS about, classifications.urgency AS urgency, classifications.category AS category
    FROM items
    JOIN classifications ON classifications.item_id = items.id
    WHERE items.published_at >= ? AND items.published_at < ?`).all(start.toISOString(), end.toISOString()) as {
    state: string; topic: string | null; about: string | null; urgency: string | null; category: string | null;
  }[];
  const hits = rows.filter(row => COUNTED_STATES.has(row.state) && row.about === "self" && normalizeTopic(row.topic ?? "") === want);
  return {
    count: hits.length,
    high: hits.some(row => row.urgency === "high"),
    categories: hits.map(row => row.category ?? "other"),
  };
}

function relatedRole(categories: string[]): Role {
  const tallies = new Map<string, number>();
  for (const category of categories) tallies.set(category, (tallies.get(category) ?? 0) + 1);
  const top = [...tallies.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  const routed = routeItem({ category: top?.[0] ?? "other" });
  return routed[0] ?? "founder";
}

export function checkPromises(store: Store, now: Date): PromiseResult[] {
  const rows = store.db.prepare("SELECT id, topic, due, owner, status FROM promises WHERE status = 'open' ORDER BY id").all() as PromiseRow[];
  const results: PromiseResult[] = [];
  for (const row of rows) {
    const due = parseDue(row.due);
    if (now.getTime() < due.getTime() + WINDOW_DAYS * DAY_MS) continue;
    const before = windowCounts(store, row.topic, new Date(due.getTime() - WINDOW_DAYS * DAY_MS), due);
    const after = windowCounts(store, row.topic, due, new Date(due.getTime() + WINDOW_DAYS * DAY_MS));
    let result: PromiseResult["result"];
    if (before.count < 3 || after.count < 3) result = "sem sinal";
    else if (after.count <= before.count * 0.5 && !after.high) result = "resolvida";
    else result = "persiste";
    results.push({
      id: row.id,
      topic: row.topic,
      due: row.due,
      owner: row.owner,
      result,
      before: before.count,
      after: after.count,
    });
  }
  return results;
}

function resultLine(row: PromiseResult, lang: string) {
  const pt = lang.startsWith("pt");
  if (pt) return `Promessa ${row.id} (${row.topic}): ${row.result} · antes ${row.before}, depois ${row.after}`;
  return `Promise ${row.id} (${row.topic}): ${row.result} · before ${row.before}, after ${row.after}`;
}

function delivered(result: string) {
  return result === "sent" || result === "duplicate";
}

export async function notifyPromiseResults(store: Store, results: PromiseResult[], deps: SendDeps = {}) {
  const cfg = getConfig(store);
  const ownerDm = cfg?.ownerChatUid || process.env.AHA_OWNER_CHAT_UID;
  const lang = cfg?.language || "pt";
  const done: PromiseResult[] = [];
  for (const row of results) {
    const due = parseDue(row.due);
    const before = windowCounts(store, row.topic, new Date(due.getTime() - WINDOW_DAYS * DAY_MS), due);
    const after = windowCounts(store, row.topic, due, new Date(due.getTime() + WINDOW_DAYS * DAY_MS));
    const role = relatedRole([...before.categories, ...after.categories]);
    const text = resultLine(row, lang);
    const roleChat = cfg?.roleChats?.[role];
    const dests: { chat: string; key: string }[] = [];
    if (ownerDm) dests.push({ chat: ownerDm, key: `promise:${row.id}:${row.result}:dm:${ownerDm}` });
    if (roleChat && roleChat !== ownerDm) dests.push({ chat: roleChat, key: `promise:${row.id}:${row.result}:role:${role}:${roleChat}` });
    if (dests.length === 0) continue;
    const outcomes = [];
    for (const dest of dests) {
      outcomes.push(await sendToChat(dest.chat, text, dest.key, { store, fetch: deps.fetch, now: deps.now }));
    }
    if (outcomes.every(delivered)) {
      store.db.prepare("UPDATE promises SET status = ? WHERE id = ? AND status = 'open'").run(row.result, row.id);
      done.push(row);
    }
  }
  return done;
}

export async function runPromiseChecks(store: Store, now: Date, deps: SendDeps = {}) {
  const results = checkPromises(store, now);
  await notifyPromiseResults(store, results, deps);
  return results;
}
