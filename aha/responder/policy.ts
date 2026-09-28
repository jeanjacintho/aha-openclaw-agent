import { getConfig } from "../config.ts";
import { type Store } from "../store/db.ts";
import { validateReply } from "./validate.ts";
import { postLedgerKey, redditSubreddit, threadLedgerKey } from "./reddit-url.ts";

export type PolicyResult = { allow: true } | { allow: false; reasons: string[]; nextAllowedAt?: string; postingReasons?: string[] };

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
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_POSTING_LIMITS = { perDay: 10, perCommunityPerDay: 3, minIntervalMinutes: 10 } as const;
const COUNTED = ["posting", "posted", "ready", "verified", "uncertain"] as const;

export function isRedLine(category: string | null | undefined, topic: string | null | undefined) {
  return RED_LINE.has(category ?? "") || RED_TOPIC.test(topic ?? "");
}

type Draft = { id: number; itemId: number; body: string; state: string };

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

function mentioned(hay: string, names: string[]) {
  const text = hay.toLowerCase();
  return names.some(name => name && text.includes(name.toLowerCase()));
}

function postingLimits(store: Store) {
  const configured = getConfig(store)?.postingLimits;
  return {
    perDay: configured?.perDay ?? DEFAULT_POSTING_LIMITS.perDay,
    perCommunityPerDay: configured?.perCommunityPerDay ?? DEFAULT_POSTING_LIMITS.perCommunityPerDay,
    minIntervalMinutes: configured?.minIntervalMinutes ?? DEFAULT_POSTING_LIMITS.minIntervalMinutes,
  };
}

function recentPostClaims(store: Store, cutoff: string, now: Date) {
  const rows = store.db.prepare(`SELECT key, claimed_at AS claimedAt FROM ledger
    WHERE key LIKE 'post:%' AND state IN ('posting', 'posted', 'ready', 'verified', 'uncertain')
      AND (claimed_at IS NULL OR claimed_at > ?)`)
    .all(cutoff) as { key: string; claimedAt: string | null }[];
  return rows.map(row => {
    const timestamp = row.claimedAt ? Date.parse(row.claimedAt) : now.getTime();
    return { key: row.key, at: Number.isFinite(timestamp) ? timestamp : now.getTime() };
  });
}

function threadTaken(store: Store, source: string, externalId: string, url: string | null) {
  const row = store.db.prepare("SELECT state FROM ledger WHERE key = ?").get(threadLedgerKey(source, externalId, url)) as { state: string } | undefined;
  return row != null && (COUNTED as readonly string[]).includes(row.state);
}

export type PostingLimitResult = { reasons: string[]; nextAllowedAt: string | null };

export function postingLimitReasons(store: Store, itemId: number, now: Date): PostingLimitResult {
  const row = store.db.prepare("SELECT source, external_id AS externalId, url FROM items WHERE id = ?")
    .get(itemId) as { source: string; externalId: string; url: string | null } | undefined;
  if (!row) return { reasons: ["item not found"], nextAllowedAt: null };
  const cutoff = new Date(now.getTime() - DAY_MS).toISOString();
  const claims = recentPostClaims(store, cutoff, now);
  const totalTimes = claims.map(claim => claim.at).sort((a, b) => a - b);
  const sub = row.source === "reddit" ? redditSubreddit(row.url) : undefined;
  const communityTimes = claims.filter(({ key }) => {
    const parts = key.split(":");
    if (row.source === "reddit") return parts[2] === "reddit" && (!sub || parts[3] === sub);
    return parts[2] === row.source;
  }).map(claim => claim.at).sort((a, b) => a - b);
  const redditTimes = row.source === "reddit"
    ? claims.filter(({ key }) => key.split(":")[2] === "reddit").map(claim => claim.at).sort((a, b) => a - b)
    : [];
  const limits = postingLimits(store);
  const reasons: string[] = [];
  const releaseTimes: number[] = [];
  if (totalTimes.length >= limits.perDay) {
    reasons.push("rolling 24-hour posting limit reached");
    releaseTimes.push(totalTimes[0] + DAY_MS);
  }
  if (communityTimes.length >= limits.perCommunityPerDay) {
    reasons.push("rolling 24-hour community posting limit reached");
    releaseTimes.push(communityTimes[0] + DAY_MS);
  }
  if (limits.minIntervalMinutes > 0 && redditTimes.length > 0) {
    const releaseAt = redditTimes[redditTimes.length - 1] + limits.minIntervalMinutes * 60_000;
    if (releaseAt > now.getTime()) {
      reasons.push("minimum interval between Reddit posts has not elapsed");
      releaseTimes.push(releaseAt);
    }
  }
  if (threadTaken(store, row.source, row.externalId, row.url)) reasons.push("thread already has a counted post");
  const nextAllowedAt = releaseTimes.length > 0 ? new Date(Math.max(...releaseTimes)).toISOString() : null;
  return { reasons, nextAllowedAt };
}

export function postingLimitMessage(store: Store, nextAllowedAt: string, reasons: string[] = []) {
  const cfg = getConfig(store);
  const timezone = cfg?.tz || "UTC";
  const locale = cfg?.language?.toLowerCase().startsWith("pt") ? "pt-BR" : "en-US";
  let time: string;
  try {
    time = new Intl.DateTimeFormat(locale, { timeZone: timezone, dateStyle: "medium", timeStyle: "short" }).format(new Date(nextAllowedAt));
  } catch {
    time = new Intl.DateTimeFormat(locale, { timeZone: "UTC", dateStyle: "medium", timeStyle: "short" }).format(new Date(nextAllowedAt));
  }
  const labels = locale === "pt-BR"
    ? reasons.map(reason => ({
      "rolling 24-hour posting limit reached": "o limite total móvel de 24 horas",
      "rolling 24-hour community posting limit reached": "o limite móvel de 24 horas da comunidade",
      "minimum interval between Reddit posts has not elapsed": "o intervalo mínimo entre posts no Reddit",
    } as Record<string, string>)[reason] ?? reason)
    : reasons.map(reason => ({
      "rolling 24-hour posting limit reached": "daily posting limit reached",
      "rolling 24-hour community posting limit reached": "community posting limit reached",
    } as Record<string, string>)[reason] ?? reason);
  const rules = labels.length ? ` (${labels.join("; ")})` : "";
  return locale === "pt-BR"
    ? `O limite de ritmo de publicação${rules} foi atingido. Você poderá tentar novamente após ${time} (${timezone}).`
    : `The posting pace limit${rules} was reached. You can try again after ${time} (${timezone}).`;
}

export function postingPaused(store: Store) {
  return (store.db.prepare("SELECT paused FROM flags WHERE id = 1").get() as { paused: number } | undefined)?.paused !== 0;
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
  if (draft.state !== "pending" || !draft.body.trim()) return { allow: false, reasons: [POLICY.validator] };
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
  const limit = postingLimitReasons(store, draft.itemId, now);
  if (limit.reasons.length > 0) {
    reasons.push(POLICY.rateLimit);
  }
  const valid = validateReply(draft.body, {
    company: cfg.company.name,
    lang: row.language || cfg.language || "en",
    url: row.url,
    links: cfg.links,
  }, "strict");
  if (!valid.ok) reasons.push(POLICY.validator);
  if (postingPaused(store)) reasons.push(POLICY.paused);
  return reasons.length === 0 ? { allow: true } : {
    allow: false,
    reasons,
    ...(limit.nextAllowedAt ? { nextAllowedAt: limit.nextAllowedAt } : {}),
    ...(limit.reasons.length ? { postingReasons: limit.reasons } : {}),
  };
}

export function recordReady(store: Store, draft: Draft, now: Date) {
  const row = store.db.prepare("SELECT source, external_id, url FROM items WHERE id = ?").get(draft.itemId) as {
    source: string; external_id: string; url: string | null;
  } | undefined;
  if (!row) return;
  const day = now.toISOString().slice(0, 10);
  const postKey = postLedgerKey(day, row.source, row.external_id, row.url);
  const threadKey = threadLedgerKey(row.source, row.external_id, row.url);
  store.db.prepare("INSERT INTO ledger (key, state, url, claimed_at) VALUES (?, 'ready', ?, ?) ON CONFLICT (key) DO NOTHING")
    .run(postKey, row.url, now.toISOString());
  store.db.prepare("INSERT INTO ledger (key, state, url, claimed_at) VALUES (?, 'ready', ?, ?) ON CONFLICT (key) DO NOTHING")
    .run(threadKey, row.url, now.toISOString());
}
