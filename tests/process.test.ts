import assert from "node:assert/strict";
import childProcess, { type SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { startGateway } from "../boot/process.ts";

test("supervisor does not start the Latch MCP bridge even when mcp_url is set", async t => {
  const previousCode = process.exitCode;
  const listeners = process.listenerCount("SIGTERM");
  const children: (EventEmitter & { kill: (signal: string) => void; signals: string[] })[] = [];
  const spawned: string[] = [];
  t.mock.method(console, "error", () => {});
  t.mock.method(childProcess, "spawn", (_command: string, args: string[], _opts: SpawnOptions) => {
    spawned.push(String(args[0]));
    const child = Object.assign(new EventEmitter(), { signals: [] as string[], kill(signal: string) { this.signals.push(signal); queueMicrotask(() => this.emit("close", null, signal)); } });
    children.push(child);
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => { process.emit("SIGTERM"); t.mock.restoreAll(); syncBuiltinESMExports(); process.exitCode = previousCode; });
  const started = await startGateway(true, "https://relay/mcp");
  assert.equal(children.length, 1);
  assert.equal(started, children[0]);
  assert.equal(spawned.some(arg => arg.includes("mcp-bridge")), false);
  assert.ok(spawned[0].endsWith("openclaw.mjs"));
  process.emit("SIGTERM");
  await setImmediate();
  assert.equal(process.listenerCount("SIGTERM"), listeners);
  assert.equal(process.exitCode, previousCode);
});

for (const ending of ["gateway", "signal"] as const) test(`supervisor handles child exit: ${ending}`, async t => {
  const previousCode = process.exitCode;
  const listeners = process.listenerCount("SIGTERM");
  const children: (EventEmitter & { kill: (signal: string) => void; signals: string[] })[] = [];
  t.mock.method(console, "error", () => {});
  t.mock.method(childProcess, "spawn", () => {
    const child = Object.assign(new EventEmitter(), { signals: [] as string[], kill(signal: string) { this.signals.push(signal); queueMicrotask(() => this.emit("close", null, signal)); } });
    children.push(child);
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => { process.emit("SIGTERM"); t.mock.restoreAll(); syncBuiltinESMExports(); process.exitCode = previousCode; });
  const started = await startGateway(true);
  assert.equal(children.length, 1);
  assert.equal(started, children[0]);
  if (ending === "signal") process.emit("SIGTERM");
  else children[0].emit("close", 0, null);
  await setImmediate();
  if (ending === "signal") assert.ok(children[0].signals.includes("SIGTERM"));
  assert.equal(process.listenerCount("SIGTERM"), listeners);
  assert.equal(process.exitCode, previousCode);
});
