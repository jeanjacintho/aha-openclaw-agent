import assert from "node:assert/strict";
import childProcess, { type SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { linkSessions, startAgentIndex } from "../boot/agent-index.ts";

/** Answers each client call with the exit code the case is about, and records what it was asked to run. */
function fakeClient(t: import("node:test").TestContext, codes: number[]) {
  const calls: { args: string[]; env: Record<string, string | undefined> }[] = [];
  t.mock.method(childProcess, "spawn", (_command: string, args: string[], options: SpawnOptions) => {
    calls.push({ args: args.slice(1), env: options.env as Record<string, string | undefined> });
    const child = Object.assign(new EventEmitter(), { kill() {} });
    queueMicrotask(() => child.emit("close", codes.shift() ?? 0, null));
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return calls;
}

const environment = { ...process.env };
function env(t: import("node:test").TestContext, values: Record<string, string | undefined>) {
  t.after(() => { for (const key of Object.keys({ ...values, ...process.env })) if (key in environment) process.env[key] = environment[key]; else delete process.env[key]; });
  for (const [key, value] of Object.entries(values)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
}

test("no AGENT_ID reports for nobody, so nothing runs", async t => {
  env(t, { AGENT_ID: undefined });
  const calls = fakeClient(t, []);
  assert.equal(startAgentIndex(), undefined);
  assert.deepEqual(calls, []);
});

test("an unregistered install registers, then reports", async t => {
  env(t, { AGENT_ID: "my-agent", AGENT_NAME: "My Agent", AGENT_BLURB: "What it does", PLOW_API_BASE: "https://api.example", PLOW_AGENT_TOKEN: "token" });
  const calls = fakeClient(t, [3, 0, 0]);
  startAgentIndex()?.close?.();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(calls.map(call => call.args), [
    ["status"],
    ["--register", "--agent", "my-agent", "--name", "My Agent", "--blurb", "What it does"],
    ["--agent", "my-agent"],
  ]);
  // The Plow bearer buys the Index key once; reports go out on the key the client stored.
  assert.equal(calls[1].env.PLOW_AGENT_TOKEN, "token");
  assert.equal(calls[2].env.PLOW_AGENT_TOKEN, undefined);
  // The state volume, not the container's /home/node: a key and ledger that do
  // not survive a recreate re-register as a new install.
  assert.deepEqual(calls.map(call => call.env.HOME), ["/var/lib/plow", "/var/lib/plow", "/var/lib/plow"]);
  // Named, never the client's compiled-in api.plow.co: a cloud agent's token is
  // a placeholder its proxy swaps, and sent past the proxy it is refused.
  assert.deepEqual(calls.map(call => call.env.PLOW_API_BASE), ["https://api.example", "https://api.example", "https://api.example"]);
});

test("a registered install only reports", async t => {
  env(t, { AGENT_ID: "my-agent", AGENT_NAME: undefined, AGENT_BLURB: undefined, PLOW_API_BASE: "https://api.example" });
  const calls = fakeClient(t, [0, 0]);
  startAgentIndex()?.close?.();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(calls.map(call => call.args), [["status"], ["--agent", "my-agent"]]);
});

test("unreadable state stands off rather than registering over it", async t => {
  env(t, { AGENT_ID: "my-agent", PLOW_API_BASE: "https://api.example" });
  t.mock.method(console, "error", () => {});
  const calls = fakeClient(t, [2]);
  startAgentIndex()?.close?.();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(calls.map(call => call.args), [["status"]], "registering mints against a new install id and strands published usage");
});

test("the collector is pointed at OpenClaw's sessions, and stays pointed", async () => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), "plow-state-"));
  linkSessions(state);
  linkSessions(state);   // every boot calls it; the second must not throw
  assert.equal(await fs.readlink(`${state}/.openclaw/agents`), `${state}/agents`,
    "a link to the state root would contain itself, and a collector walking it would not stop");
  await fs.rm(state, { recursive: true, force: true });
});
