import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import JSON5 from "json5";

export type Participant =
  | { type: "member"; uid: string; role: string }
  | { type: "agent"; relationship: string; line: { uid: string; provider_type?: string } };
export type Identity = {
  agent?: { name?: string | null };
  line: { uid: string };
  chats: { uid: string; status: string; participants: Participant[] }[];
  mcp_url?: string | null;
};

export function renderConfig(identity: Identity, apiBase: string) {
  const name = identity.agent?.name;
  if (typeof name !== "string" || !name.trim()) throw new Error(`Identity has no usable agent.name: ${JSON.stringify(name)}`);
  const email = identity.chats.flatMap(chat => chat.participants).find(p =>
    p.type === "agent" && p.relationship === "self" && p.line.provider_type === "email");
  return {
    meta: {},
    gateway: {
      mode: "local", bind: "loopback", port: 3000, controlUi: { enabled: true, allowedOrigins: ["*"] },
      auth: { mode: "trusted-proxy", trustedProxy: {
        userHeader: "x-plow-user", allowLoopback: true,
        deviceAutoApprove: { enabled: true, scopes: ["operator.admin"] },
      } },
      trustedProxies: ["127.0.0.1"],
      reload: { mode: "off" },
    },
    models: { providers: { plow: {
      baseUrl: `${apiBase}/v1`, apiKey: "${PLOW_AGENT_TOKEN}", api: "openai-completions", authHeader: true,
      request: { allowPrivateNetwork: true },
      models: [
        { id: "openai/gpt-6-luna", name: "GPT-6 Luna", input: ["text", "image"], contextWindow: 1050000, cost: { input: 0.10, output: 0.50 } },
      ],
    } } },
    agents: { entries: { main: { identity: { name } } }, defaults: {
      workspace: "/var/lib/plow/workspace", skipBootstrap: true,
      model: { primary: "plow/openai/gpt-6-luna", fallbacks: [] }, sandbox: { mode: "off" },
    } },
    mcp: { sessionIdleTtlMs: 300_000, ...(identity.mcp_url ? { servers: { plow: {
      url: "http://127.0.0.1:18790/mcp", transport: "streamable-http",
      headers: { Authorization: "Bearer ${PLOW_MCP_BRIDGE_TOKEN}" },
      // Without it OpenClaw caps the tool listing at 1500ms, and a relay round
      // trip to the Mac takes 0.9-1.8s. 60s is OpenClaw's own request default.
      requestTimeoutMs: 60_000,
    } } } : {}) },
    // The channel runs the Launch watch setup gate in a before_prompt_build hook; OpenClaw
    // registers conversation hooks of a non-bundled plugin only with this opt-in.
    plugins: { load: { paths: ["/opt/plow/plugin"] }, entries: { plow: { enabled: true, hooks: { allowConversationAccess: true } } } },
    channels: { plow: {
      apiBase, lineUid: identity.line.uid,
      ...(email?.type === "agent" ? { emailLineUid: email.line.uid } : {}),
    } },
    session: { dmScope: "per-account-channel-peer", groupScope: "per-group" },
    bindings: [{ agentId: "main", match: { channel: "plow", accountId: "chat", peer: { kind: "direct", id: "plow-owner" } }, session: { dmScope: "main" } }],
    commands: { ownerAllowFrom: ["plow-owner"] },
    memory: { search: { rememberAcrossConversations: false } },
    // An empty allowlist means unrestricted in OpenClaw.
    skills: { load: { extraDirs: ["/opt/plow/skills"] }, allowBundled: ["plow-no-bundled-skills"] },
    // Keep workspace and durable memory writes local instead of routing them through the Mac relay.
    // AHA talks in groups with people who are not the owner, and the base hands
    // every sender every tool. Latch (plow__*), exec, write and edit stay with
    // the owner; read never leaves the workspace (secrets.json lives outside it).
    tools: {
      profile: "messaging",
      toolSearch: false,
      fs: { workspaceOnly: true },
      sessions: { visibility: "tree" },
      // The messaging profile hides plugin tools unless they are named here. The
      // aha_* tools check the requester's role in code (owner-only setup,
      // secrets, backfill), so every sender may see them.
      alsoAllow: ["read", "write", "edit", "exec", "plow_start_thread", "aha_*"],
      deny: ["ask_user"],
      toolsBySender: {
        "id:plow-owner": {},
        "*": { deny: ["plow__*", "exec", "write", "edit"] },
      },
    },
  };
}

const ownedPaths = [
  ["gateway", ["gateway"]],
  ["plow-provider", ["models", "providers", "plow"]],
  ["plow-mcp", ["mcp", "servers", "plow"]],
  ["plow-channel", ["channels", "plow"]],
  ["plow-plugin", ["plugins", "entries", "plow"]],
  ["plugin-load", ["plugins", "load"]],
  ["tools", ["tools"]],
  ["commands", ["commands"]],
  ["identity", ["agents", "entries", "main", "identity"]],
  // AHA's model and its skills ship with the image, as they did when every
  // boot rewrote the whole file.
  ["agent-defaults", ["agents", "defaults"]],
  ["skills", ["skills"]],
  ["session", ["session"]],
  ["memory", ["memory"]],
] as const;

type ConfigObject = Record<string, unknown>;

function isObject(value: unknown): value is ConfigObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function getPath(root: ConfigObject, path: readonly string[]): unknown {
  let node: unknown = root;
  for (const key of path) node = isObject(node) ? node[key] : undefined;
  return node;
}

function parentAt(root: ConfigObject, path: readonly string[], create: boolean): ConfigObject | undefined {
  let node = root;
  for (const key of path.slice(0, -1)) {
    let next = node[key];
    if (!isObject(next)) {
      if (!create) return undefined;
      next = {};
      node[key] = next;
    }
    node = next as ConfigObject;
  }
  return node;
}

function isPlowOwnerBinding(value: unknown): boolean {
  if (!isObject(value) || !isObject(value.match)) return false;
  const match = value.match;
  return value.agentId === "main" && match.channel === "plow" && match.accountId === "chat"
    && isObject(match.peer) && match.peer.kind === "direct" && match.peer.id === "plow-owner";
}

export async function syncConfig(
  rendered: ReturnType<typeof renderConfig>, configPath: string, includeDir: string,
): Promise<void> {
  const seed = rendered as unknown as ConfigObject;
  await mkdir(includeDir, { recursive: true });
  let owner: ConfigObject;
  try {
    const parsed: unknown = JSON5.parse(await readFile(configPath, "utf8"));
    if (!isObject(parsed)) throw new Error("openclaw.json must contain an object");
    owner = parsed;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    owner = structuredClone(seed);
  }

  for (const [file, path] of ownedPaths) {
    const value = getPath(seed, path);
    const parent = parentAt(owner, path, value !== undefined);
    if (!parent) continue;
    const key = path.at(-1)!;
    const includePath = join(includeDir, `${file}.json5`);
    if (value === undefined) {
      delete parent[key];
      await rm(includePath, { force: true });
    } else {
      await writeFile(includePath, JSON.stringify(value, null, 2) + "\n");
      parent[key] = { $include: includePath };
    }
  }
  const bindingPath = join(includeDir, "binding.json5");
  await writeFile(bindingPath, JSON.stringify(rendered.bindings[0], null, 2) + "\n");
  const ownerBindings = Array.isArray(owner.bindings) ? owner.bindings.filter(binding =>
    !(isObject(binding) && binding.$include === bindingPath) && !isPlowOwnerBinding(binding)) : [];
  owner.bindings = [{ $include: bindingPath }, ...ownerBindings];
  const temporaryPath = `${configPath}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(owner, null, 2) + "\n", { mode: 0o600 });
  await rename(temporaryPath, configPath);
}
