import assert from "node:assert/strict";
import childProcess, { type SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { keepAgentsviewDaemon, startAgentIndex } from "../boot/agent-index.ts";

/** Answers each client call with the exit code the case is about, and records what it was asked to run. */
function fakeClient(t: import("node:test").TestContext, codes: number[]) {
  const calls: { command: string; args: string[]; env: Record<string, string | undefined> }[] = [];
  t.mock.method(childProcess, "spawn", (command: string, args: string[], options: SpawnOptions) => {
    calls.push({ command, args, env: options.env as Record<string, string | undefined> });
    const child = Object.assign(new EventEmitter(), { kill() {} });
    queueMicrotask(() => child.emit("close", codes.shift() ?? 0, null));
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return calls;
}

function argv(calls: { command: string; args: string[] }[]) {
  return calls.map(call => call.command === "python3" ? call.args.slice(1) : [call.command, ...call.args]);
}

async function stateDir(t: import("node:test").TestContext) {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), "plow-state-"));
  t.after(() => fs.rm(state, { recursive: true, force: true }));
  return state;
}

const environment = { ...process.env };
function env(t: import("node:test").TestContext, values: Record<string, string | undefined>) {
  t.after(() => { for (const key of Object.keys({ ...values, ...process.env })) if (key in environment) process.env[key] = environment[key]; else delete process.env[key]; });
  for (const [key, value] of Object.entries(values)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
}

test("no AGENT_ID reports for nobody, so nothing runs", async t => {
  env(t, { AGENT_ID: undefined });
  const state = await stateDir(t);
  const calls = fakeClient(t, []);
  assert.equal(startAgentIndex(300_000, state), undefined);
  assert.deepEqual(calls, []);
  await assert.rejects(fs.stat(path.join(state, ".openclaw")));
});

test("an unregistered install registers, then reports", async t => {
  env(t, { AGENT_ID: "my-agent", AGENT_NAME: "My Agent", AGENT_BLURB: "What it does", PLOW_API_BASE: "https://api.example", PLOW_AGENT_TOKEN: "token", OPENCLAW_STATE_DIR: "/var/lib/plow" });
  const calls = fakeClient(t, [0, 3, 0, 0]);
  startAgentIndex(300_000, await stateDir(t))?.close?.();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(argv(calls), [
    ["agentsview", "sync"],
    ["status"],
    ["--register", "--agent", "my-agent", "--name", "My Agent", "--blurb", "What it does"],
    ["--agent", "my-agent"],
  ]);
  assert.equal(calls[0].env.PLOW_AGENT_TOKEN, undefined);
  assert.equal(calls[0].env.HOME, "/var/lib/plow");
  // The Plow bearer buys the Index key once; reports go out on the key the client stored.
  assert.equal(calls[2].env.PLOW_AGENT_TOKEN, "token");
  assert.equal(calls[3].env.PLOW_AGENT_TOKEN, undefined);
  // The state volume, not the container's /home/node: a key and ledger that do
  // not survive a recreate re-register as a new install.
  assert.deepEqual(calls.map(call => call.env.HOME), ["/var/lib/plow", "/var/lib/plow", "/var/lib/plow", "/var/lib/plow"]);
  // Named, never the client's compiled-in api.plow.co: a cloud agent's token is
  // a placeholder its proxy swaps, and sent past the proxy it is refused.
  assert.deepEqual(calls.slice(1).map(call => call.env.PLOW_API_BASE), ["https://api.example", "https://api.example", "https://api.example"]);
  assert.deepEqual(calls.slice(1).map(call => call.env.OPENCLAW_STATE_DIR), ["/var/lib/plow", "/var/lib/plow", "/var/lib/plow"]);
});

test("a registered install only reports", async t => {
  env(t, { AGENT_ID: "my-agent", AGENT_NAME: undefined, AGENT_BLURB: undefined, PLOW_API_BASE: "https://api.example" });
  const calls = fakeClient(t, [0, 0, 0]);
  startAgentIndex(300_000, await stateDir(t))?.close?.();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(argv(calls), [["agentsview", "sync"], ["status"], ["--agent", "my-agent"]]);
});

test("unreadable state stands off rather than registering over it", async t => {
  env(t, { AGENT_ID: "my-agent", PLOW_API_BASE: "https://api.example" });
  t.mock.method(console, "error", () => {});
  const calls = fakeClient(t, [0, 2]);
  startAgentIndex(300_000, await stateDir(t))?.close?.();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(argv(calls), [["agentsview", "sync"], ["status"]], "registering mints against a new install id and strands published usage");
});

test("a failed sync still reports", async t => {
  env(t, { AGENT_ID: "my-agent", PLOW_API_BASE: "https://api.example" });
  t.mock.method(console, "error", () => {});
  const calls = fakeClient(t, [1, 0, 0]);
  startAgentIndex(300_000, await stateDir(t))?.close?.();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(argv(calls), [["agentsview", "sync"], ["status"], ["--agent", "my-agent"]]);
});

test("an unreadable OpenClaw store is the client's to report, and the pass still runs", async t => {
  // Boot no longer reads that store: the client does, and it records the read
  // failure itself so a partial report never replaces a complete one.
  env(t, { AGENT_ID: "my-agent", PLOW_API_BASE: "https://api.example" });
  const state = await stateDir(t);
  const db = path.join(state, "agents", "main", "agent", "openclaw-agent.sqlite");
  await fs.mkdir(path.dirname(db), { recursive: true });
  await fs.writeFile(db, "not a database");
  const calls = fakeClient(t, [0, 0, 0]);
  startAgentIndex(300_000, state)?.close?.();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(argv(calls), [["agentsview", "sync"], ["status"], ["--agent", "my-agent"]]);
});

test("agentsview keeps its daemon: the idle timeout is prepended, the daemon's own keys kept", async t => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), "plow-state-"));
  t.after(() => fs.rm(state, { recursive: true, force: true }));
  await fs.mkdir(path.join(state, ".agentsview"));
  const file = path.join(state, ".agentsview", "config.toml");
  await fs.writeFile(file, 'auth_token = "a"\ncursor_secret = "b"\n\n[remote]\nhost = "x"\n');
  keepAgentsviewDaemon(state);
  keepAgentsviewDaemon(state);
  assert.equal(await fs.readFile(file, "utf8"), 'daemon_idle_timeout = "0s"\nauth_token = "a"\ncursor_secret = "b"\n\n[remote]\nhost = "x"\n');
});

test("agentsview idle timeout is written on a fresh state and an owner's own value is left alone", async t => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), "plow-state-"));
  t.after(() => fs.rm(state, { recursive: true, force: true }));
  keepAgentsviewDaemon(state);
  const file = path.join(state, ".agentsview", "config.toml");
  assert.equal(await fs.readFile(file, "utf8"), 'daemon_idle_timeout = "0s"\n');
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  await fs.writeFile(file, 'daemon_idle_timeout = "10m"\n');
  keepAgentsviewDaemon(state);
  assert.equal(await fs.readFile(file, "utf8"), 'daemon_idle_timeout = "10m"\n');
});
