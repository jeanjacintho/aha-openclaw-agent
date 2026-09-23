import { getConfig, saveConfig, type AhaConfig } from "../aha/config.ts";
import { MAX_BACKFILL_DAYS, runBackfill } from "../aha/pipeline/backfill.ts";
import { readSecrets, writeSecrets, type Secrets } from "../aha/secrets.ts";
import { ahaHome } from "../aha/home.ts";
import { agentIndexSource } from "../aha/sources/agent-index.ts";
import { hnSource } from "../aha/sources/hn.ts";
import { openStore } from "../aha/store/db.ts";

type Requester = {
  senderIsOwner?: boolean;
  requesterSenderId?: string;
  nativeChannelId?: string;
};

type ToolResult = {
  isError?: boolean;
  content: { type: "text"; text: string }[];
  details: unknown;
};

function ok(details: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(details) }], details };
}

function fail(message: string): ToolResult {
  return { isError: true, content: [{ type: "text", text: message }], details: { error: message } };
}

function strings(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  if (typeof value === "string") return value.trim() ? [value] : [];
  return undefined;
}

function secretField(source: string): keyof Secrets | undefined {
  const key = source.trim().toLowerCase().replace(/[\s_]+/g, "");
  if (key === "github") return "github";
  if (key === "reddit") return "reddit";
  if (key === "ph" || key === "producthunt" || key === "product-hunt") return "productHunt";
}

function requireOwner(ctx: Requester) {
  if (ctx.senderIsOwner !== true) return fail("only the owner can do that");
}

function requireMember(ctx: Requester) {
  if (!ctx.requesterSenderId) return fail("missing requester");
}

function requireOwnerDm(ctx: Requester) {
  const denied = requireOwner(ctx);
  if (denied) return denied;
  const store = openStore();
  try {
    const ownerChat = getConfig(store)?.ownerChatUid;
    if (!ctx.nativeChannelId || !ownerChat || ctx.nativeChannelId !== ownerChat) {
      return fail("secrets can only be set in the owner DM");
    }
  } finally {
    store.close();
  }
}

export function registerAhaTools(api: {
  registerTool: (factory: (context: Requester) => {
    name: string;
    label: string;
    description: string;
    parameters: object;
    execute: (id: string, args: Record<string, unknown>) => Promise<ToolResult>;
  }) => void;
  logger: { info: (text: string) => void };
}) {
  api.registerTool(ctx => ({
    name: "aha_setup_save",
    label: "Save AHA setup",
    description: "Save the company watch configuration from the setup interview. Owner only.",
    parameters: {
      type: "object",
      required: ["company"],
      additionalProperties: false,
      properties: {
        company: { type: "string", minLength: 1 },
        aliases: { type: "array", items: { type: "string" } },
        negatives: { type: "array", items: { type: "string" } },
        domain: { type: "string" },
        competitors: { type: "array", items: { type: "string" } },
        sources: { type: "array", items: { type: "string" } },
        knowledge: { type: "string" },
        tone: { type: "string" },
        lang: { type: "string" },
        digestHour: { type: "integer", minimum: 0, maximum: 23 },
        tz: { type: "string" },
      },
    },
    async execute(_id, args) {
      const denied = requireOwner(ctx);
      if (denied) return denied;
      const company = typeof args.company === "string" ? args.company.trim() : "";
      if (!company) return fail("company is required");
      const config: AhaConfig = {
        company: {
          name: company,
          aliases: strings(args.aliases),
          negative: strings(args.negatives),
          domain: typeof args.domain === "string" ? args.domain : undefined,
        },
        competitors: strings(args.competitors),
        sources: strings(args.sources),
        knowledge: typeof args.knowledge === "string" ? args.knowledge : undefined,
        voice: typeof args.tone === "string" ? args.tone : undefined,
        language: typeof args.lang === "string" ? args.lang : undefined,
        digestHour: typeof args.digestHour === "number" ? args.digestHour : undefined,
        tz: typeof args.tz === "string" ? args.tz : undefined,
        ownerChatUid: ctx.nativeChannelId,
      };
      const store = openStore();
      try {
        saveConfig(store, config);
      } finally {
        store.close();
      }
      api.logger.info("aha setup saved");
      return ok({ saved: true, company });
    },
  }));

  api.registerTool(ctx => ({
    name: "aha_secret_set",
    label: "Set an AHA source token",
    description: "Store a source API token. Owner only, and only in the owner DM. Never repeat the token.",
    parameters: {
      type: "object",
      required: ["source", "token"],
      additionalProperties: false,
      properties: {
        source: { type: "string" },
        token: { type: "string", minLength: 1 },
      },
    },
    async execute(_id, args) {
      const denied = requireOwnerDm(ctx);
      if (denied) return denied;
      const source = typeof args.source === "string" ? args.source : "";
      const field = secretField(source);
      if (!field) return fail("unknown source");
      const token = typeof args.token === "string" ? args.token : "";
      if (!token) return fail("token is required");
      const home = ahaHome();
      writeSecrets(home, { ...readSecrets(home), [field]: token });
      api.logger.info(`aha secret set source=${field}`);
      return ok({ source: field, set: true });
    },
  }));

  api.registerTool(ctx => ({
    name: "aha_status",
    label: "AHA status",
    description: "Show sources, health, ingest queue and pause flag. Any member.",
    parameters: { type: "object", additionalProperties: false, properties: {} },
    async execute() {
      const denied = requireMember(ctx);
      if (denied) return denied;
      const store = openStore();
      try {
        const cfg = getConfig(store);
        const paused = (store.db.prepare("SELECT paused FROM flags WHERE id = 1").get() as { paused: number } | undefined)?.paused !== 0;
        const queue = (store.db.prepare("SELECT COUNT(*) AS n FROM items WHERE state = 'new'").get() as { n: number }).n;
        const health = store.db.prepare(`SELECT r.source, r.status, r.detail, r.window_end
          FROM source_runs r
          JOIN (SELECT source, MAX(id) AS id FROM source_runs GROUP BY source) latest ON latest.id = r.id`).all() as {
          source: string; status: string; detail: string | null; window_end: string;
        }[];
        return ok({
          paused,
          sources: cfg?.sources ?? [],
          queue,
          health,
        });
      } finally {
        store.close();
      }
    },
  }));

  api.registerTool(ctx => ({
    name: "aha_backfill",
    label: "Backfill AHA sources",
    description: "Ingest mentions for the last N days (max 30). Owner only.",
    parameters: {
      type: "object",
      required: ["days"],
      additionalProperties: false,
      properties: { days: { type: "integer", minimum: 1, maximum: MAX_BACKFILL_DAYS } },
    },
    async execute(_id, args) {
      const denied = requireOwner(ctx);
      if (denied) return denied;
      const days = typeof args.days === "number" ? args.days : Number(args.days);
      if (!Number.isInteger(days) || days < 1 || days > MAX_BACKFILL_DAYS) {
        return fail("backfill days must be an integer from 1 to 30");
      }
      const store = openStore();
      try {
        const secrets = readSecrets();
        const report = await runBackfill(store, [
          hnSource(),
          agentIndexSource({ token: secrets.github, slug: getConfig(store)?.company.name }),
        ], days);
        return ok(report);
      } catch (error) {
        return fail(error instanceof Error ? error.message : "backfill failed");
      } finally {
        store.close();
      }
    },
  }));
}
