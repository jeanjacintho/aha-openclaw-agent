import { normalizeTopic } from "../pipeline/topics.ts";

export type Schema<T> = {
  parse(input: unknown): T;
};

export const CATEGORIES = [
  "bug",
  "feature_request",
  "question",
  "praise",
  "complaint",
  "comparison",
  "pricing",
  "security",
  "legal",
  "other",
] as const;

export type Category = (typeof CATEGORIES)[number];

export type Classification = {
  relevant: boolean;
  confidence: number;
  about: "self" | `competitor:${string}`;
  sentiment: number;
  category: Category;
  topic: string;
  lang: string;
  isQuestion: boolean;
  urgency: "low" | "med" | "high";
  reason: string;
};

export type ClassifyHit = { id: number } & Record<string, unknown>;

export type ClassifyLlmOut = { results: ClassifyHit[] };

function fail(message: string): never {
  throw new Error(message);
}

function asObject(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) fail("expected object");
  return input as Record<string, unknown>;
}

function bool(value: unknown, name: string) {
  if (typeof value !== "boolean") fail(`${name} must be boolean`);
  return value;
}

function str(value: unknown, name: string) {
  if (typeof value !== "string" || value.trim().length === 0) fail(`${name} must be a non-empty string`);
  return value.trim();
}

function num(value: unknown, name: string) {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(`${name} must be a finite number`);
  return value;
}

function about(value: unknown): Classification["about"] {
  const text = str(value, "about");
  if (text === "self") return "self";
  if (text.startsWith("competitor:") && text.slice("competitor:".length).trim().length > 0) {
    return text as `competitor:${string}`;
  }
  fail("about must be self or competitor:<slug>");
}

function category(value: unknown): Category {
  const text = str(value, "category");
  if ((CATEGORIES as readonly string[]).includes(text)) return text as Category;
  fail("category is not in the allowed list");
}

function urgency(value: unknown): Classification["urgency"] {
  const text = str(value, "urgency");
  if (text === "low" || text === "med" || text === "high") return text;
  fail("urgency must be low, med, or high");
}

function hasUrl(text: string) {
  return /:\/\//.test(text) || /\]\s*\(/.test(text) || /www\./i.test(text);
}

function badTopic(text: string) {
  return hasUrl(text) || /[\/@]/.test(text) || text.length > 80 || !normalizeTopic(text);
}

export function parseClassification(input: unknown): Classification {
  const row = asObject(input);
  const relevant = bool(row.relevant, "relevant");
  const confidence = num(row.confidence, "confidence");
  if (confidence < 0 || confidence > 1) fail("confidence must be between 0 and 1");
  const sentiment = num(row.sentiment, "sentiment");
  if (sentiment < -1 || sentiment > 1) fail("sentiment must be between -1 and 1");
  const topic = str(row.topic, "topic");
  const lang = str(row.lang, "lang");
  const reason = str(row.reason, "reason");
  if (badTopic(topic) || hasUrl(lang) || (row.about != null && hasUrl(String(row.about)))) fail("topic must be short text without URLs");
  const aboutVal = !relevant && (row.about == null || row.about === "") ? "self" : about(row.about);
  return {
    relevant,
    confidence,
    about: aboutVal,
    sentiment,
    category: category(row.category),
    topic,
    lang,
    isQuestion: bool(row.isQuestion, "isQuestion"),
    urgency: urgency(row.urgency),
    reason,
  };
}

export const classificationSchema: Schema<Classification> = { parse: parseClassification };

export const classifyLlmSchema: Schema<ClassifyLlmOut> = {
  parse(input: unknown) {
    const row = asObject(input);
    if (!Array.isArray(row.results)) fail("results must be an array");
    return {
      results: row.results.map(item => {
        const obj = asObject(item);
        const id = num(obj.id, "id");
        if (!Number.isInteger(id)) fail("id must be an integer");
        return { ...obj, id };
      }),
    };
  },
};
