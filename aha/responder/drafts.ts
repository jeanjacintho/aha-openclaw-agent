import { getConfig } from "../config.ts";
import { complete, type CompleteDeps } from "../llm/client.ts";
import { draftSystemPrompt } from "../llm/prompts.ts";
import { sendToChat, type SendDeps } from "../notify/plow.ts";
import { routeItem } from "../pipeline/route.ts";
import { type Store } from "../store/db.ts";

export type Draft = {
  id: number;
  itemId: number;
  body: string;
  state: string;
};

export type DraftDeps = CompleteDeps & SendDeps & {
  complete?: typeof complete;
};

const MAX_BODY = 500;
const PROMISE = /(?:\$|R\$|€|£)\s*\d|\d+\s*%|\b(?:off|desconto|discount|guaranteed|garantido)\b|\b(?:within|in|em)\s+\d+\s*(?:day|days|dias|week|weeks|semanas|hour|hours|horas)\b|\b(?:next week|semana que vem|tomorrow|amanh[aã]|by friday|at[eé] sexta)\b|\bper month\b|\bprazo\b|\brefund\b|\breembolso\b|\bwe will (?:ship|deliver)\b/i;
const PT_MARK = /[áàâãéêíóôõúç]|você|não|obrigad/i;
const EN_MARK = /\b(we are|thanks for|please |the |this )\b/i;
const BARE_HOST = /(?:^|[\s(\[])((?:www\.)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s)\]]*)?)/gi;

export type ValidateResult = { ok: true; body: string } | { ok: false; reason: string };

type ItemContext = {
  id: number;
  source: string;
  url: string | null;
  title: string | null;
  body: string | null;
  about: string | null;
  language: string | null;
  category: string | null;
  topic: string | null;
};

function redLine(category: string | null, topic: string | null) {
  return category === "security" || category === "legal" || category === "pricing"
    || /imprensa|press|ameaça|threat|saúde|health|política|politic|dado pessoal|pii/i.test(topic ?? "");
}

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

function parseHttpUrl(href: string): URL | undefined {
  try {
    if (!/^https?:\/\//i.test(href.trim())) return undefined;
    return new URL(href.trim());
  } catch {
    return undefined;
  }
}

function pathBoundary(got: string, allowed: string) {
  const a = allowed.endsWith("/") ? allowed.slice(0, -1) : allowed;
  const g = got.endsWith("/") && got.length > 1 ? got.slice(0, -1) : got;
  return g === a || g.startsWith(`${a}/`);
}

export function keepLink(href: string, allowed: string[]) {
  const got = parseHttpUrl(href);
  if (!got || got.username || got.password) return false;
  return allowed.some(entry => {
    const allow = parseHttpUrl(entry);
    if (!allow) return false;
    if (got.hostname.toLowerCase() !== allow.hostname.toLowerCase()) return false;
    return pathBoundary(got.pathname || "/", allow.pathname || "/");
  });
}

function markdownHrefs(text: string) {
  return [...text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)].map(match => match[1]);
}

function httpUrls(text: string) {
  return [...text.matchAll(/https?:\/\/[^\s)]+/gi)].map(match => match[0]);
}

function bareHosts(text: string) {
  const found: string[] = [];
  for (const match of text.matchAll(BARE_HOST)) {
    const token = match[1];
    if (!token || /^https?:\/\//i.test(token)) continue;
    found.push(token);
  }
  return found;
}

export function stripOffListLinks(text: string, allowed: string[]) {
  let out = text.replace(/\[([^\]]*)\]\(([^)]+)\)/g, (full, label, href) => keepLink(String(href), allowed) ? full : String(label));
  out = out.replace(/https?:\/\/[^\s)]+/gi, url => keepLink(url, allowed) ? url : "");
  out = out.replace(BARE_HOST, (full, host) => /^https?:\/\//i.test(host) ? full : full.replace(host, ""));
  return out.replace(/[ \t]+\n/g, "\n").replace(/  +/g, " ").trim();
}

export function hasOffListLink(text: string, allowed: string[]) {
  if (httpUrls(text).some(url => !keepLink(url, allowed))) return true;
  if (markdownHrefs(text).some(href => !keepLink(href, allowed))) return true;
  return bareHosts(text).length > 0;
}

export function validateReply(text: string, ctx: { company: string; lang: string; url: string | null; links?: string[] }, mode: "clean" | "strict" = "clean"): ValidateResult {
  if (PROMISE.test(text)) return { ok: false, reason: "promise" };
  const allowed = allowedUrls(ctx.url, ctx.links);
  if (mode === "strict" && hasOffListLink(text, allowed)) return { ok: false, reason: "link" };
  let body = mode === "clean" ? stripOffListLinks(text, allowed) : text.trim();
  const lang = (ctx.lang || "en").toLowerCase();
  if (!lang.startsWith("pt") && !lang.startsWith("en")) return { ok: false, reason: "language" };
  if (lang.startsWith("pt") && (!PT_MARK.test(body) || EN_MARK.test(body))) return { ok: false, reason: "language" };
  if (lang.startsWith("en") && PT_MARK.test(body)) return { ok: false, reason: "language" };
  const sign = signature(ctx.company, lang);
  if (!body.includes(sign)) body = `${body}\n${sign}`.trim();
  if (body.length > MAX_BODY + sign.length + 2) return { ok: false, reason: "length" };
  if (!body.trim()) return { ok: false, reason: "empty" };
  return { ok: true, body };
}

function loadItem(store: Store, itemId: number): ItemContext | undefined {
  return store.db.prepare(`SELECT items.id, items.source, items.url, items.title, items.body,
      classifications.about, classifications.language, classifications.category, classifications.topic
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
  if (redLine(item.category, item.topic)) {
    store.db.prepare("UPDATE items SET state = 'escalated' WHERE id = ?").run(itemId);
    throw new Error("red-line items are escalated");
  }
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

type Draftable = { id: number; category: string | null; urgency: string | null; about: string | null; topic: string | null };

export async function draftAndNotify(store: Store, deps: DraftDeps = {}) {
  const cfg = getConfig(store);
  const rows = store.db.prepare(`SELECT items.id, classifications.category, classifications.urgency, classifications.about, classifications.topic
    FROM items
    JOIN classifications ON classifications.item_id = items.id
    WHERE items.state IN ('relevant', 'assigned')
      AND (classifications.about IS NULL OR classifications.about NOT LIKE 'competitor:%')
      AND items.id NOT IN (SELECT item_id FROM drafts WHERE state IN ('pending', 'approved'))
    ORDER BY items.id`).all() as Draftable[];
  for (const row of rows) {
    if (redLine(row.category, row.topic)) {
      store.db.prepare("UPDATE items SET state = 'escalated' WHERE id = ?").run(row.id);
      continue;
    }
    try {
      const draft = await draftReply(store, row.id, deps);
      const roles = routeItem({ category: row.category ?? "other", urgency: row.urgency });
      const role = roles[0] ?? "founder";
      const chat = cfg?.roleChats?.[role] || cfg?.ownerChatUid || process.env.AHA_OWNER_CHAT_UID;
      if (!chat) continue;
      const url = (store.db.prepare("SELECT url FROM items WHERE id = ?").get(row.id) as { url: string | null }).url;
      const text = `Rascunho AHA-${row.id}\n${draft.body}${url ? `\n${url}` : ""}`;
      await sendToChat(chat, text, `draft:${row.id}`, { store, fetch: deps.fetch, now: deps.now });
    } catch {
      /* leave the item for a later cycle */
    }
  }
}
