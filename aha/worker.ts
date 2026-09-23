import { mkdirSync } from "node:fs";
import { getConfig } from "./config.ts";
import { buildDigest } from "./digest/build.ts";
import { renderDigest } from "./digest/render.ts";
import { ahaHome } from "./home.ts";
import { sendToChat } from "./notify/plow.ts";
import { classifyBatch, type ItemRow } from "./pipeline/classify.ts";
import { runIngest } from "./pipeline/ingest.ts";
import { schedule, type ScheduleHandle } from "./scheduler.ts";
import { agentIndexSource } from "./sources/agent-index.ts";
import { hnSource } from "./sources/hn.ts";
import { openStore } from "./store/db.ts";

export { ahaHome };

async function classifyNew() {
  const store = openStore();
  try {
    const items = store.db.prepare("SELECT * FROM items WHERE state = 'new' ORDER BY id").all() as ItemRow[];
    for (let i = 0; i < items.length; i += 20) await classifyBatch(store, items.slice(i, i + 20));
  } finally {
    store.close();
  }
}

async function ingestThenClassify() {
  const store = openStore();
  try {
    await runIngest(store, [hnSource(), agentIndexSource()], new Date());
  } finally {
    store.close();
  }
  await classifyNew();
}

async function sendDigest() {
  const store = openStore();
  try {
    const cfg = getConfig(store);
    const chat = cfg?.ownerChatUid || process.env.AHA_OWNER_CHAT_UID;
    if (!chat) return;
    const day = new Date().toISOString().slice(0, 10);
    const model = buildDigest(store, "founder", day);
    const text = renderDigest(model, cfg?.language || "pt");
    await sendToChat(chat, text, `digest:${day}:founder`, { store });
  } finally {
    store.close();
  }
}

function digestHour() {
  const store = openStore();
  try {
    const cfg = getConfig(store);
    return { hour: cfg?.digestHour ?? 9, tz: cfg?.tz || "UTC" };
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
    console.log("aha: worker up");
    return { async stop() { handle.stop(); } };
  } catch (error) {
    console.error(`aha: worker standing down: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}
