import assert from "node:assert/strict";
import childProcess, { type SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { startGateway } from "../boot/process.ts";

for (const ending of ["gateway", "bridge", "signal", "startup-failure", "restart-shutdown"] as const) test(`supervisor handles child exit: ${ending}`, async t => {
  const previousCode = process.exitCode;
  const listeners = process.listenerCount("SIGTERM");
  const children: (EventEmitter & { kill: (signal: string) => void; signals: string[] })[] = [];
  const options: SpawnOptions[] = [];
  t.mock.method(console, "error", () => {});
  t.mock.method(childProcess, "spawn", (_command: string, args: string[], opts: SpawnOptions) => {
    const child = Object.assign(new EventEmitter(), { signals: [] as string[], kill(signal: string) { this.signals.push(signal); queueMicrotask(() => this.emit("close", null, signal)); } });
    children.push(child); options.push(opts);
    if (args[0].endsWith("mcp-bridge.js")) queueMicrotask(() => ending === "startup-failure" && children.length === 1 ? (child.emit("error", new Error("spawn failed")), child.emit("close", -2, null)) : child.emit("message", "ready"));
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => { process.emit("SIGTERM"); t.mock.restoreAll(); syncBuiltinESMExports(); process.exitCode = previousCode; });
  const bridgeToken = process.env.PLOW_MCP_BRIDGE_TOKEN;
  process.env.PLOW_MCP_BRIDGE_TOKEN = "supervisor-fixture-secret";
  t.after(() => {
    if (bridgeToken === undefined) delete process.env.PLOW_MCP_BRIDGE_TOKEN;
    else process.env.PLOW_MCP_BRIDGE_TOKEN = bridgeToken;
  });
  const starting = startGateway(true, "https://relay/mcp");
  assert.equal(children.length, 1, "gateway waits for bridge readiness");
  assert.equal(await starting, children[1]);
  assert.deepEqual(Object.keys(options[0].env!).sort(), ["PLOW_AGENT_TOKEN", "PLOW_MCP_BRIDGE_TOKEN", "PLOW_MCP_URL"]);
  assert.equal(options[0].env!.PLOW_MCP_BRIDGE_TOKEN, "supervisor-fixture-secret");
  if (ending === "bridge" || ending === "startup-failure") {
    if (ending === "bridge") children[0].emit("close", null, "SIGKILL");
    assert.deepEqual(children[1].signals, [], "bridge death must not stop the gateway");
    await new Promise(resolve => setTimeout(resolve, 1100));
    assert.equal(options[2].env!.PLOW_MCP_BRIDGE_TOKEN, "supervisor-fixture-secret");
    assert.equal(children.length, 3, "boot restarts the bridge");
    assert.deepEqual(children[1].signals, [], "gateway survives the restart");
    process.emit("SIGTERM");
    await setImmediate();
    assert.deepEqual(children[2].signals, ["SIGTERM"]);
  } else if (ending === "restart-shutdown") {
    children[0].emit("close", 1, null);
    process.emit("SIGTERM");
    await new Promise(resolve => setTimeout(resolve, 1100));
    assert.equal(children.length, 2, "shutdown cancels a pending bridge restart");
    assert.deepEqual(children[1].signals, ["SIGTERM"]);
  } else {
    if (ending === "signal") process.emit("SIGTERM");
    else children[1].emit("close", 0, null);
    await setImmediate();
    assert.ok(children[ending === "gateway" ? 0 : 1].signals.includes("SIGTERM"));
  }
  assert.equal(process.listenerCount("SIGTERM"), listeners);
  assert.equal(process.exitCode, previousCode);
});
