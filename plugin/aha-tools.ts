import { getConfig, saveConfig, type AhaConfig } from "../aha/config.ts";
import { deliverDigest, digestNowKey, digestSendReply } from "../aha/digest/deliver.ts";
import { MAX_BACKFILL_DAYS, runBackfill } from "../aha/pipeline/backfill.ts";
import { readSecrets, writeSecrets, type Secrets } from "../aha/secrets.ts";
import { ahaHome } from "../aha/home.ts";
import { watchAdapters } from "../aha/sources/watch.ts";
import { openStore } from "../aha/store/db.ts";
import { ownerChat, type Account } from "./transport.ts";

type PlowChannel = { apiBase?: string; lineUid?: string; emailLineUid?: string; accountId?: string };

type Requester = {
  senderIsOwner?: boolean;
  requesterSenderId?: string;
  nativeChannelId?: string;
  config?: object;
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

function plowAccount(ctx: Requester): Account | undefined {
  const plow = ctx.config && typeof ctx.config === "object"
    ? (ctx.config as { channels?: { plow?: PlowChannel } }).channels?.plow
    : undefined;
  if (!plow?.apiBase || !plow.lineUid) return undefined;
  return { apiBase: plow.apiBase, lineUid: plow.lineUid, emailLineUid: plow.emailLineUid, accountId: plow.accountId ?? "chat" };
}

async function ownerDmUid(ctx: Requester) {
  const account = plowAccount(ctx);
  if (!account) throw new Error("Plow configuration is unavailable");
  const chat = await ownerChat(account);
  if (chat.participants.length !== 2) throw new Error("owner DM is not a direct chat");
  return chat.uid;
}

async function requireOwnerDm(ctx: Requester) {
  const denied = requireOwner(ctx);
  if (denied) return denied;
  try {
    const uid = await ownerDmUid(ctx);
    if (!ctx.nativeChannelId || ctx.nativeChannelId !== uid) return fail("secrets can only be set in the owner DM");
  } catch {
    return fail("secrets can only be set in the owner DM");
  }
}

function mergeSetup(previous: AhaConfig | null, args: Record<string, unknown>, ownerChatUid: string): AhaConfig {
  const company = typeof args.company === "string" ? args.company.trim() : previous?.company.name ?? "";
  return {
    ...previous,
    company: {
      ...previous?.company,
      name: company,
      aliases: strings(args.aliases) ?? previous?.company.aliases,
      negative: strings(args.negatives) ?? previous?.company.negative,
      domain: typeof args.domain === "string" ? args.domain : previous?.company.domain,
    },
    competitors: strings(args.competitors) ?? previous?.competitors,
    sources: strings(args.sources) ?? previous?.sources,
    knowledge: typeof args.knowledge === "string" ? args.knowledge : previous?.knowledge,
    voice: typeof args.tone === "string" ? args.tone : previous?.voice,
    language: typeof args.lang === "string" ? args.lang : previous?.language,
    digestHour: typeof args.digestHour === "number" ? args.digestHour : previous?.digestHour,
    tz: typeof args.tz === "string" ? args.tz : previous?.tz,
    agentIndexSlug: previous?.agentIndexSlug || process.env.AGENT_ID,
    ownerChatUid,
  };
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
    description: "Save the company watch configuration from the setup interview. Owner only. Pins the owner DM from the host, not the chat that called the tool.",
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
      let ownerChatUid: string;
      try {
        ownerChatUid = await ownerDmUid(ctx);
      } catch (error) {
        return fail(error instanceof Error ? error.message : "cannot resolve owner DM");
      }
      const store = openStore();
      try {
        saveConfig(store, mergeSetup(getConfig(store), args, ownerChatUid));
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
      const denied = await requireOwnerDm(ctx);
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
      // Spec §8.1 wants collection on the worker. This still runs in the gateway
      // process for the tool call; public text is not returned to the model.
      const store = openStore();
      try {
        const report = await runBackfill(store, watchAdapters(getConfig(store)), days);
        return ok(report);
      } catch (error) {
        return fail(error instanceof Error ? error.message : "backfill failed");
      } finally {
        store.close();
      }
    },
  }));

  api.registerTool(ctx => ({
    name: "aha_digest_now",
    label: "Send the AHA digest now",
    description: "Classify pending items and send the digest to the owner DM. Owner only. Returns {sent:true} without digest text, or {sent:false, reason} if delivery was duplicate or uncertain.",
    parameters: { type: "object", additionalProperties: false, properties: {} },
    async execute() {
      const denied = requireOwner(ctx);
      if (denied) return denied;
      const store = openStore();
      try {
        const at = new Date();
        const result = await deliverDigest(store, { now: () => at, key: digestNowKey(at) });
        if (result === "failed") return fail("digest failed");
        return ok(digestSendReply(result));
      } catch (error) {
        return fail(error instanceof Error ? error.message : "digest failed");
      } finally {
        store.close();
      }
    },
  }));
}
