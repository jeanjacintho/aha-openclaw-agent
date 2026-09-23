import { detectTrends, type TrendAlert } from "../pipeline/trends.ts";
import { type Store } from "../store/db.ts";

export type Role = "founder" | "produto" | "marketing" | "engenharia";

export type DigestItem = {
  id: number;
  category: string;
  urgency: string;
  topic: string;
  excerpt: string;
  url: string | null;
};

export type SourceHealth = {
  source: string;
  status: string;
  since: string | null;
  detail: string | null;
};

export type DigestModel = {
  day: string;
  role: Role;
  readCount: number;
  items: DigestItem[];
  sources: SourceHealth[];
  trends: TrendAlert[];
};

const ROLE_CATEGORIES: Record<Role, string[]> = {
  founder: ["pricing", "legal", "security"],
  produto: ["feature_request", "comparison"],
  marketing: ["praise", "complaint", "question"],
  engenharia: ["bug", "security"],
};

const URGENCY_RANK: Record<string, number> = { high: 0, med: 1, low: 2 };
const CATEGORY_RANK: Record<string, number> = {
  security: 0, legal: 1, bug: 2, complaint: 3, feature_request: 4, question: 5, comparison: 6, pricing: 7, praise: 8, other: 9,
};

const DAY_MS = 24 * 60 * 60 * 1000;

export function excerpt(body: string | null) {
  return (body ?? "")
    .replace(/\[[^\]]*\]\([^)]*\)/g, "[link]")
    .replace(/https?:\/\/\S+/gi, "[link]")
    .replace(/\bwww\.\S+/gi, "[link]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

function ymd(until: Date, tz: string) {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  return fmt.format(until);
}

export function buildDigest(s: Store, role: Role, until: Date, tz = "UTC"): DigestModel {
  const untilIso = until.toISOString();
  const sinceIso = new Date(until.getTime() - DAY_MS).toISOString();
  const readCount = (s.db.prepare("SELECT COUNT(*) AS n FROM items WHERE fetched_at > ? AND fetched_at <= ?").get(sinceIso, untilIso) as { n: number }).n;
  const wanted = ROLE_CATEGORIES[role];
  const rows = s.db.prepare(`SELECT items.id, items.body, items.url, items.state,
      classifications.category, classifications.urgency, classifications.topic
    FROM items
    JOIN classifications ON classifications.item_id = items.id
    WHERE items.state = 'relevant' AND items.fetched_at > ? AND items.fetched_at <= ?`).all(sinceIso, untilIso) as {
    id: number; body: string | null; url: string | null; state: string;
    category: string | null; urgency: string | null; topic: string | null;
  }[];
  const ranked = rows
    .filter(row => row.urgency === "high" || (row.category && wanted.includes(row.category)))
    .sort((a, b) => {
      const urgency = (URGENCY_RANK[a.urgency ?? "low"] ?? 9) - (URGENCY_RANK[b.urgency ?? "low"] ?? 9);
      if (urgency !== 0) return urgency;
      return (CATEGORY_RANK[a.category ?? "other"] ?? 9) - (CATEGORY_RANK[b.category ?? "other"] ?? 9);
    })
    .slice(0, 7)
    .map(row => ({
      id: row.id,
      category: row.category ?? "other",
      urgency: row.urgency ?? "low",
      topic: row.topic ?? "",
      excerpt: excerpt(row.body),
      url: row.url,
    }));
  const sources = s.db.prepare(`SELECT r.source, r.status, ok.since, r.detail
    FROM source_runs r
    JOIN (SELECT source, MAX(id) AS id FROM source_runs GROUP BY source) latest ON latest.id = r.id
    LEFT JOIN (SELECT source, MAX(window_end) AS since FROM source_runs WHERE status = 'ok' GROUP BY source) ok
      ON ok.source = r.source
    WHERE r.status != 'ok'`).all() as SourceHealth[];
  return { day: ymd(until, tz), role, readCount, items: ranked, sources, trends: detectTrends(s, until) };
}
