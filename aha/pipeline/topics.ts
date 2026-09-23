import { type Store } from "../store/db.ts";

export type Topic = { id: number; label: string };

export function normalizeTopic(label: string) {
  return label
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[-_]+/g, " ")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function listTopics(store: Store): Topic[] {
  return store.db.prepare("SELECT id, label FROM topics ORDER BY id").all() as Topic[];
}

export function assignTopic(store: Store, label: string): number {
  const normalized = normalizeTopic(label);
  if (!normalized) throw new Error("topic label is empty");
  for (const row of listTopics(store)) {
    if (normalizeTopic(row.label) === normalized) return row.id;
  }
  store.db.prepare("INSERT INTO topics (label) VALUES (?)").run(label.trim());
  return Number((store.db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id);
}

export function topicLabel(store: Store, id: number) {
  const row = store.db.prepare("SELECT label FROM topics WHERE id = ?").get(id) as { label: string } | undefined;
  if (!row) throw new Error("unknown topic");
  return row.label;
}
