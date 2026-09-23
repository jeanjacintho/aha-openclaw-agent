import assert from "node:assert/strict";
import { test } from "node:test";
import { schedule } from "../aha/scheduler.ts";

test("dailyAt fires once per local day including a spring-forward skip", async () => {
  const fired: string[] = [];
  let now = new Date("2026-03-08T06:30:00.000Z"); // 01:30 EST
  const handle = schedule([{
    name: "digest",
    dailyAt: { hour: 2, tz: "America/New_York" },
    run: async () => { fired.push(now.toISOString()); },
  }], { now: () => now, intervalMs: 60_000 });
  handle.stop();
  await handle.tick(now);
  now = new Date("2026-03-08T07:00:00.000Z"); // 03:00 EDT; 02:00 skipped
  await handle.tick(now);
  now = new Date("2026-03-08T08:00:00.000Z");
  await handle.tick(now);
  assert.deepEqual(fired, ["2026-03-08T07:00:00.000Z"]);
});

test("dailyAt fires once when the hour repeats after a fall-back", async () => {
  const fired: string[] = [];
  let now = new Date("2026-11-01T04:30:00.000Z"); // 00:30 EDT
  const handle = schedule([{
    name: "digest",
    dailyAt: { hour: 1, tz: "America/New_York" },
    run: async () => { fired.push(now.toISOString()); },
  }], { now: () => now, intervalMs: 60_000 });
  handle.stop();
  await handle.tick(now);
  now = new Date("2026-11-01T05:00:00.000Z"); // 01:00 EDT
  await handle.tick(now);
  now = new Date("2026-11-01T06:00:00.000Z"); // 01:00 EST (repeated hour)
  await handle.tick(now);
  assert.deepEqual(fired, ["2026-11-01T05:00:00.000Z"]);
});

test("a failing job is logged and does not stop the next cycle", async () => {
  const runs: string[] = [];
  const errors: string[] = [];
  const original = console.error;
  console.error = (line: string) => { errors.push(String(line)); };
  let now = new Date("2026-09-23T00:00:00.000Z");
  try {
    const handle = schedule([{
      name: "ingest",
      everyMs: 1000,
      run: async () => {
        runs.push(now.toISOString());
        if (runs.length === 1) throw new Error("boom");
      },
    }], { now: () => now, intervalMs: 60_000 });
    handle.stop();
    await handle.tick(now);
    now = new Date("2026-09-23T00:00:01.000Z");
    await handle.tick(now);
    now = new Date("2026-09-23T00:00:02.000Z");
    await handle.tick(now);
  } finally {
    console.error = original;
  }
  assert.deepEqual(runs, ["2026-09-23T00:00:01.000Z", "2026-09-23T00:00:02.000Z"]);
  assert.match(errors[0], /ingest/);
});
