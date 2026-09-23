import assert from "node:assert/strict";
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

test("provider uses environment references, never credential values", () => {
  const config = renderConfig({ ...identity, mcp_url: "http://api:8000/relay" }, "http://api:8000");
  assert.equal(config.models.providers.plow.apiKey, "${PLOW_AGENT_TOKEN}");
  assert.equal(config.models.providers.plow.baseUrl, "http://api:8000/v1");
  assert.equal(config.gateway.auth.token, "${OPENCLAW_GATEWAY_TOKEN}");
  assert.equal(config.mcp, undefined);
});

test("GLM falls back to Sonnet on the Plow provider with explicit capacity and pricing", () => {
  const config = renderConfig(identity, "http://api:8000");
  assert.deepEqual(config.agents.defaults.model, {
    primary: "plow/z-ai/glm-5.2", fallbacks: ["plow/anthropic/claude-sonnet-5"],
  });
  assert.deepEqual(config.models.providers.plow.models, [{
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

test("mcp is omitted even when mcp_url is set", () => {
  const config = renderConfig({ ...identity, mcp_url: "https://relay.internal/mcp" }, "http://api:8000");
  assert.equal("mcp" in config, false);
  assert.equal(config.mcp, undefined);
});

test("phone turns cannot block on ask_user", () => {
  assert.deepEqual(renderConfig(identity, "http://api:8000").tools.deny, ["ask_user", "exec", "write", "edit"]);
});

test("configuration denies exec, write, edit, and does not mount Latch", () => {
  const config = renderConfig({ ...identity, mcp_url: "http://api:8000/relay" }, "http://api:8000");
  const blob = JSON.stringify(config).toLowerCase();
  assert.equal(config.mcp, undefined);
  assert.equal("mcp" in config, false);
  assert.deepEqual(config.skills.load.extraDirs, []);
  assert.equal(blob.includes("latch"), false);
  assert.equal(blob.includes("owners-mac"), false);
  assert.equal(blob.includes("google-workspace"), false);
  assert.equal(config.tools.alsoAllow.includes("exec"), false);
  assert.equal(config.tools.alsoAllow.includes("write"), false);
  assert.equal(config.tools.alsoAllow.includes("edit"), false);
  for (const name of ["exec", "write", "edit"]) assert.equal(config.tools.deny.includes(name), true);
  assert.deepEqual(config.tools, {
    profile: "messaging",
    fs: { workspaceOnly: true },
    sessions: { visibility: "tree" },
    alsoAllow: ["read", "plow_start_thread"],
    deny: ["ask_user", "exec", "write", "edit"],
  });
});

test("filesystem tools cannot read secrets.json outside the workspace", () => {
  const config = renderConfig(identity, "http://api:8000");
  assert.equal(config.tools.fs.workspaceOnly, true);
  assert.equal(config.agents.defaults.workspace, "/var/lib/plow/workspace");
  assert.equal("/var/lib/plow/aha/secrets.json".startsWith(`${config.agents.defaults.workspace}/`), false);
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
