import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { test } from "node:test";
import { renderConfig, type Identity } from "../boot/config.ts";

const identity: Identity = {
  agent: { name: "Juniper" },
  line: { uid: "ln_phone" },
  chats: [{ uid: "cht_home", status: "active", participants: [
    { type: "agent", relationship: "self", line: { uid: "ln_phone" } },
    { type: "member", role: "owner", uid: "mem_owner" },
  ] }],
};

test("only the owner's phone DM becomes main; other peers and groups stay isolated", () => {
  const config = renderConfig(identity, "http://api:8000");
  assert.ok(!("ownerChatUid" in config.channels.plow));
  assert.ok(!("ownerMemberUid" in config.channels.plow));
  assert.deepEqual(config.commands.ownerAllowFrom, ["plow-owner"]);
  assert.equal(config.session.dmScope, "per-account-channel-peer");
  assert.equal(config.session.groupScope, "per-group");
  assert.deepEqual(config.bindings[0], {
    agentId: "main", match: { channel: "plow", accountId: "chat", peer: { kind: "direct", id: "plow-owner" } },
    session: { dmScope: "main" },
  });
});

test("mailbox and group chats cannot displace the owner's DM", () => {
  const config = renderConfig({ ...identity, chats: [...identity.chats,
    { uid: "cht_email", status: "active", participants: [
      { type: "agent", relationship: "self", line: { uid: "ln_mail", provider_type: "email" } },
      { type: "member", role: "owner", uid: "mem_owner" },
    ] },
    { ...identity.chats[0], uid: "cht_group", participants: [...identity.chats[0].participants,
      { type: "member", role: "member", uid: "mem_guest" },
    ] },
  ] }, "http://api:8000");
  assert.ok(!("ownerChatUid" in config.channels.plow));
  assert.equal(config.channels.plow.emailLineUid, "ln_mail");
});

test("boot accepts no owner chat or ambiguous owner chats without waiting", () => {
  for (const chats of [[], [...identity.chats, ...identity.chats]]) {
    assert.deepEqual(renderConfig({ ...identity, chats }, "http://api:8000").commands.ownerAllowFrom, ["plow-owner"]);
  }
});

test("provider and optional MCP use environment references, never credential values", () => {
  const config = renderConfig({ ...identity, mcp_url: "http://api:8000/relay" }, "http://api:8000");
  assert.equal(config.models.providers.plow.apiKey, "${PLOW_AGENT_TOKEN}");
  assert.equal(config.models.providers.plow.baseUrl, "http://api:8000/v1");
  assert.equal(config.gateway.auth.token, "${OPENCLAW_GATEWAY_TOKEN}");
  assert.equal(config.mcp?.servers.plow.url, "http://127.0.0.1:18790/mcp");
  assert.equal(renderConfig(identity, "http://api:8000").mcp, undefined);
});

test("Kimi falls back to GLM, then Sonnet, on the Plow provider with explicit capacity and pricing", () => {
  const config = renderConfig(identity, "http://api:8000");
  assert.deepEqual(config.agents.defaults.model, {
    primary: "plow/moonshotai/kimi-k2.5", fallbacks: ["plow/z-ai/glm-5.2", "plow/anthropic/claude-sonnet-5"],
  });
  assert.deepEqual(config.models.providers.plow.models, [{
    id: "moonshotai/kimi-k2.5", name: "Kimi K2.5", input: ["text"], contextWindow: 262144,
    cost: { input: 0.57, output: 2.85 },
  }, {
    id: "z-ai/glm-5.2", name: "GLM 5.2", input: ["text"], contextWindow: 1048576,
    cost: { input: 0.5544, output: 1.7424 },
  }, {
    id: "anthropic/claude-sonnet-5", name: "Claude Sonnet 5", input: ["text", "image"], contextWindow: 1000000,
    cost: { input: 2.00, output: 10.00 },
  }]);
});

test("the configured Plow provider permits an operator-controlled private endpoint", () => {
  const config = renderConfig(identity, "http://host.docker.internal:8080");
  assert.equal(config.models.providers.plow.request.allowPrivateNetwork, true);
});

test("MCP sessions share the loopback bridge and expire after five idle minutes", () => {
  const config = renderConfig({ ...identity, mcp_url: "https://relay.internal/mcp" }, "http://api:8000");
  assert.deepEqual(config.mcp, { sessionIdleTtlMs: 300_000, servers: { plow: {
    url: "http://127.0.0.1:18790/mcp", transport: "streamable-http",
    headers: { Authorization: "Bearer ${PLOW_MCP_BRIDGE_TOKEN}" },
    requestTimeoutMs: 60_000,
  } } });
});

test("phone turns cannot block on ask_user", () => {
  assert.deepEqual(renderConfig(identity, "http://api:8000").tools.deny, ["ask_user"]);
});

test("native messaging retains local workspace and memory file tools for the owner only", () => {
  assert.deepEqual(renderConfig(identity, "http://api:8000").tools, {
    profile: "messaging", fs: { workspaceOnly: true }, sessions: { visibility: "tree" },
    alsoAllow: ["read", "write", "edit", "exec", "plow_start_thread"], deny: ["ask_user"],
    toolsBySender: { "id:plow-owner": {}, "*": { deny: ["plow__*", "exec", "write", "edit"] } },
  });
});

test("Latch is never mounted without the non-owner lock", () => {
  const config = renderConfig({ ...identity, mcp_url: "https://relay.internal/mcp" }, "http://api:8000");
  assert.ok(config.mcp?.servers.plow);
  for (const name of ["plow__*", "exec", "write", "edit"]) assert.ok(config.tools.toolsBySender["*"].deny.includes(name), name);
});

test("read cannot leave the workspace, so secrets.json stays out of reach", () => {
  assert.equal(renderConfig(identity, "http://api:8000").tools.fs.workspaceOnly, true);
});

// OpenClaw's own resolver and matcher, found by name so a version bump that
// renames the hashed chunks still runs them (or fails here, loudly).
const dist = new URL("../node_modules/openclaw/dist/", import.meta.url);
const chunk = async (prefix: string) => {
  const name = readdirSync(dist).find(file => file.startsWith(`${prefix}-`) && file.endsWith(".mjs"));
  assert.ok(name, `openclaw dist has no ${prefix} chunk`);
  return import(new URL(name, dist).href);
};

test("OpenClaw gives Latch and exec to the owner and to nobody else", async () => {
  const { t: resolveSenderToolPolicy } = await chunk("sender-tool-policy");
  const { o: isToolAllowedByPolicyName } = await chunk("tool-policy-match");
  const config = renderConfig({ ...identity, mcp_url: "https://relay.internal/mcp" }, "http://api:8000");
  const allowed = (senderId: string, tool: string) => isToolAllowedByPolicyName(tool, resolveSenderToolPolicy({ config, messageProvider: "plow", senderId }));
  for (const tool of ["plow__plow_run_command", "exec", "write", "edit", "read"]) assert.equal(allowed("plow-owner", tool), true, `owner ${tool}`);
  for (const tool of ["plow__plow_run_command", "exec", "write", "edit"]) assert.equal(allowed("mem_guest", tool), false, `guest ${tool}`);
  assert.equal(allowed("mem_guest", "read"), true);
  assert.equal(allowed("mem_guest", "plow_start_thread"), true);
});

test("private transcript recall is disabled across isolated conversations", () => {
  assert.equal(renderConfig(identity, "http://api:8000").memory.search.rememberAcrossConversations, false);
});


test("the API agent name configures the assistant identity", () => {
  const config = renderConfig(identity, "http://api:8000");
  assert.deepEqual(config.agents.entries, { main: { identity: { name: "Juniper" } } });
});

for (const name of [undefined, null, "", "  "]) test(`missing agent name is not invented: ${JSON.stringify(name)}`, () => {
  assert.throws(() => renderConfig({ ...identity, agent: { name } }, "http://api:8000"), /no usable agent.name/);
});

test("the base image uses boot-owned config without the OpenClaw browser UI", () => {
  const config = renderConfig(identity, "http://api:8000");
  assert.equal(config.gateway.controlUi?.enabled, false);
  assert.equal(config.agents.defaults.skipBootstrap, true);
  assert.deepEqual(config.meta, {});
});
