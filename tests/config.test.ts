import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import JSON5 from "json5";
import { renderConfig, syncConfig, type Identity } from "../boot/config.ts";

const identity: Identity = {
  agent: { name: "Juniper" },
  line: { uid: "ln_phone" },
  chats: [{ uid: "cht_home", status: "active", participants: [
    { type: "agent", relationship: "self", line: { uid: "ln_phone" } },
    { type: "member", role: "owner", uid: "mem_owner" },
  ] }],
};

async function configFixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "plow-config-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { path: join(dir, "openclaw.json"), includes: join(dir, "includes") };
}

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
  assert.equal(config.gateway.auth.mode, "trusted-proxy");
  assert.equal("password" in config.gateway.auth, false);
  assert.equal(config.mcp?.servers.plow.url, "http://127.0.0.1:18790/mcp");
  assert.deepEqual(renderConfig(identity, "http://api:8000").mcp, { sessionIdleTtlMs: 300_000 });
});

test("GPT-6 Luna is the only model on the Plow provider", () => {
  const config = renderConfig(identity, "http://api:8000");
  assert.deepEqual(config.agents.defaults.model, {
    primary: "plow/openai/gpt-6-luna",
    fallbacks: [],
  });
  assert.deepEqual(config.models.providers.plow.models, [{
    id: "openai/gpt-6-luna", name: "GPT-6 Luna", input: ["text", "image"], contextWindow: 1050000,
    cost: { input: 0.10, output: 0.50 },
  }]);
});

test("the tool allowlist exposes every tool the plugin declares", async () => {
  // The messaging profile hides plugin tools that alsoAllow does not name.
  const config = renderConfig(identity, "http://api:8000");
  const manifest = JSON.parse(await readFile(new URL("../plugin/openclaw.plugin.json", import.meta.url), "utf8"));
  const allowed = (name: string) => config.tools.alsoAllow.some(rule => rule.endsWith("*") ? name.startsWith(rule.slice(0, -1)) : rule === name);
  for (const name of manifest.contracts.tools as string[]) assert.ok(allowed(name), `${name} is not in tools.alsoAllow`);
});

test("the plow plugin may register its setup gate hook", () => {
  const config = renderConfig(identity, "http://api:8000");
  assert.deepEqual(config.plugins.entries.plow, { enabled: true, hooks: { allowConversationAccess: true } });
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
    profile: "messaging", toolSearch: false, fs: { workspaceOnly: true }, sessions: { visibility: "tree" },
    alsoAllow: ["read", "write", "edit", "exec", "plow_start_thread", "aha_*"], deny: ["ask_user"],
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

// OpenClaw's own resolver and matcher, found by chunk prefix and function name
// so a version bump that renames the hashed chunks or reletters their minified
// exports still runs them (or fails here, loudly).
const dist = new URL("../node_modules/openclaw/dist/", import.meta.url);
const exported = async (prefix: string, fn: string) => {
  for (const name of readdirSync(dist).filter(file => file.startsWith(`${prefix}-`) && file.endsWith(".mjs"))) {
    const found = Object.values(await import(new URL(name, dist).href)).find(value => typeof value === "function" && value.name === fn);
    if (found) return found as (...args: any[]) => any;
  }
  assert.fail(`openclaw dist has no ${prefix} chunk exporting ${fn}`);
};

test("OpenClaw gives Latch and exec to the owner and to nobody else", async () => {
  const resolveSenderToolPolicy = await exported("sender-tool-policy", "resolveSenderToolPolicy");
  const isToolAllowedByPolicyName = await exported("tool-policy-match", "isToolAllowedByPolicyName");
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

test("the base image uses boot-owned config with the OpenClaw browser UI", () => {
  const config = renderConfig(identity, "http://api:8000");
  assert.equal(config.gateway.controlUi.enabled, true);
  assert.equal(config.agents.defaults.skipBootstrap, true);
  assert.deepEqual(config.meta, {});
});

test("the dashboard uses the proxy's port and accepts origins checked by the proxy", () => {
  const config = renderConfig(identity, "http://api:8000");
  assert.deepEqual(config.gateway, {
    mode: "local", bind: "loopback", port: 3000,
    controlUi: { enabled: true, allowedOrigins: ["*"] },
    auth: { mode: "trusted-proxy", trustedProxy: {
      userHeader: "x-plow-user", allowLoopback: true,
      deviceAutoApprove: { enabled: true, scopes: ["operator.admin"] },
    } },
    trustedProxies: ["127.0.0.1"],
    reload: { mode: "off" },
  });
});

test("fresh boot seeds owner defaults and external includes for Plow-owned settings", async t => {
  const { path, includes } = await configFixture(t);
  await syncConfig(renderConfig(identity, "http://api:8000"), path, includes);
  const owner = JSON5.parse(await readFile(path, "utf8"));
  assert.deepEqual(owner.meta, {});
  assert.deepEqual(owner.agents.defaults, { $include: join(includes, "agent-defaults.json5") });
  assert.equal(JSON5.parse(await readFile(join(includes, "agent-defaults.json5"), "utf8")).model.primary, "plow/openai/gpt-6-luna");
  assert.deepEqual(owner.skills, { $include: join(includes, "skills.json5") });
  assert.equal(JSON5.parse(await readFile(join(includes, "skills.json5"), "utf8")).load.extraDirs[0], "/opt/plow/skills");
  assert.deepEqual(owner.gateway, { $include: join(includes, "gateway.json5") });
  assert.deepEqual(owner.bindings, [{ $include: join(includes, "binding.json5") }]);
  assert.deepEqual(JSON5.parse(await readFile(join(includes, "gateway.json5"), "utf8")).port, 3000);
});

test("restart migrates a full render and keeps owner edits outside Plow-owned paths", async t => {
  const { path, includes } = await configFixture(t);
  const old = renderConfig(identity, "http://old-api:8000") as Record<string, any>;
  old.channels.telegram = { enabled: true };
  old.models.providers.extra = { baseUrl: "https://example.com" };
  old.plugins.entries.extra = { enabled: true };
  old.agents.defaults.model.primary = "extra/model";
  old.agents.entries.main.identity.emoji = "old";
  old.bindings.unshift({ agentId: "extra", match: { channel: "telegram" } });
  await writeFile(path, `// owner settings\n${JSON.stringify(old)}\n`);
  await syncConfig(renderConfig(identity, "http://new-api:8000"), path, includes);
  const owner = JSON5.parse(await readFile(path, "utf8"));
  assert.deepEqual(owner.channels.telegram, { enabled: true });
  assert.deepEqual(owner.models.providers.extra, { baseUrl: "https://example.com" });
  assert.deepEqual(owner.plugins.entries.extra, { enabled: true });
  // AHA owns its model: an owner edit there does not survive a restart.
  assert.deepEqual(owner.agents.defaults, { $include: join(includes, "agent-defaults.json5") });
  assert.deepEqual(owner.agents.entries.main.identity, { $include: join(includes, "identity.json5") });
  assert.equal(owner.bindings.length, 2);
  assert.deepEqual(owner.bindings[0], { $include: join(includes, "binding.json5") });
  assert.deepEqual(owner.bindings[1], { agentId: "extra", match: { channel: "telegram" } });
  assert.equal(JSON5.parse(await readFile(join(includes, "plow-provider.json5"), "utf8")).baseUrl, "http://new-api:8000/v1");
  owner.gateway.port = 9999;
  owner.channels.plow.enabled = false;
  await writeFile(path, JSON.stringify(owner));
  await syncConfig(renderConfig(identity, "http://newer-api:8000"), path, includes);
  const again = JSON5.parse(await readFile(path, "utf8"));
  assert.deepEqual(again.gateway, { $include: join(includes, "gateway.json5") });
  assert.deepEqual(again.channels.plow, { $include: join(includes, "plow-channel.json5") });
  assert.deepEqual(again.channels.telegram, { enabled: true });
  assert.deepEqual(again.agents.defaults, { $include: join(includes, "agent-defaults.json5") });
});

test("MCP Plow server include disappears without a relay while owner MCP settings remain", async t => {
  const { path, includes } = await configFixture(t);
  await syncConfig(renderConfig({ ...identity, mcp_url: "https://relay.example" }, "http://api:8000"), path, includes);
  const owner = JSON5.parse(await readFile(path, "utf8"));
  owner.mcp.servers.other = { url: "https://other.example" };
  await writeFile(path, JSON.stringify(owner));
  await syncConfig(renderConfig(identity, "http://api:8000"), path, includes);
  const again = JSON5.parse(await readFile(path, "utf8"));
  assert.equal(again.mcp.servers.plow, undefined);
  assert.deepEqual(again.mcp.servers.other, { url: "https://other.example" });
  assert.equal(again.mcp.sessionIdleTtlMs, 300_000);
});
