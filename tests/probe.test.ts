import assert from "node:assert/strict";
import { test } from "node:test";
import { renderConfig } from "../boot/config.ts";
import { probeIdentity } from "../boot/probe-fixture.ts";

test("the offline probe's actual identity fixture renders with current boot requirements", () => {
  const config = renderConfig(probeIdentity, "http://127.0.0.1:1");
  assert.equal(config.agents.entries.main.identity.name, "Probe");
  assert.deepEqual(config.commands.ownerAllowFrom, ["plow-owner"]);
});
