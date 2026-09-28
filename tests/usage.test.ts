import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { exportLedger } from "../aha/usage/ledger-export.ts";
import { dailyTotals, listUsage, recordUsage, type UsageCall } from "../aha/usage/ledger.ts";
import { classifyAllowed, warnBudgetIfNeeded } from "../aha/usage/budget.ts";
import { openStore } from "../aha/store/db.ts";

const environment = { ...process.env };
function env(t: import("node:test").TestContext, values: Record<string, string | undefined>) {
  t.after(() => { for (const key of Object.keys({ ...values, ...process.env })) if (key in environment) process.env[key] = environment[key]; else delete process.env[key]; });
  for (const [key, value] of Object.entries(values)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
}

function call(over: Partial<UsageCall> = {}): UsageCall {
  return { at: new Date("2026-09-22T10:00:00.000Z"), model: "z-ai/glm-5.2", input: 1, output: 1, purpose: "classify", ...over };
}

test("three calls on two days sum, and a new process reads the same file", async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "aha-usage-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  env(t, { AHA_HOME: home });
  recordUsage(call({ input: 10, output: 1 }));
  recordUsage(call({ at: new Date("2026-09-22T18:00:00.000Z"), input: 5, output: 2 }));
  recordUsage(call({ at: new Date("2026-09-23T08:00:00.000Z"), model: "anthropic/claude-sonnet-5", input: 7, output: 4, purpose: "draft" }));
  const firstDay = [{ model: "z-ai/glm-5.2", input: 15, output: 3 }];
  const secondDay = [{ model: "anthropic/claude-sonnet-5", input: 7, output: 4 }];
  assert.deepEqual(dailyTotals("2026-09-22"), firstDay);
  assert.deepEqual(dailyTotals("2026-09-23"), secondDay);
  assert.equal((await fs.readFile(path.join(home, "usage.jsonl"), "utf8")).trim().split("\n").length, 3);
  const ids = listUsage().map(row => row.id);
  assert.equal(new Set(ids).size, 3);
  for (const id of ids) assert.match(id, /^[0-9a-f-]{36}$/);
  const out = await fs.mkdtemp(path.join(os.tmpdir(), "aha-ledger-out-"));
  t.after(() => fs.rm(out, { recursive: true, force: true }));
  assert.equal(exportLedger(out).added, 3);
  assert.equal(exportLedger(out).added, 0);
  const exported = (await fs.readFile(path.join(out, "aha-worker", "sessions", "a7a00000-0000-4000-8000-000000000001.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.equal(exported[0].type, "session");
  assert.deepEqual(exported.slice(1).map(line => line.id), ids);
  assert.equal(exported[1].message.provider, "plow");
  assert.deepEqual(exported[1].message.usage, { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 11 });
  const ledger = new URL("../aha/usage/ledger.ts", import.meta.url);
  const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `import { dailyTotals } from ${JSON.stringify(ledger.href)}; process.stdout.write(JSON.stringify({ a: dailyTotals("2026-09-22"), b: dailyTotals("2026-09-23") }));`], {
    env: { ...process.env, AHA_HOME: home }, encoding: "utf8",
  });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { a: firstDay, b: secondDay });
});

test("negative and NaN usage is rejected and not stored", async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "aha-usage-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  env(t, { AHA_HOME: home });
  for (const input of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => recordUsage(call({ input })), /usage input must be a finite number >= 0/);
  }
  assert.throws(() => recordUsage(call({ output: -1 })), /usage output must be a finite number >= 0/);
  await assert.rejects(fs.stat(path.join(home, "usage.jsonl")));
});

test("malformed ledger lines are logged and skipped without breaking budget reads", async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "aha-usage-corrupt-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  env(t, { AHA_HOME: home });
  const validBefore = { id: "before", at: "2026-09-22T10:00:00.000Z", model: "test", input: 2, output: 3, purpose: "classify" };
  const validAfter = { id: "after", at: "2026-09-22T11:00:00.000Z", model: "test", input: 4, output: 5, purpose: "draft" };
  await fs.writeFile(path.join(home, "usage.jsonl"), `${JSON.stringify(validBefore)}\n{broken json\nnull\n${JSON.stringify(validAfter)}\n`);
  const errors: string[] = [];
  t.mock.method(console, "error", (line: string) => { errors.push(line); });

  assert.deepEqual(listUsage(), [validBefore, validAfter]);
  const store = openStore(home);
  t.after(() => store.close());
  assert.doesNotThrow(() => classifyAllowed(store, new Date("2026-09-22T12:00:00.000Z")));
  await assert.doesNotReject(warnBudgetIfNeeded(store, { now: () => new Date("2026-09-22T12:00:00.000Z") }));
  assert.equal(errors.length, 6);
  assert.ok(errors.every(line => /skipping malformed usage ledger line/.test(line)));
});

test("calls made through the gateway count toward the budget but are not exported twice", async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "aha-usage-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  env(t, { AHA_HOME: home });
  recordUsage(call({ model: "openai/gpt-6-luna", input: 3, output: 1 }));
  recordUsage(call({ model: "openclaw/aha-llm", input: 5, output: 2 }));
  assert.deepEqual(dailyTotals("2026-09-22").map(row => row.model), ["openai/gpt-6-luna", "openclaw/aha-llm"]);
  const out = await fs.mkdtemp(path.join(os.tmpdir(), "aha-ledger-out-"));
  t.after(() => fs.rm(out, { recursive: true, force: true }));
  // The gateway's own session already carries that call to the reporter.
  assert.equal(exportLedger(out).added, 1);
});
