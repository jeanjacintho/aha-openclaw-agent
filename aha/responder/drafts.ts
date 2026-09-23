import { getConfig } from "../config.ts";
import { complete, type CompleteDeps } from "../llm/client.ts";
import { draftSystemPrompt } from "../llm/prompts.ts";
import { sendToChat, type SendDeps } from "../notify/plow.ts";
import { routeItem, type Role } from "../pipeline/route.ts";
import { type Store } from "../store/db.ts";
import { llmAllowed } from "../usage/budget.ts";
import { itemAutonomy } from "./autonomy.ts";
import { checkPolicy } from "./policy.ts";
import { postReply } from "./post.ts";
import { validateReply } from "./validate.ts";

export { hasOffListLink, isBareHost, keepLink, stripOffListLinks, validateReply, type ValidateResult } from "./validate.ts";

export type Draft = {
  id: number;
  itemId: number;
  body: string;
  state: string;
};

export type DraftDeps = CompleteDeps & SendDeps & {
  complete?: typeof complete;
};

const MAX_DRAFT_ATTEMPTS = 3;
const MAX_DRAFT_AGE_MS = 7 * 24 * 60 * 60 * 1000;

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
  const now = deps.now?.() ?? new Date();
  if (!llmAllowed(store, now)) throw new Error("token budget exhausted");
  const item = loadItem(store, itemId);
  if (!item) throw new Error("item not found");
  if (itemAutonomy(store, item.about, item.source, item.category ?? "other") === "L0") throw new Error("competitor items do not get a draft");
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

type Draftable = {
  id: number;
  source: string;
  fetchedAt: string | null;
  url: string | null;
  category: string | null;
  urgency: string | null;
  about: string | null;
  topic: string | null;
};

function tooOld(fetchedAt: string | null, now: Date) {
  if (!fetchedAt) return true;
  const at = Date.parse(fetchedAt);
  if (Number.isNaN(at)) return true;
  return now.getTime() - at > MAX_DRAFT_AGE_MS;
}

async function notifyChats(
  store: Store,
  cfg: ReturnType<typeof getConfig>,
  roles: string[],
  text: string,
  keyPrefix: string,
  itemId: number,
  deps: DraftDeps,
) {
  const fallback = cfg?.ownerChatUid || process.env.AHA_OWNER_CHAT_UID;
  const targets = (roles.length ? roles : ["founder"]).map(role => ({
    role,
    chat: cfg?.roleChats?.[role as Role] || fallback,
  }));
  const seen = new Set<string>();
  for (const target of targets) {
    if (!target.chat || seen.has(target.chat)) continue;
    seen.add(target.chat);
    await sendToChat(target.chat, text, `${keyPrefix}:${itemId}:${target.role}`, { store, fetch: deps.fetch, now: deps.now });
  }
}

function recordDraftFailure(store: Store, itemId: number, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  store.db.prepare("UPDATE items SET draft_attempts = draft_attempts + 1, draft_error = ? WHERE id = ?")
    .run(message.slice(0, 200), itemId);
}

export async function notifyExpiredDrafts(store: Store, itemIds: number[], deps: DraftDeps = {}) {
  if (!itemIds.length) return;
  const cfg = getConfig(store);
  for (const itemId of itemIds) {
    const row = store.db.prepare(`SELECT items.url, classifications.category, classifications.urgency
      FROM items
      LEFT JOIN classifications ON classifications.item_id = items.id
      WHERE items.id = ?`).get(itemId) as { url: string | null; category: string | null; urgency: string | null } | undefined;
    const roles = routeItem({ category: row?.category ?? "other", urgency: row?.urgency });
    const text = `Rascunho AHA-${itemId} expirou (retenção 90 dias).${row?.url ? `\n${row.url}` : ""}`;
    await notifyChats(store, cfg, roles.length ? roles : ["founder"], text, "expire", itemId, deps);
  }
}

export async function draftAndNotify(store: Store, deps: DraftDeps = {}) {
  const cfg = getConfig(store);
  const now = deps.now?.() ?? new Date();
  const rows = store.db.prepare(`SELECT items.id, items.source, items.fetched_at AS fetchedAt, items.url, classifications.category, classifications.urgency, classifications.about, classifications.topic
    FROM items
    JOIN classifications ON classifications.item_id = items.id
    WHERE items.state IN ('relevant', 'assigned')
      AND (classifications.about IS NULL OR classifications.about NOT LIKE 'competitor:%')
      AND items.draft_attempts < ?
      AND items.id NOT IN (SELECT item_id FROM drafts WHERE state IN ('pending', 'approved', 'ignored'))
    ORDER BY items.id`).all(MAX_DRAFT_ATTEMPTS) as Draftable[];
  for (const row of rows) {
    if (tooOld(row.fetchedAt, now)) {
      store.db.prepare("UPDATE items SET draft_attempts = ?, draft_error = ? WHERE id = ?")
        .run(MAX_DRAFT_ATTEMPTS, "item too old to draft", row.id);
      continue;
    }
    const roles = routeItem({ category: row.category ?? "other", urgency: row.urgency });
    if (redLine(row.category, row.topic)) {
      store.db.prepare("UPDATE items SET state = 'escalated' WHERE id = ? AND state IN ('relevant', 'assigned')").run(row.id);
      const text = `Escalado AHA-${row.id} (${row.category ?? "red-line"})${row.url ? `\n${row.url}` : ""}`;
      await notifyChats(store, cfg, roles.length ? roles : ["founder"], text, "escalate", row.id, deps);
      continue;
    }
    if (!llmAllowed(store, now)) continue;
    try {
      const draft = await draftReply(store, row.id, deps);
      if (itemAutonomy(store, row.about, row.source, row.category ?? "other") === "L2") {
        const policy = checkPolicy(store, draft, now);
        if (policy.allow) {
          const posted = await postReply(store, draft.id, { fetch: deps.fetch, now: deps.now });
          if (posted === "posted" || posted === "uncertain") continue;
        }
      }
      const text = `Rascunho AHA-${row.id}\n${draft.body}${row.url ? `\n${row.url}` : ""}`;
      await notifyChats(store, cfg, roles.slice(0, 1), text, "draft", row.id, deps);
    } catch (error) {
      recordDraftFailure(store, row.id, error);
    }
  }
}
