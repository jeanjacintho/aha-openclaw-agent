import { getConfig, saveConfig, type AhaConfig } from "../aha/config.ts";
import { deliverDigest, digestNowKey, digestSendReply } from "../aha/digest/deliver.ts";
import { sendToChat } from "../aha/notify/plow.ts";
import { MAX_BACKFILL_DAYS, runBackfill } from "../aha/pipeline/backfill.ts";
import { isRole, ROLES, routeItem, type Role } from "../aha/pipeline/route.ts";
import { readSecrets, writeSecrets, type Secrets } from "../aha/secrets.ts";
import { ahaHome } from "../aha/home.ts";
import { watchAdapters } from "../aha/sources/watch.ts";
import { openStore, type Store } from "../aha/store/db.ts";
import { checkPolicy, recordReady } from "../aha/responder/policy.ts";
import { validateReply, type Draft } from "../aha/responder/drafts.ts";
import { ownerChat, request, type Account, type Chat, type Page } from "./transport.ts";
import { createHash } from "node:crypto";

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

function memberRoles(store: Store, memberUid: string): Role[] {
  return (store.db.prepare("SELECT role FROM people_roles WHERE person = ?").all(memberUid) as { role: string }[])
    .map(row => row.role)
    .filter(isRole);
}

function roleForChat(cfg: AhaConfig | null, chatUid: string | undefined): Role | undefined {
  if (!cfg?.roleChats || !chatUid) return undefined;
  for (const role of ROLES) {
    if (cfg.roleChats[role] === chatUid) return role;
  }
}

function itemClassification(store: Store, itemId: number) {
  return store.db.prepare(`SELECT items.state AS state, classifications.category AS category, classifications.urgency AS urgency
    FROM items
    LEFT JOIN classifications ON classifications.item_id = items.id
    WHERE items.id = ?`).get(itemId) as { state: string; category: string | null; urgency: string | null } | undefined;
}

function sliceItems(store: Store, role: Role) {
  const rows = store.db.prepare(`SELECT items.id, items.state, classifications.category, classifications.urgency
    FROM items
    JOIN classifications ON classifications.item_id = items.id
    WHERE items.state IN ('relevant', 'assigned')
    ORDER BY items.id`).all() as {
    id: number; state: string; category: string | null; urgency: string | null;
  }[];
  const items = rows
    .filter(row => routeItem({ category: row.category ?? "other", urgency: row.urgency }).includes(role))
    .map(row => ({
      id: row.id,
      state: row.state,
      category: row.category ?? "other",
      urgency: row.urgency ?? "low",
    }));
  return {
    items,
    counts: {
      relevant: items.filter(item => item.state === "relevant").length,
      assigned: items.filter(item => item.state === "assigned").length,
    },
  };
}

type MemberEntry = { uid: string; providerKey: string };

async function memberDirectory(account: Account): Promise<MemberEntry[]> {
  const listing = await request<Page<Chat>>(account, "/chats");
  if (listing.has_more) throw new Error("Cannot resolve members from a truncated chat listing");
  const byUid = new Map<string, string>();
  for (const chat of listing.data ?? []) {
    for (const person of chat.participants) {
      if (person.type !== "member" || !person.uid || !person.provider_key) continue;
      byUid.set(person.uid, person.provider_key);
    }
  }
  return [...byUid.entries()].map(([uid, providerKey]) => ({ uid, providerKey }));
}

function resolveMember(directory: MemberEntry[], memberUid: string): MemberEntry | undefined {
  return directory.find(row => row.uid === memberUid || row.providerKey === memberUid);
}

function claimRoles(store: Store, ctx: Requester): Role[] {
  const mine = ctx.requesterSenderId ? memberRoles(store, ctx.requesterSenderId) : [];
  if (ctx.senderIsOwner) return [...ROLES];
  return mine;
}

function publicId(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  if (typeof value === "string") {
    const match = value.trim().match(/^(?:AHA-)?(\d+)$/i);
    if (match) return Number(match[1]);
  }
}

function canActOnItem(store: Store, ctx: Requester, itemId: number) {
  const row = itemClassification(store, itemId);
  if (!row?.category) return fail("item not found");
  if (ctx.senderIsOwner) return;
  const roles = routeItem({ category: row.category, urgency: row.urgency });
  const mine = claimRoles(store, ctx);
  if (!roles.some(role => mine.includes(role))) return fail("not a member of this item's role");
}

function pendingDraftForItem(store: Store, itemId: number): Draft | undefined {
  return store.db.prepare("SELECT id, item_id AS itemId, body, state FROM drafts WHERE item_id = ? AND state = 'pending' ORDER BY id DESC LIMIT 1").get(itemId) as Draft | undefined;
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

  api.registerTool(ctx => ({
    name: "aha_role_assign",
    label: "Assign an AHA role",
    description: "Assign a member to founder, produto, marketing, or engenharia. Owner only.",
    parameters: {
      type: "object",
      required: ["memberUid", "role"],
      additionalProperties: false,
      properties: {
        memberUid: { type: "string", minLength: 1 },
        role: { type: "string", enum: [...ROLES] },
      },
    },
    async execute(_id, args) {
      const denied = requireOwner(ctx);
      if (denied) return denied;
      const memberUid = typeof args.memberUid === "string" ? args.memberUid.trim() : "";
      const role = typeof args.role === "string" ? args.role : "";
      if (!memberUid) return fail("memberUid is required");
      if (!isRole(role)) return fail("unknown role");
      const account = plowAccount(ctx);
      if (!account) return fail("Plow configuration is unavailable");
      let person: string;
      try {
        const directory = await memberDirectory(account);
        const resolved = resolveMember(directory, memberUid);
        if (!resolved) return fail("unknown member");
        person = resolved.uid;
      } catch (error) {
        return fail(error instanceof Error ? error.message : "could not list members");
      }
      const store = openStore();
      try {
        store.db.prepare("INSERT INTO people_roles (person, role) VALUES (?, ?) ON CONFLICT (person, role) DO NOTHING").run(person, role);
        return ok({ memberUid: person, role });
      } finally {
        store.close();
      }
    },
  }));

  api.registerTool(ctx => ({
    name: "aha_role_groups_create",
    label: "Create AHA role groups",
    description: "Start a Plow group per role (plow_start_thread contract: POST /chats) and store each chat uid. Owner only.",
    parameters: { type: "object", additionalProperties: false, properties: {} },
    async execute() {
      const denied = requireOwner(ctx);
      if (denied) return denied;
      const account = plowAccount(ctx);
      if (!account) return fail("Plow configuration is unavailable");
      let ownerKey: string;
      try {
        const chat = await ownerChat(account);
        const owner = chat.participants.find(p => p.type === "member" && p.role === "owner");
        if (owner?.type !== "member" || !owner.provider_key) return fail("The owner's chat has no owner handle");
        ownerKey = owner.provider_key;
      } catch {
        return fail("The owner's chat has no owner handle");
      }
      const store = openStore();
      try {
        const cfg = getConfig(store);
        if (!cfg) return fail("setup is required");
        const roleChats = { ...cfg.roleChats };
        const directory = await memberDirectory(account);
        const assigned = store.db.prepare("SELECT person, role FROM people_roles").all() as { person: string; role: string }[];
        for (const role of ROLES) {
          if (roleChats[role]) continue;
          const members = [ownerKey];
          for (const row of assigned.filter(entry => entry.role === role)) {
            const resolved = resolveMember(directory, row.person);
            if (!resolved) return fail(`unknown member ${row.person}`);
            if (!members.includes(resolved.providerKey)) members.push(resolved.providerKey);
          }
          const body = `Grupo ${role} do AHA`;
          const idempotencyKey = createHash("sha256").update(JSON.stringify([account.lineUid, role, members, body])).digest("hex");
          const chat = await request<{ uid: string }>(account, "/chats", {
            line_uid: account.lineUid,
            members,
            body,
            trusted: true,
            idempotency_key: idempotencyKey,
          });
          roleChats[role] = chat.uid;
        }
        saveConfig(store, { ...cfg, roleChats });
        return ok({ roleChats });
      } catch (error) {
        return fail(error instanceof Error ? error.message : "could not create role groups");
      } finally {
        store.close();
      }
    },
  }));

  api.registerTool(ctx => ({
    name: "aha_claim",
    label: "Claim an AHA item",
    description: "Claim a relevant item for your role. Members of a routed role only. Sets state to assigned.",
    parameters: {
      type: "object",
      required: ["itemId"],
      additionalProperties: false,
      properties: { itemId: { type: "integer" } },
    },
    async execute(_id, args) {
      const denied = requireMember(ctx);
      if (denied) return denied;
      const itemId = typeof args.itemId === "number" ? args.itemId : Number(args.itemId);
      if (!Number.isInteger(itemId) || itemId < 1) return fail("itemId is required");
      const store = openStore();
      try {
        const row = itemClassification(store, itemId);
        if (!row?.category) return fail("item not found");
        if (row.state !== "relevant") return fail("item is not claimable");
        const roles = routeItem({ category: row.category, urgency: row.urgency });
        const mine = claimRoles(store, ctx);
        if (!roles.some(role => mine.includes(role))) return fail("not a member of this item's role");
        const claimed = store.db.prepare("UPDATE items SET state = 'assigned', assignee = ? WHERE id = ? AND state = 'relevant'")
          .run(ctx.requesterSenderId, itemId);
        if (claimed.changes !== 1) return fail("item is not claimable");
        return ok({ itemId, state: "assigned", assignee: ctx.requesterSenderId });
      } finally {
        store.close();
      }
    },
  }));

  api.registerTool(ctx => ({
    name: "aha_ask",
    label: "Ask about this role's AHA slice",
    description: "Return store data for the role of the current group. Does not mix other roles' items. Any member in a role group.",
    parameters: {
      type: "object",
      required: ["question"],
      additionalProperties: false,
      properties: { question: { type: "string" } },
    },
    async execute(_id, args) {
      const denied = requireMember(ctx);
      if (denied) return denied;
      if (typeof args.question !== "string") return fail("question is required");
      const store = openStore();
      try {
        const role = roleForChat(getConfig(store), ctx.nativeChannelId);
        if (!role) return fail("this chat is not a role group");
        return ok({ role, ...sliceItems(store, role) });
      } finally {
        store.close();
      }
    },
  }));

  api.registerTool(ctx => ({
    name: "aha_approve",
    label: "Approve an AHA draft",
    description: "Approve the pending draft for an item (AHA-n is always the item id). Owner or a member of the item's role. Sends the reply text to this chat; the tool result is only {sent:true}.",
    parameters: {
      type: "object",
      required: ["draftId"],
      additionalProperties: false,
      properties: { draftId: { type: ["integer", "string"] } },
    },
    async execute(_id, args) {
      const denied = requireMember(ctx);
      if (denied) return denied;
      const id = publicId(args.draftId);
      if (!id) return fail("draftId is required");
      const store = openStore();
      try {
        const draft = pendingDraftForItem(store, id);
        if (!draft || draft.state !== "pending") return fail("draft not found");
        const blocked = canActOnItem(store, ctx, draft.itemId);
        if (blocked) return blocked;
        const now = new Date();
        const policy = checkPolicy(store, draft, now);
        if (!policy.allow) return ok({ sent: false, reason: policy.reasons.join("; ") });
        const claimed = store.db.prepare("UPDATE drafts SET state = 'approved' WHERE id = ? AND state = 'pending'").run(draft.id);
        if (claimed.changes !== 1) return fail("draft is not claimable");
        recordReady(store, draft, now);
        const chat = ctx.nativeChannelId;
        if (!chat) return fail("missing chat");
        const item = store.db.prepare("SELECT url FROM items WHERE id = ?").get(draft.itemId) as { url: string | null };
        const text = `${draft.body}${item.url ? `\n${item.url}` : ""}`;
        const result = await sendToChat(chat, text, `approve:${draft.id}`, { store });
        return ok(digestSendReply(result));
      } finally {
        store.close();
      }
    },
  }));

  api.registerTool(ctx => ({
    name: "aha_edit",
    label: "Edit an AHA draft",
    description: "Replace the body of a pending draft. Owner or a member of the item's role.",
    parameters: {
      type: "object",
      required: ["draftId", "text"],
      additionalProperties: false,
      properties: {
        draftId: { type: ["integer", "string"] },
        text: { type: "string", minLength: 1 },
      },
    },
    async execute(_id, args) {
      const denied = requireMember(ctx);
      if (denied) return denied;
      const id = publicId(args.draftId);
      const text = typeof args.text === "string" ? args.text : "";
      if (!id) return fail("draftId is required");
      if (!text.trim()) return fail("text is required");
      const store = openStore();
      try {
        const draft = pendingDraftForItem(store, id);
        if (!draft || draft.state !== "pending") return fail("draft not found");
        const blocked = canActOnItem(store, ctx, draft.itemId);
        if (blocked) return blocked;
        const cfg = getConfig(store);
        const row = store.db.prepare(`SELECT items.url, classifications.language FROM items
          LEFT JOIN classifications ON classifications.item_id = items.id WHERE items.id = ?`).get(draft.itemId) as {
          url: string | null; language: string | null;
        };
        const checked = validateReply(text, {
          company: cfg?.company.name || "AHA",
          lang: row.language || cfg?.language || "en",
          url: row.url,
          links: cfg?.links,
        });
        if (!checked.ok) return fail(`draft failed validation: ${checked.reason}`);
        store.db.prepare("UPDATE drafts SET body = ? WHERE id = ?").run(checked.body, draft.id);
        return ok({ draftId: draft.id, publicId: `AHA-${draft.itemId}`, edited: true });
      } finally {
        store.close();
      }
    },
  }));

  api.registerTool(ctx => ({
    name: "aha_ignore",
    label: "Ignore an AHA draft",
    description: "Ignore a pending draft. Owner or a member of the item's role.",
    parameters: {
      type: "object",
      required: ["draftId", "reason"],
      additionalProperties: false,
      properties: {
        draftId: { type: ["integer", "string"] },
        reason: { type: "string", minLength: 1 },
      },
    },
    async execute(_id, args) {
      const denied = requireMember(ctx);
      if (denied) return denied;
      const id = publicId(args.draftId);
      const reason = typeof args.reason === "string" ? args.reason.trim() : "";
      if (!id) return fail("draftId is required");
      if (!reason) return fail("reason is required");
      const store = openStore();
      try {
        const draft = pendingDraftForItem(store, id);
        if (!draft || draft.state !== "pending") return fail("draft not found");
        const blocked = canActOnItem(store, ctx, draft.itemId);
        if (blocked) return blocked;
        store.db.prepare("UPDATE drafts SET state = 'ignored' WHERE id = ? AND state = 'pending'").run(draft.id);
        return ok({ draftId: draft.id, publicId: `AHA-${draft.itemId}`, ignored: true });
      } finally {
        store.close();
      }
    },
  }));

  api.registerTool(ctx => ({
    name: "aha_not_us",
    label: "Mark an AHA item as not us",
    description: "Record a negative classification example for this item. Owner or a member of the item's role.",
    parameters: {
      type: "object",
      required: ["itemId"],
      additionalProperties: false,
      properties: { itemId: { type: ["integer", "string"] } },
    },
    async execute(_id, args) {
      const denied = requireMember(ctx);
      if (denied) return denied;
      const itemId = publicId(args.itemId);
      if (!itemId) return fail("itemId is required");
      const store = openStore();
      try {
        const blocked = canActOnItem(store, ctx, itemId);
        if (blocked) return blocked;
        store.db.prepare("INSERT INTO feedback_examples (item_id, kind, text) VALUES (?, 'negative', ?)").run(itemId, `NOT US AHA-${itemId}`);
        store.db.prepare("UPDATE items SET state = 'irrelevant' WHERE id = ?").run(itemId);
        return ok({ itemId, publicId: `AHA-${itemId}`, recorded: true });
      } finally {
        store.close();
      }
    },
  }));

  api.registerTool(ctx => ({
    name: "aha_logs",
    label: "Show AHA item history",
    description: "Return store history for an item (AHA-n). Owner or a member of the item's role. Omits the public post body.",
    parameters: {
      type: "object",
      required: ["id"],
      additionalProperties: false,
      properties: { id: { type: ["integer", "string"] } },
    },
    async execute(_id, args) {
      const denied = requireMember(ctx);
      if (denied) return denied;
      const itemId = publicId(args.id);
      if (!itemId) return fail("id is required");
      const store = openStore();
      try {
        const blocked = canActOnItem(store, ctx, itemId);
        if (blocked) return blocked;
        const item = store.db.prepare("SELECT id, source, external_id, url, state, assignee, fetched_at FROM items WHERE id = ?").get(itemId);
        if (!item) return fail("item not found");
        const classification = store.db.prepare("SELECT category, urgency, about, confidence, language, is_question FROM classifications WHERE item_id = ?").get(itemId) ?? null;
        const drafts = store.db.prepare("SELECT id, state, length(body) AS chars FROM drafts WHERE item_id = ? ORDER BY id").all(itemId);
        const feedback = store.db.prepare("SELECT id, kind FROM feedback_examples WHERE item_id = ? ORDER BY id").all(itemId);
        const ident = store.db.prepare("SELECT source, external_id FROM items WHERE id = ?").get(itemId) as { source: string; external_id: string };
        const ledger = store.db.prepare("SELECT key, state, url FROM ledger WHERE key LIKE ? OR key = ?").all(`post:%:${ident.source}:${ident.external_id}`, `thread:${ident.source}:${ident.external_id}`);
        return ok({ publicId: `AHA-${itemId}`, item, classification, drafts, feedback, ledger });
      } finally {
        store.close();
      }
    },
  }));

  api.registerTool(ctx => ({
    name: "aha_pause",
    label: "Pause AHA sending",
    description: "Owner only. Blocks group sends and auto-replies immediately. Survives restart.",
    parameters: { type: "object", additionalProperties: false, properties: {} },
    async execute() {
      const denied = requireOwner(ctx);
      if (denied) return denied;
      const store = openStore();
      try {
        store.db.prepare("UPDATE flags SET paused = 1 WHERE id = 1").run();
        const drafts = (store.db.prepare("SELECT COUNT(*) AS n FROM drafts WHERE state = 'pending'").get() as { n: number }).n;
        const items = (store.db.prepare("SELECT COUNT(*) AS n FROM items WHERE state IN ('new', 'relevant', 'assigned')").get() as { n: number }).n;
        return ok({ paused: true, queued: { drafts, items } });
      } finally {
        store.close();
      }
    },
  }));

  api.registerTool(ctx => ({
    name: "aha_resume",
    label: "Resume AHA sending",
    description: "Owner only. Clears PAUSE.",
    parameters: { type: "object", additionalProperties: false, properties: {} },
    async execute() {
      const denied = requireOwner(ctx);
      if (denied) return denied;
      const store = openStore();
      try {
        store.db.prepare("UPDATE flags SET paused = 0 WHERE id = 1").run();
        return ok({ paused: false });
      } finally {
        store.close();
      }
    },
  }));
}
