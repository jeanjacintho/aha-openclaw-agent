import { type Store } from "../store/db.ts";
import { listTopics, topicLabel } from "./topics.ts";

export type WeeklyCount = { week: string; count: number | null };

export type TrendAlert = {
  topicId: number;
  label: string;
  current: number;
  average: number;
  bySource: { source: string; count: number }[];
};

const DAY_MS = 24 * 60 * 60 * 1000;

export function isoWeek(date: Date) {
  const t = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((t.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

export function utcMonday(date: Date) {
  const t = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() - day + 1);
  return t;
}

function sourceName(source: string) {
  if (source === "hn") return "HN";
  if (source === "ph") return "PH";
  if (source === "agent-index") return "Agent Index";
  return source;
}

function weekKnown(store: Store, start: Date, end: Date) {
  const rows = store.db.prepare(
    "SELECT source, status FROM source_runs WHERE window_end > ? AND window_start < ?",
  ).all(start.toISOString(), end.toISOString()) as { source: string; status: string }[];
  if (rows.length === 0) return false;
  const bySource = new Map<string, string[]>();
  for (const row of rows) {
    const list = bySource.get(row.source) ?? [];
    list.push(row.status);
    bySource.set(row.source, list);
  }
  for (const statuses of bySource.values()) {
    if (!statuses.includes("ok")) return false;
  }
  return true;
}

function countTopic(store: Store, topicId: number, start: Date, end: Date) {
  const label = topicLabel(store, topicId);
  const row = store.db.prepare(`SELECT COUNT(*) AS n
    FROM items
    JOIN classifications ON classifications.item_id = items.id
    WHERE classifications.topic = ? AND items.published_at >= ? AND items.published_at < ?`).get(
    label, start.toISOString(), end.toISOString(),
  ) as { n: number };
  return row.n;
}

function countsBySource(store: Store, topicId: number, start: Date, end: Date) {
  const label = topicLabel(store, topicId);
  return store.db.prepare(`SELECT items.source AS source, COUNT(*) AS n
    FROM items
    JOIN classifications ON classifications.item_id = items.id
    WHERE classifications.topic = ? AND items.published_at >= ? AND items.published_at < ?
    GROUP BY items.source
    ORDER BY items.source`).all(label, start.toISOString(), end.toISOString()) as { source: string; n: number }[];
}

export function weeklyCounts(store: Store, topicId: number, weeks: number, now = new Date()): WeeklyCount[] {
  const currentMonday = utcMonday(now);
  const rows: WeeklyCount[] = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const start = new Date(currentMonday.getTime() - i * 7 * DAY_MS);
    const end = new Date(start.getTime() + 7 * DAY_MS);
    const week = isoWeek(new Date(start.getTime() + 3 * DAY_MS));
    rows.push({
      week,
      count: weekKnown(store, start, end) ? countTopic(store, topicId, start, end) : null,
    });
  }
  return rows;
}

export function detectTrends(store: Store, now: Date): TrendAlert[] {
  const alerts: TrendAlert[] = [];
  for (const topic of listTopics(store)) {
    const rows = weeklyCounts(store, topic.id, 4, now);
    const current = rows[rows.length - 1];
    if (current.count == null || current.count < 3) continue;
    const priorKnown = rows.slice(0, -1).map(row => row.count).filter((n): n is number => n != null);
    if (priorKnown.length === 0) continue;
    const average = priorKnown.reduce((sum, n) => sum + n, 0) / priorKnown.length;
    if (current.count < 2 * average) continue;
    const monday = utcMonday(now);
    const bySource = countsBySource(store, topic.id, monday, new Date(monday.getTime() + 7 * DAY_MS))
      .map(row => ({ source: row.source, count: row.n }));
    alerts.push({ topicId: topic.id, label: topic.label, current: current.count, average, bySource });
  }
  return alerts;
}

export function trendSentence(alert: TrendAlert, lang: string) {
  const pt = lang.startsWith("pt");
  const parts = alert.bySource.map(row => `${sourceName(row.source)} ${row.count}`);
  const head = pt ? `${alert.current} menções em 7 dias` : `${alert.current} mentions in 7 days`;
  return parts.length ? `${head}: ${parts.join(", ")}` : head;
}
