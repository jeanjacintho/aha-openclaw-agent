import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { dailyTotals, recordUsage, type UsageCall } from "../aha/usage/ledger.ts";

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
