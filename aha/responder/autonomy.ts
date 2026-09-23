import { type Store } from "../store/db.ts";

export type AutonomyLevel = "L0" | "L1" | "L2";
export type Decision = "approved" | "edited" | "ignored" | "complaint";

type DraftRef = { id: number; itemId: number; body: string; state: string };

export const L2_STREAK = 5;
export const L2_WHITELIST = new Set(["question", "praise"]);
export const POSTING_SOURCES = new Set(["reddit"]);

type AutonomyRow = { source: string; category: string; level: string; streak: number; suggested: number };

function load(store: Store, source: string, category: string): AutonomyRow {
  const row = store.db.prepare("SELECT source, category, level, streak, suggested FROM autonomy WHERE source = ? AND category = ?")
    .get(source, category) as AutonomyRow | undefined;
  return row ?? { source, category, level: "L1", streak: 0, suggested: 0 };
}

function save(store: Store, row: AutonomyRow) {
  store.db.prepare(`INSERT INTO autonomy (source, category, level, streak, suggested) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (source, category) DO UPDATE SET level = excluded.level, streak = excluded.streak, suggested = excluded.suggested`)
    .run(row.source, row.category, row.level, row.streak, row.suggested);
}

export function autonomyLevel(store: Store, source: string, category: string): AutonomyLevel {
  const level = load(store, source, category).level;
  if (level === "L2" && L2_WHITELIST.has(category) && POSTING_SOURCES.has(source)) return "L2";
  if (level === "L0") return "L0";
  return "L1";
}

export function itemAutonomy(store: Store, about: string | null | undefined, source: string, category: string): AutonomyLevel {
  if ((about ?? "").startsWith("competitor:")) return "L0";
  return autonomyLevel(store, source, category);
}

function draftContext(store: Store, draft: DraftRef) {
  return store.db.prepare(`SELECT items.source AS source, classifications.category AS category, classifications.about AS about
    FROM items
    LEFT JOIN classifications ON classifications.item_id = items.id
    WHERE items.id = ?`).get(draft.itemId) as { source: string; category: string | null; about: string | null } | undefined;
}

function demote(store: Store, source: string, category: string) {
  save(store, { source, category, level: "L1", streak: 0, suggested: 0 });
}

export function recordDecision(store: Store, draft: DraftRef, decision: Decision): { suggest?: { source: string; category: string } } {
  const ctx = draftContext(store, draft);
  if (!ctx) return {};
  if ((ctx.about ?? "").startsWith("competitor:")) return {};
  const category = ctx.category || "other";
  const row = load(store, ctx.source, category);
  if (decision === "approved") {
    if (row.level === "L2") {
      save(store, row);
      return {};
    }
    const edited = (store.db.prepare("SELECT edited FROM drafts WHERE id = ?").get(draft.id) as { edited: number } | undefined)?.edited === 1;
    if (edited) {
      store.db.prepare("UPDATE drafts SET edited = 0 WHERE id = ?").run(draft.id);
      row.level = "L1";
      save(store, row);
      return {};
    }
    if (!POSTING_SOURCES.has(ctx.source)) {
      row.level = "L1";
      save(store, row);
      return {};
    }
    row.streak += 1;
    row.level = "L1";
    if (row.streak >= L2_STREAK && row.suggested === 0) {
      row.suggested = 1;
      save(store, row);
      return { suggest: { source: ctx.source, category } };
    }
    save(store, row);
    return {};
  }
  demote(store, ctx.source, category);
  if (decision === "edited") {
    store.db.prepare("UPDATE drafts SET edited = 1 WHERE id = ?").run(draft.id);
  }
  return {};
}

export function confirmAutonomy(store: Store, source: string, category: string): { ok: true; level: "L2" } | { ok: false; reason: string } {
  if (!POSTING_SOURCES.has(source)) return { ok: false, reason: "source does not post" };
  if (!L2_WHITELIST.has(category)) return { ok: false, reason: "not in whitelist" };
  const row = load(store, source, category);
  if (row.suggested !== 1 && row.streak < L2_STREAK) return { ok: false, reason: "not suggested" };
  row.level = "L2";
  row.suggested = 0;
  save(store, row);
  return { ok: true, level: "L2" };
}

export function suggestText(source: string, category: string, lang: string) {
  if (lang.startsWith("pt")) {
    return `Promover ${category} no ${source} para automático (L2)? Confirme com aha_autonomy_confirm.`;
  }
  return `Promote ${category} on ${source} to automatic (L2)? Confirm with aha_autonomy_confirm.`;
}
