import { type Role } from "./pipeline/route.ts";
import { type Store } from "./store/db.ts";

export type AhaConfig = {
  company: { name: string; product?: string; aliases?: string[]; domain?: string; negative?: string[] };
  competitors?: string[];
  githubRepos?: string[];
  voice?: string;
  language?: string;
  links?: string[];
  sources?: string[];
  knowledge?: string;
  digestHour?: number;
  tz?: string;
  ownerChatUid?: string;
  agentIndexSlug?: string;
  roleChats?: Partial<Record<Role, string>>;
  tokenBudget?: number;
  postingLimits?: {
    perDay?: number;
    perCommunityPerDay?: number;
    minIntervalMinutes?: number;
  };
};

function assertConfig(config: AhaConfig) {
  const name = config?.company?.name;
  if (typeof name !== "string" || name.trim().length === 0) throw new Error("config requires company.name");
  if (config.tz) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: config.tz });
    } catch {
      throw new Error("config tz is not a valid IANA timezone");
    }
  }
  if (config.postingLimits !== undefined) {
    const limits = config.postingLimits;
    if (!limits || typeof limits !== "object" || Array.isArray(limits)) throw new Error("config postingLimits must be an object");
    const ranges = {
      perDay: [1, 50],
      perCommunityPerDay: [1, 10],
      minIntervalMinutes: [0, 720],
    } as const;
    for (const [key, [min, max]] of Object.entries(ranges) as [keyof typeof ranges, readonly [number, number]][]) {
      const value = limits[key];
      if (value !== undefined && (!Number.isInteger(value) || value < min || value > max)) {
        throw new Error(`config postingLimits.${key} must be an integer from ${min} to ${max}`);
      }
    }
    if (Object.keys(limits).some(key => !(key in ranges))) throw new Error("config postingLimits contains an unknown field");
  }
}

export function getConfig(store: Store): AhaConfig | null {
  const row = store.db.prepare("SELECT json FROM config WHERE id = 1").get() as { json: string } | undefined;
  return row ? JSON.parse(row.json) as AhaConfig : null;
}

export function saveConfig(store: Store, config: AhaConfig) {
  assertConfig(config);
  store.db.prepare("INSERT INTO config (id, json) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET json = excluded.json").run(JSON.stringify(config));
}
