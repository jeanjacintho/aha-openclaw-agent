import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startAha } from "../aha/worker.ts";

const environment = { ...process.env };
function env(t: import("node:test").TestContext, values: Record<string, string | undefined>) {
  t.after(() => { for (const key of Object.keys({ ...values, ...process.env })) if (key in environment) process.env[key] = environment[key]; else delete process.env[key]; });
  for (const [key, value] of Object.entries(values)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
}

test("startAha creates AHA_HOME and returns a stop handle", async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "aha-home-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const home = path.join(base, "state");
  env(t, { AHA_HOME: home });
  const logs: string[] = [];
  t.mock.method(console, "log", (line: string) => { logs.push(line); });
  const handle = startAha();
  assert.ok(handle);
  assert.equal(typeof handle.stop, "function");
  assert.equal((await fs.stat(home)).isDirectory(), true);
  assert.deepEqual(logs, ["aha: worker up"]);
  await handle.stop();
});

test("a failure inside the worker does not propagate", async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aha-blocker-"));
  const file = path.join(dir, "not-a-directory");
  await fs.writeFile(file, "x");
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  env(t, { AHA_HOME: path.join(file, "aha") });
  const errors: string[] = [];
  t.mock.method(console, "error", (line: string) => { errors.push(String(line)); });
  assert.equal(startAha(), undefined);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^aha: worker standing down: /);
});
