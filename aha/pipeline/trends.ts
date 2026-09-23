import { type Store } from "../store/db.ts";
import { listTopics, normalizeTopic, topicLabel } from "./topics.ts";

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

function rangeSources(store: Store, start: Date, end: Date) {
  return (store.db.prepare(
    "SELECT DISTINCT source FROM source_runs WHERE window_end > ? AND window_start < ?",
  ).all(start.toISOString(), end.toISOString()) as { source: string }[]).map(row => row.source);
}

function weekKnown(store: Store, start: Date, end: Date, expected: string[]) {
  if (expected.length === 0) return false;
  const rows = store.db.prepare(
    "SELECT source, status FROM source_runs WHERE window_end > ? AND window_start < ?",
  ).all(start.toISOString(), end.toISOString()) as { source: string; status: string }[];
  const ok = new Set(rows.filter(row => row.status === "ok").map(row => row.source));
  return expected.every(source => ok.has(source));
}

type Hit = { source: string; topic: string; state: string; about: string | null };

function topicHits(store: Store, topicId: number, start: Date, end: Date) {
  const want = normalizeTopic(topicLabel(store, topicId));
  const rows = store.db.prepare(`SELECT items.source AS source, items.state AS state, classifications.topic AS topic, classifications.about AS about
    FROM items
    JOIN classifications ON classifications.item_id = items.id
    WHERE items.published_at >= ? AND items.published_at < ?`).all(start.toISOString(), end.toISOString()) as Hit[];
  return rows.filter(row => row.state === "relevant" && row.about === "self" && normalizeTopic(row.topic) === want);
}

function countTopic(store: Store, topicId: number, start: Date, end: Date) {
  return topicHits(store, topicId, start, end).length;
}

function countsBySource(store: Store, topicId: number, start: Date, end: Date) {
  const bySource = new Map<string, number>();
  for (const hit of topicHits(store, topicId, start, end)) {
    bySource.set(hit.source, (bySource.get(hit.source) ?? 0) + 1);
  }
  return [...bySource.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([source, count]) => ({ source, count }));
}

export function weeklyCounts(store: Store, topicId: number, weeks: number, now = new Date()): WeeklyCount[] {
  const currentMonday = utcMonday(now);
  const rangeStart = new Date(currentMonday.getTime() - (weeks - 1) * 7 * DAY_MS);
  const rangeEnd = new Date(currentMonday.getTime() + 7 * DAY_MS);
  const expected = rangeSources(store, rangeStart, rangeEnd);
  const rows: WeeklyCount[] = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const start = new Date(currentMonday.getTime() - i * 7 * DAY_MS);
    const end = new Date(start.getTime() + 7 * DAY_MS);
    const week = isoWeek(new Date(start.getTime() + 3 * DAY_MS));
    rows.push({
      week,
      count: weekKnown(store, start, end, expected) ? countTopic(store, topicId, start, end) : null,
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
    alerts.push({
      topicId: topic.id,
      label: topic.label,
      current: current.count,
      average,
      bySource: countsBySource(store, topic.id, monday, new Date(monday.getTime() + 7 * DAY_MS)),
    });
  }
  return alerts;
}

export function trendSentence(alert: TrendAlert, lang: string) {
  const pt = lang.startsWith("pt");
  const parts = alert.bySource.map(row => `${sourceName(row.source)} ${row.count}`);
  const head = pt
    ? `${alert.label}: ${alert.current} menções nesta semana`
    : `${alert.label}: ${alert.current} mentions this week`;
  return parts.length ? `${head}: ${parts.join(", ")}` : head;
}
