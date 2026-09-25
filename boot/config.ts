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
    gateway: { mode: "local", bind: "loopback", controlUi: { enabled: false }, auth: { mode: "token", token: "${OPENCLAW_GATEWAY_TOKEN}" }, reload: { mode: "off" } },
    models: { providers: { plow: {
      baseUrl: `${apiBase}/v1`, apiKey: "${PLOW_AGENT_TOKEN}", api: "openai-completions", authHeader: true,
      request: { allowPrivateNetwork: true },
      models: [
        { id: "moonshotai/kimi-k2.5", name: "Kimi K2.5", input: ["text"], contextWindow: 262144, cost: { input: 0.57, output: 2.85 } },
        { id: "z-ai/glm-5.2", name: "GLM 5.2", input: ["text"], contextWindow: 1048576, cost: { input: 0.5544, output: 1.7424 } },
        { id: "anthropic/claude-sonnet-5", name: "Claude Sonnet 5", input: ["text", "image"], contextWindow: 1000000, cost: { input: 2.00, output: 10.00 } },
      ],
    } } },
    agents: { entries: { main: { identity: { name } } }, defaults: {
      workspace: "/var/lib/plow/workspace", skipBootstrap: true,
      model: { primary: "plow/moonshotai/kimi-k2.5", fallbacks: ["plow/z-ai/glm-5.2", "plow/anthropic/claude-sonnet-5"] }, sandbox: { mode: "off" },
    } },
    ...(identity.mcp_url ? { mcp: { sessionIdleTtlMs: 300_000, servers: { plow: {
      url: "http://127.0.0.1:18790/mcp", transport: "streamable-http",
      headers: { Authorization: "Bearer ${PLOW_MCP_BRIDGE_TOKEN}" },
      // Without it OpenClaw caps the tool listing at 1500ms, and a relay round
      // trip to the Mac takes 0.9-1.8s. 60s is OpenClaw's own request default.
      requestTimeoutMs: 60_000,
    } } } } : {}),
    plugins: { load: { paths: ["/opt/plow/plugin"] }, entries: { plow: { enabled: true } } },
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
      fs: { workspaceOnly: true },
      sessions: { visibility: "tree" },
      alsoAllow: ["read", "write", "edit", "exec", "plow_start_thread"],
      deny: ["ask_user"],
      toolsBySender: {
        "id:plow-owner": {},
        "*": { deny: ["plow__*", "exec", "write", "edit"] },
      },
    },
  };
}
