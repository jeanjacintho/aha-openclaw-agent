import { getConfig, type AhaConfig } from "../config.ts";
import { complete, type CompleteDeps } from "../llm/client.ts";
import { classifySystemPrompt } from "../llm/prompts.ts";
import { classifyLlmSchema, parseClassification, type Classification } from "../llm/schemas.ts";
import { type Store } from "../store/db.ts";
import { assignTopic, listTopics, topicLabel } from "./topics.ts";
import { stateFromClassification } from "./relevance.ts";

export const CLASSIFY_BATCH_SIZE = 20;
// A failed item is classified again on later passes, up to this many attempts in total.
export const MAX_CLASSIFY_ATTEMPTS = 3;
// Persistent provider/network failures also need a finite path out of the queue.
export const MAX_CLASSIFY_TRANSPORT_ATTEMPTS = 10;
export const CLASSIFY_TRANSPORT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const CLASSIFY_LEASE_MS = 2 * 60 * 1000;

export type ItemRow = {
  id: number;
  source: string;
  external_id: string;
  url: string | null;
  author: string | null;
  title: string | null;
  body: string | null;
  lang: string | null;
  published_at: string | null;
  fetched_at: string | null;
  state: string;
  classify_attempts?: number;
  classify_transport_attempts?: number;
  classify_claimed_until?: string | null;
};

export type ClassifyReport = {
  classified: number;
  needsReview: number;
};

export type ClassifyDeps = CompleteDeps & {
  complete?: typeof complete;
  now?: () => Date;
};

function feedbackExamples(store: Store) {
  return store.db.prepare("SELECT kind, text FROM feedback_examples ORDER BY id DESC LIMIT 20").all() as { kind: string; text: string }[];
}

function postsFor(items: ItemRow[]) {
  return items.map(item => ({
    id: item.id,
    source: item.source,
    author: item.author,
    title: item.title,
    body: item.body,
  }));
}

function aboutAllowed(about: Classification["about"], cfg: AhaConfig) {
  if (about === "self") return true;
  const slug = about.slice("competitor:".length).toLowerCase();
  return (cfg.competitors ?? []).some(name => name.toLowerCase() === slug);
}

function ownership(item: ItemRow) {
  return item.classify_claimed_until
    ? { sql: "classify_claimed_until = ?", args: [item.classify_claimed_until] }
    : { sql: "classify_claimed_until IS NULL", args: [] };
}

function review(store: Store, item: ItemRow) {
  const guard = ownership(item);
  return store.db.prepare(`UPDATE items SET state = 'needs_review', classify_attempts = classify_attempts + 1
    WHERE id = ? AND ${guard.sql}`).run(item.id, ...guard.args).changes > 0;
}

function recordTransportFailure(store: Store, item: ItemRow, now: Date) {
  const staleBefore = new Date(now.getTime() - CLASSIFY_TRANSPORT_MAX_AGE_MS).toISOString();
  const guard = ownership(item);
  const row = store.db.prepare(`UPDATE items SET
      classify_transport_attempts = MIN(classify_transport_attempts + 1, ?),
      state = CASE WHEN classify_transport_attempts + 1 >= ? AND fetched_at <= ? THEN 'needs_review' ELSE state END
    WHERE id = ? AND ${guard.sql} RETURNING classify_transport_attempts, fetched_at`).get(
    MAX_CLASSIFY_TRANSPORT_ATTEMPTS, MAX_CLASSIFY_TRANSPORT_ATTEMPTS, staleBefore, item.id, ...guard.args,
  ) as { classify_transport_attempts: number; fetched_at: string | null } | undefined;
  return (row?.classify_transport_attempts ?? 0) >= MAX_CLASSIFY_TRANSPORT_ATTEMPTS
    && row?.fetched_at !== null && row?.fetched_at !== undefined && row.fetched_at <= staleBefore;
}

function save(store: Store, item: ItemRow, c: Classification) {
  const guard = ownership(item);
  const topic = topicLabel(store, assignTopic(store, c.topic));
  const changed = store.db.prepare(`UPDATE items SET state = ? WHERE id = ? AND ${guard.sql}`)
    .run(stateFromClassification(c), item.id, ...guard.args).changes;
  if (!changed) return false;
  store.db.prepare(`INSERT INTO classifications (item_id, sentiment, category, topic, language, is_question, urgency, about, confidence)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (item_id) DO UPDATE SET
      sentiment = excluded.sentiment,
      category = excluded.category,
      topic = excluded.topic,
      language = excluded.language,
      is_question = excluded.is_question,
      urgency = excluded.urgency,
      about = excluded.about,
      confidence = excluded.confidence`).run(
    item.id, c.sentiment, c.category, topic, c.lang, c.isQuestion ? 1 : 0, c.urgency, c.about, c.confidence,
  );
  return true;
}

async function classifyBatchOwned(s: Store, batch: ItemRow[], deps: ClassifyDeps): Promise<ClassifyReport> {
  const report: ClassifyReport = { classified: 0, needsReview: 0 };
  if (batch.length === 0) return report;
  const cfg = getConfig(s);
  if (!cfg) {
    for (const item of batch) {
      if (review(s, item)) report.needsReview += 1;
    }
    return report;
  }
  const run = deps.complete ?? complete;
  const result = await run({
    purpose: "classify",
    system: classifySystemPrompt(cfg, feedbackExamples(s), listTopics(s).map(row => row.label)),
    data: { posts: postsFor(batch) },
    schema: classifyLlmSchema,
  }, deps);
  if (!result.ok && result.kind === "transport") {
    let exhausted = 0;
    const attemptedAt = (deps.now ?? (() => new Date()))();
    for (const item of batch) {
      if (recordTransportFailure(s, item, attemptedAt)) {
        exhausted += 1;
        report.needsReview += 1;
      }
    }
    const outcome = exhausted > 0
      ? `${exhausted} item(s) exceeded ${MAX_CLASSIFY_TRANSPORT_ATTEMPTS} attempts and 24h age and moved to needs_review`
      : `no items reached both ${MAX_CLASSIFY_TRANSPORT_ATTEMPTS} attempts and 24h age`;
    console.error(`aha: classify transport failure for ${batch.length} items; ${outcome}; remaining items will retry next cycle: ${result.reason}`);
    return report;
  }
  for (const item of batch) {
    const guard = ownership(item);
    s.db.prepare(`UPDATE items SET classify_transport_attempts = 0 WHERE id = ? AND ${guard.sql}`).run(item.id, ...guard.args);
  }
  const byId = new Map<number, Classification>();
  let rejected: string | undefined;
  if (result.ok) {
    for (const row of result.value.results) {
      try {
        const parsed = parseClassification(row);
        if (!aboutAllowed(parsed.about, cfg)) {
          rejected ??= `about ${parsed.about} is not a configured competitor`;
          continue;
        }
        byId.set(row.id, parsed);
      } catch (error) {
        rejected ??= error instanceof Error ? error.message : String(error);
      }
    }
  }
  for (const item of batch) {
    const parsed = byId.get(item.id);
    if (!parsed) {
      if (review(s, item)) report.needsReview += 1;
      continue;
    }
    if (save(s, item, parsed)) report.classified += 1;
  }
  if (report.needsReview > 0) {
    const why = result.ok ? rejected ?? "missing from model output" : result.reason;
    console.error(`aha: classify sent ${report.needsReview}/${batch.length} items to needs_review: ${why}`);
  }
  return report;
}

export async function classifyBatch(s: Store, items: ItemRow[], deps: ClassifyDeps = {}): Promise<ClassifyReport> {
  const batch = items.slice(0, CLASSIFY_BATCH_SIZE);
  try {
    return await classifyBatchOwned(s, batch, deps);
  } finally {
    for (const item of batch) {
      if (!item.classify_claimed_until) continue;
      s.db.prepare("UPDATE items SET classify_claimed_until = NULL WHERE id = ? AND classify_claimed_until = ?")
        .run(item.id, item.classify_claimed_until);
    }
  }
}
