import { mkdirSync } from "node:fs";
import { getConfig } from "./config.ts";
import { classifyNewItems, deliverDigest } from "./digest/deliver.ts";
import { draftAndNotify } from "./responder/drafts.ts";
import { runPromiseChecks } from "./promises/check.ts";
import { ahaHome } from "./home.ts";
import { runIngest } from "./pipeline/ingest.ts";
import { schedule, type ScheduleHandle } from "./scheduler.ts";
import { watchAdapters } from "./sources/watch.ts";
import { openStore } from "./store/db.ts";

export { ahaHome };

async function ingestThenClassify() {
  const store = openStore();
  try {
    await runIngest(store, watchAdapters(getConfig(store)), new Date());
    await classifyNewItems(store);
    await draftAndNotify(store);
    await runPromiseChecks(store, new Date());
  } finally {
    store.close();
  }
}

async function sendDigest() {
  const store = openStore();
  try {
    await deliverDigest(store);
  } finally {
    store.close();
  }
}

function digestHour() {
  const store = openStore();
  try {
    const cfg = getConfig(store);
    const tz = cfg?.tz || "UTC";
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tz });
    } catch {
      console.error(`aha: invalid tz ${tz}; digest uses UTC`);
      return { hour: cfg?.digestHour ?? 9, tz: "UTC" };
    }
    return { hour: cfg?.digestHour ?? 9, tz };
  } finally {
    store.close();
  }
}

// The gateway is what this container is for. A worker that fails to come up
// logs and stands down; it must not park boot the way an identity failure does.
export function startAha(): { stop(): Promise<void> } | undefined {
  try {
    mkdirSync(ahaHome(), { recursive: true });
    const daily = digestHour();
    const handle: ScheduleHandle = schedule([
      { name: "ingest", everyMs: 15 * 60 * 1000, run: ingestThenClassify },
      { name: "digest", dailyAt: daily, run: sendDigest },
    ]);
    void handle.tick();
    console.log("aha: worker up");
    return { async stop() { handle.stop(); } };
  } catch (error) {
    console.error(`aha: worker standing down: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}
