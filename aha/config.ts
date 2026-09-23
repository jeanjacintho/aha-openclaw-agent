import { type Store } from "./store/db.ts";

export type AhaConfig = {
  company: { name: string; product?: string; aliases?: string[]; domain?: string; negative?: string[] };
  competitors?: string[];
  voice?: string;
  language?: string;
  links?: string[];
};

function assertConfig(config: AhaConfig) {
  const name = config?.company?.name;
  if (typeof name !== "string" || name.trim().length === 0) throw new Error("config requires company.name");
}

export function getConfig(store: Store): AhaConfig | null {
  const row = store.db.prepare("SELECT json FROM config WHERE id = 1").get() as { json: string } | undefined;
  return row ? JSON.parse(row.json) as AhaConfig : null;
}

export function saveConfig(store: Store, config: AhaConfig) {
  assertConfig(config);
  store.db.prepare("INSERT INTO config (id, json) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET json = excluded.json").run(JSON.stringify(config));
}
