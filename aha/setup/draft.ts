import { getConfig } from "../config.ts";
import { type Store } from "../store/db.ts";

// Answers the owner has given so far in the Launch watch interview, keyed like
// aha_setup_save's arguments. Only the owner's own replies are recorded here.
export type SetupAnswers = {
  company?: string;
  domain?: string;
  aliases?: string[];
  negatives?: string[];
  competitors?: string[];
  sources?: string[];
  githubRepos?: string[];
  tone?: string;
  lang?: string;
  digestHour?: number;
  tz?: string;
};

export type SetupQuestion = "company" | "aliases" | "negatives" | "competitors" | "sources" | "voice" | "digest";
export type SetupNext = SetupQuestion | "close";

// One message per question, in this order; a question is answered once all of
// its required fields are recorded (an empty list is an answer: "none").
// Optional fields belong to the question but do not hold it open.
export const SETUP_QUESTIONS: { id: SetupQuestion; fields: (keyof SetupAnswers)[]; optional?: (keyof SetupAnswers)[] }[] = [
  { id: "company", fields: ["company"], optional: ["domain"] },
  // Asked apart: asked together, an owner answers one half and the model
  // filled the other with an empty list nobody gave.
  { id: "aliases", fields: ["aliases"] },
  { id: "negatives", fields: ["negatives"] },
  { id: "competitors", fields: ["competitors"] },
  { id: "sources", fields: ["sources"], optional: ["githubRepos"] },
  { id: "voice", fields: ["tone", "lang"] },
  { id: "digest", fields: ["digestHour", "tz"] },
];

// After "not now", the gate stays quiet this long before offering setup again.
export const SETUP_DEFER_MS = 24 * 60 * 60 * 1000;

export type SetupDraft = { answers: SetupAnswers; deferredUntil: string | null };

export function getDraft(store: Store): SetupDraft {
  const row = store.db.prepare("SELECT json, deferred_until FROM setup_draft WHERE id = 1").get() as
    { json: string; deferred_until: string | null } | undefined;
  if (!row) return { answers: {}, deferredUntil: null };
  return { answers: JSON.parse(row.json) as SetupAnswers, deferredUntil: row.deferred_until };
}

export function recordAnswers(store: Store, patch: SetupAnswers): SetupAnswers {
  const answers = { ...getDraft(store).answers };
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) (answers as Record<string, unknown>)[key] = value;
  }
  // An answer means the owner is doing setup now, so any earlier "not now" is over.
  store.db.prepare(`INSERT INTO setup_draft (id, json, deferred_until) VALUES (1, ?, NULL)
    ON CONFLICT (id) DO UPDATE SET json = excluded.json, deferred_until = NULL`).run(JSON.stringify(answers));
  return answers;
}

export function deferSetup(store: Store, now: Date): string {
  const until = new Date(now.getTime() + SETUP_DEFER_MS).toISOString();
  store.db.prepare(`INSERT INTO setup_draft (id, deferred_until) VALUES (1, ?)
    ON CONFLICT (id) DO UPDATE SET deferred_until = excluded.deferred_until`).run(until);
  return until;
}

export function clearDraft(store: Store) {
  store.db.prepare("DELETE FROM setup_draft").run();
}

export function answeredFields(answers: SetupAnswers): (keyof SetupAnswers)[] {
  return (Object.keys(answers) as (keyof SetupAnswers)[]).filter(key => answers[key] !== undefined);
}

// Fields an answer may record while NEXT is `next`: that question's own, plus
// earlier ones so the owner can correct them. Later questions have not been
// asked yet, so nothing may be recorded for them.
export function recordableFields(next: SetupNext): (keyof SetupAnswers)[] {
  const upTo = next === "close" ? SETUP_QUESTIONS.length : SETUP_QUESTIONS.findIndex(q => q.id === next) + 1;
  return SETUP_QUESTIONS.slice(0, upTo).flatMap(q => [...q.fields, ...(q.optional ?? [])]);
}

export function nextQuestion(answers: SetupAnswers): SetupNext {
  const done = new Set(answeredFields(answers));
  return SETUP_QUESTIONS.find(q => q.fields.some(field => !done.has(field)))?.id ?? "close";
}

// What the owner's DM turn starts from: READY once a watch is saved (by this
// interview or a direct Launch watch request), DEFERRED while "not now" holds,
// else SETUP_NEEDED with what is recorded and the one question to send next.
export function setupStatus(store: Store, now: Date): string {
  if (getConfig(store)) return "READY";
  const draft = getDraft(store);
  if (draft.deferredUntil && Date.parse(draft.deferredUntil) > now.getTime()) return `DEFERRED\nUNTIL:${draft.deferredUntil}`;
  const fields = answeredFields(draft.answers);
  return `SETUP_NEEDED\nDRAFT:${fields.length ? fields.join(",") : "none"}\nNEXT:${nextQuestion(draft.answers)}`;
}
