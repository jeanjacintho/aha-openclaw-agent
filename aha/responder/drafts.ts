import { getConfig } from "../config.ts";
import { complete, type CompleteDeps } from "../llm/client.ts";
import { draftSystemPrompt } from "../llm/prompts.ts";
import { type Store } from "../store/db.ts";

export type Draft = {
  id: number;
  itemId: number;
  body: string;
  state: string;
};

export type DraftDeps = CompleteDeps & {
  complete?: typeof complete;
};

const MAX_BODY = 500;
const PROMISE = /\b(by (monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow)|\bem \d+\s*dias\b|prazo|refund|reembolso|R\$\s*\d|\$\d{2,}|we will (ship|deliver) in)\b/i;
const PT_MARK = /[áàâãéêíóôõúç]|você|não|obrigad/i;

export type ValidateResult = { ok: true; body: string } | { ok: false; reason: string };

type ItemContext = {
  id: number;
  source: string;
  url: string | null;
  title: string | null;
  body: string | null;
  about: string | null;
  language: string | null;
};

function asObject(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new Error("expected object");
  return input as Record<string, unknown>;
}

export const draftLlmSchema = {
  parse(input: unknown) {
    const body = asObject(input).body;
    if (typeof body !== "string" || body.trim().length === 0) throw new Error("body must be a non-empty string");
    return { body: body.trim() };
  },
};

function signature(company: string, lang: string) {
  if (lang.startsWith("pt")) return `— AHA, assistente de IA da ${company}`;
  return `— AHA, AI assistant of ${company}`;
}

function allowedUrls(itemUrl: string | null, links: string[] | undefined) {
  return [...(links ?? []), itemUrl].filter((url): url is string => typeof url === "string" && url.length > 0);
}

function keepLink(href: string, allowed: string[]) {
  return allowed.some(url => href === url || href.startsWith(`${url}`));
}

export function stripOffListLinks(text: string, allowed: string[]) {
  let out = text.replace(/\[([^\]]*)\]\(([^)]+)\)/g, (full, label, href) => keepLink(String(href), allowed) ? full : String(label));
  out = out.replace(/https?:\/\/[^\s)]+/gi, url => keepLink(url, allowed) ? url : "");
  return out.replace(/[ \t]+\n/g, "\n").replace(/  +/g, " ").trim();
}

export function hasOffListLink(text: string, allowed: string[]) {
  for (const match of text.matchAll(/https?:\/\/[^\s)]+/gi)) {
    if (!keepLink(match[0], allowed)) return true;
  }
  for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    if (!keepLink(match[1], allowed)) return true;
  }
  return false;
}

export function validateReply(text: string, ctx: { company: string; lang: string; url: string | null; links?: string[] }, mode: "clean" | "strict" = "clean"): ValidateResult {
  if (PROMISE.test(text)) return { ok: false, reason: "promise" };
  const allowed = allowedUrls(ctx.url, ctx.links);
  if (mode === "strict" && hasOffListLink(text, allowed)) return { ok: false, reason: "link" };
  let body = mode === "clean" ? stripOffListLinks(text, allowed) : text.trim();
  const lang = (ctx.lang || "en").toLowerCase();
  if (lang.startsWith("pt") && !PT_MARK.test(body)) return { ok: false, reason: "language" };
  if (lang.startsWith("en") && PT_MARK.test(body)) return { ok: false, reason: "language" };
  const sign = signature(ctx.company, lang);
  if (!body.includes(sign)) body = `${body}\n${sign}`.trim();
  if (body.length > MAX_BODY + sign.length + 2) return { ok: false, reason: "length" };
  if (!body.trim()) return { ok: false, reason: "empty" };
  return { ok: true, body };
}

function loadItem(store: Store, itemId: number): ItemContext | undefined {
  return store.db.prepare(`SELECT items.id, items.source, items.url, items.title, items.body,
      classifications.about, classifications.language
    FROM items
    LEFT JOIN classifications ON classifications.item_id = items.id
    WHERE items.id = ?`).get(itemId) as ItemContext | undefined;
}

export async function draftReply(store: Store, itemId: number, deps: DraftDeps = {}): Promise<Draft> {
  const cfg = getConfig(store);
  if (!cfg) throw new Error("setup is required");
  const item = loadItem(store, itemId);
  if (!item) throw new Error("item not found");
  if ((item.about ?? "").startsWith("competitor:")) throw new Error("competitor items do not get a draft");
  const run = deps.complete ?? complete;
  const result = await run({
    purpose: "draft",
    system: draftSystemPrompt(cfg, item.language || cfg.language || "en"),
    data: { id: item.id, source: item.source, title: item.title, body: item.body },
    schema: draftLlmSchema,
  }, deps);
  if (!result.ok) throw new Error(result.reason);
  const checked = validateReply(result.value.body, {
    company: cfg.company.name,
    lang: item.language || cfg.language || "en",
    url: item.url,
    links: cfg.links,
  });
  if (!checked.ok) throw new Error(`draft failed validation: ${checked.reason}`);
  const inserted = store.db.prepare("INSERT INTO drafts (item_id, body, state) VALUES (?, ?, 'pending')").run(itemId, checked.body);
  return {
    id: Number(inserted.lastInsertRowid),
    itemId,
    body: checked.body,
    state: "pending",
  };
}
