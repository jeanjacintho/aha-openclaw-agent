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
  since: string;
  detail: string | null;
};

export type DigestModel = {
  day: string;
  role: Role;
  readCount: number;
  items: DigestItem[];
  sources: SourceHealth[];
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

function excerpt(body: string | null) {
  return (body ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
}

function categoriesFor(role: Role) {
  return ROLE_CATEGORIES[role];
}

export function buildDigest(s: Store, role: Role, day: string): DigestModel {
  const readCount = (s.db.prepare("SELECT COUNT(*) AS n FROM items WHERE substr(fetched_at, 1, 10) = ?").get(day) as { n: number }).n;
  const wanted = categoriesFor(role);
  const rows = s.db.prepare(`SELECT items.id, items.body, items.url, items.state,
      classifications.category, classifications.urgency, classifications.topic
    FROM items
    JOIN classifications ON classifications.item_id = items.id
    WHERE items.state = 'relevant' AND substr(items.fetched_at, 1, 10) = ?`).all(day) as {
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
  const sources = s.db.prepare(`SELECT source, status, window_end AS since, detail
    FROM source_runs WHERE id IN (SELECT MAX(id) FROM source_runs GROUP BY source)
    AND status != 'ok'`).all() as SourceHealth[];
  return { day, role, readCount, items: ranked, sources };
}
