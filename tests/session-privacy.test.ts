import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { renderConfig } from "../boot/config.ts";

const require = createRequire(new URL("../plugin/package.json", import.meta.url));
const { createAgentToAgentPolicy, createSessionVisibilityRowChecker, resolveSessionToolsVisibility } =
  await import(require.resolve("openclaw/plugin-sdk/session-visibility"));
const config = renderConfig({ agent: { name: "Juniper" }, line: { uid: "line" }, chats: [{
  uid: "owner-chat", status: "active", participants: [
    { type: "agent", relationship: "self", line: { uid: "line" } },
    { type: "member", uid: "owner", role: "owner" },
  ],
}] }, "http://fixture");
const main = "agent:main:main";
const group = "agent:main:plow:group:group";
const peer = "agent:main:plow:chat:direct:peer";

for (const action of ["list", "history"] as const) test(`native ${action} keeps other conversations out of group and peer turns`, () => {
  const guard = (requesterSessionKey: string) => createSessionVisibilityRowChecker({
    action, requesterSessionKey, mainSessionKey: main,
    visibility: resolveSessionToolsVisibility(config), a2aPolicy: createAgentToAgentPolicy(config),
  });
  for (const requester of [group, peer]) {
    assert.equal(guard(requester).check({ key: requester }).allowed, true);
    for (const target of [main, group, peer].filter(key => key !== requester)) {
      assert.equal(guard(requester).check({ key: target }).allowed, false);
    }
  }
  for (const target of [main, group, peer]) assert.equal(guard(main).check({ key: target }).allowed, true);
});
