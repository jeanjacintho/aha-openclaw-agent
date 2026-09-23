import { getConfig, type AhaConfig } from "../config.ts";
import { complete, type CompleteDeps } from "../llm/client.ts";
import { classifySystemPrompt } from "../llm/prompts.ts";
import { classifyLlmSchema, parseClassification, type Classification } from "../llm/schemas.ts";
import { type Store } from "../store/db.ts";
import { stateFromClassification } from "./relevance.ts";

export const CLASSIFY_BATCH_SIZE = 20;

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
};

export type ClassifyReport = {
  classified: number;
  needsReview: number;
};

export type ClassifyDeps = CompleteDeps & {
  complete?: typeof complete;
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

function review(store: Store, id: number) {
  store.db.prepare("UPDATE items SET state = 'needs_review' WHERE id = ?").run(id);
}

function save(store: Store, id: number, c: Classification) {
  store.db.prepare("UPDATE items SET state = ? WHERE id = ?").run(stateFromClassification(c), id);
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
    id, c.sentiment, c.category, c.topic, c.lang, c.isQuestion ? 1 : 0, c.urgency, c.about, c.confidence,
  );
}

export async function classifyBatch(s: Store, items: ItemRow[], deps: ClassifyDeps = {}): Promise<ClassifyReport> {
  const batch = items.slice(0, CLASSIFY_BATCH_SIZE);
  const report: ClassifyReport = { classified: 0, needsReview: 0 };
  if (batch.length === 0) return report;
  const cfg = getConfig(s);
  if (!cfg) {
    for (const item of batch) {
      review(s, item.id);
      report.needsReview += 1;
    }
    return report;
  }
  const run = deps.complete ?? complete;
  const result = await run({
    purpose: "classify",
    system: classifySystemPrompt(cfg, feedbackExamples(s)),
    data: { posts: postsFor(batch) },
    schema: classifyLlmSchema,
  }, deps);
  const byId = new Map<number, Classification>();
  if (result.ok) {
    for (const row of result.value.results) {
      try {
        const parsed = parseClassification(row);
        if (!aboutAllowed(parsed.about, cfg)) continue;
        byId.set(row.id, parsed);
      } catch {
        /* invalid result stays missing */
      }
    }
  }
  for (const item of batch) {
    const parsed = byId.get(item.id);
    if (!parsed) {
      review(s, item.id);
      report.needsReview += 1;
      continue;
    }
    save(s, item.id, parsed);
    report.classified += 1;
  }
  return report;
}
