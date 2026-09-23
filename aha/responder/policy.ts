import { getConfig } from "../config.ts";
import { type Store } from "../store/db.ts";
import { validateReply, type Draft } from "./drafts.ts";
import { redditSubreddit } from "./post.ts";

export type PolicyResult = { allow: true } | { allow: false; reasons: string[] };

export const POLICY = {
  mention: "company not mentioned and no ask for help",
  competitor: "item is about a competitor",
  redLine: "category is a red line",
  confidence: "classification confidence below 0.8",
  rateLimit: "daily or thread reply limit",
  validator: "draft failed the reply validator",
  paused: "PAUSE is active",
} as const;

const RED_LINE = new Set(["security", "legal", "pricing"]);
const RED_TOPIC = /imprensa|press|ameaça|threat|saúde|health|política|politic|dado pessoal|pii/i;
const TOTAL_DAY = 10;
const COMMUNITY_DAY = 3;

export function isRedLine(category: string | null | undefined, topic: string | null | undefined) {
  return RED_LINE.has(category ?? "") || RED_TOPIC.test(topic ?? "");
}

type Row = {
  source: string;
  external_id: string;
  url: string | null;
  title: string | null;
  body: string | null;
  about: string | null;
  category: string | null;
  topic: string | null;
  language: string | null;
  is_question: number | null;
  confidence: number | null;
};

function ymd(now: Date) {
  return now.toISOString().slice(0, 10);
}

function mentioned(hay: string, names: string[]) {
  const text = hay.toLowerCase();
  return names.some(name => name && text.includes(name.toLowerCase()));
}

function countLedger(store: Store, like: string) {
  return (store.db.prepare("SELECT COUNT(*) AS n FROM ledger WHERE key LIKE ? AND state IN ('posting', 'posted', 'ready')").get(like) as { n: number }).n;
}

function threadTaken(store: Store, source: string, externalId: string) {
  const row = store.db.prepare("SELECT state FROM ledger WHERE key = ?").get(`thread:${source}:${externalId}`) as { state: string } | undefined;
  return row != null && ["posting", "posted", "ready"].includes(row.state);
}

export function checkPolicy(store: Store, draft: Draft, now: Date): PolicyResult {
  const cfg = getConfig(store);
  const row = store.db.prepare(`SELECT items.source, items.external_id, items.url, items.title, items.body,
      classifications.about, classifications.category, classifications.topic, classifications.language,
      classifications.is_question, classifications.confidence
    FROM items
    LEFT JOIN classifications ON classifications.item_id = items.id
    WHERE items.id = ?`).get(draft.itemId) as Row | undefined;
  if (!row || !cfg) return { allow: false, reasons: [POLICY.validator] };
  const reasons: string[] = [];
  const names = [cfg.company.name, cfg.company.product, ...(cfg.company.aliases ?? [])].filter((name): name is string => typeof name === "string");
  const ask = row.is_question === 1 && (row.about ?? "self") === "self";
  if (!mentioned(`${row.title ?? ""} ${row.body ?? ""}`, names) && !ask) reasons.push(POLICY.mention);
  if ((row.about ?? "").startsWith("competitor:")) reasons.push(POLICY.competitor);
  if (isRedLine(row.category, row.topic)) {
    reasons.push(POLICY.redLine);
    store.db.prepare("UPDATE items SET state = 'escalated' WHERE id = ?").run(draft.itemId);
  }
  if ((row.confidence ?? 0) < 0.8) reasons.push(POLICY.confidence);
  const day = ymd(now);
  const total = countLedger(store, `post:${day}:%`);
  const sub = row.source === "reddit" ? redditSubreddit(row.url) : undefined;
  const community = countLedger(store, sub ? `post:${day}:reddit:${sub}:%` : `post:${day}:${row.source}:%`);
  if (total >= TOTAL_DAY || community >= COMMUNITY_DAY || threadTaken(store, row.source, row.external_id)) {
    reasons.push(POLICY.rateLimit);
  }
  const valid = validateReply(draft.body, {
    company: cfg.company.name,
    lang: row.language || cfg.language || "en",
    url: row.url,
    links: cfg.links,
  }, "strict");
  if (!valid.ok) reasons.push(POLICY.validator);
  const paused = (store.db.prepare("SELECT paused FROM flags WHERE id = 1").get() as { paused: number } | undefined)?.paused !== 0;
  if (paused) reasons.push(POLICY.paused);
  return reasons.length === 0 ? { allow: true } : { allow: false, reasons };
}

export function recordReady(store: Store, draft: Draft, now: Date) {
  const row = store.db.prepare("SELECT source, external_id, url FROM items WHERE id = ?").get(draft.itemId) as {
    source: string; external_id: string; url: string | null;
  } | undefined;
  if (!row) return;
  const day = ymd(now);
  const sub = row.source === "reddit" ? redditSubreddit(row.url) : undefined;
  const postKey = sub ? `post:${day}:reddit:${sub}:${row.external_id}` : `post:${day}:${row.source}:${row.external_id}`;
  store.db.prepare("INSERT INTO ledger (key, state, url) VALUES (?, 'ready', ?) ON CONFLICT (key) DO UPDATE SET state = 'ready', url = excluded.url")
    .run(postKey, row.url);
  store.db.prepare("INSERT INTO ledger (key, state, url) VALUES (?, 'ready', ?) ON CONFLICT (key) DO UPDATE SET state = 'ready', url = excluded.url")
    .run(`thread:${row.source}:${row.external_id}`, row.url);
}
