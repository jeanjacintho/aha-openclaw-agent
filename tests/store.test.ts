import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getConfig, saveConfig } from "../aha/config.ts";
import { readSecrets, writeSecrets } from "../aha/secrets.ts";
import { openStore } from "../aha/store/db.ts";

const TABLES = ["authors", "autonomy", "classifications", "config", "deliveries", "draft_events", "drafts", "feedback_examples", "flags", "forget_audit", "items", "ledger", "meta", "people_roles", "promise_proposals", "promises", "setup_draft", "sites", "source_runs", "topic_weekly", "topics"];
const STORE = new URL("../aha/store/db.ts", import.meta.url).href;

async function home(t: import("node:test").TestContext) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aha-store-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

function tables(store: ReturnType<typeof openStore>) {
  return (store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map(row => row.name);
}

function columns(store: ReturnType<typeof openStore>, table: string) {
  return (store.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(row => row.name);
}

function runStore(dir: string, source: string, extra: { timeout?: number } = {}) {
  return spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", source], {
    env: { ...process.env, AHA_HOME: dir },
    encoding: "utf8",
    timeout: extra.timeout,
  });
}

function childSource(body: string) {
  return `import { openStore } from ${JSON.stringify(STORE)};\n${body}`;
}

test("migration creates every table and a second open does nothing", async t => {
  const dir = await home(t);
  const first = openStore(dir);
  assert.deepEqual(tables(first), TABLES);
  assert.deepEqual(columns(first, "source_runs"), ["id", "source", "window_start", "window_end", "status", "detail"]);
  assert.deepEqual(columns(first, "deliveries"), ["key", "chat_uid", "status", "message_uid", "created_at", "updated_at", "body"]);
  assert.equal((first.db.prepare("SELECT schema_version FROM meta").get() as { schema_version: number }).schema_version, 17);
  assert.equal((first.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'forget_audit_target_hash_idx'").get() as { name: string }).name, "forget_audit_target_hash_idx");
  assert.equal(columns(first, "drafts").includes("edited"), true);
  assert.equal(columns(first, "items").includes("assignee"), true);
  assert.equal(columns(first, "items").includes("draft_attempts"), true);
  assert.equal(columns(first, "items").includes("classify_attempts"), true);
  assert.equal(columns(first, "items").includes("classify_transport_attempts"), true);
  assert.equal(columns(first, "items").includes("classify_claimed_until"), true);
  assert.equal(columns(first, "items").includes("origin"), true);
  assert.equal(columns(first, "deliveries").includes("body"), true);
  assert.equal(columns(first, "drafts").includes("approved_sha256"), true);
  assert.equal(columns(first, "drafts").includes("approved_at"), true);
  assert.equal((first.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'drafts_one_active_per_item_idx'").get() as { name: string }).name, "drafts_one_active_per_item_idx");
  assert.deepEqual(columns(first, "draft_events"), ["id", "draft_id", "item_id", "at", "actor", "action", "body_sha256", "detail"]);
  assert.equal((first.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'draft_events_item_id_idx'").get() as { name: string }).name, "draft_events_item_id_idx");
  first.db.prepare("INSERT INTO items (source, external_id) VALUES (?, ?)").run("hn", "1");
  assert.equal((first.db.prepare("SELECT origin FROM items WHERE external_id = '1'").get() as { origin: string }).origin, "live");
  assert.equal((first.db.prepare("SELECT classify_transport_attempts FROM items WHERE external_id = '1'").get() as { classify_transport_attempts: number }).classify_transport_attempts, 0);
  first.close();
  const second = openStore(dir);
  t.after(() => second.close());
  assert.deepEqual(tables(second), TABLES);
  assert.equal((second.db.prepare("SELECT COUNT(*) AS n FROM items").get() as { n: number }).n, 1);
});

test("migration adds origin to an existing database and defaults old rows to live", async t => {
  const dir = await home(t);
  const migrationDir = new URL("../aha/store/migrations/", import.meta.url);
  const previousMigrations = (await fs.readdir(migrationDir)).filter(name => /^\d+_.*\.sql$/.test(name) && name < "011_item_origin.sql").sort();
  const previousSql = await Promise.all(previousMigrations.map(name => fs.readFile(new URL(name, migrationDir), "utf8")));
  const previous = openStore(dir, previousSql);
  previous.db.prepare("INSERT INTO items (source, external_id) VALUES ('hn', 'old-row')").run();
  previous.db.prepare("INSERT INTO drafts (item_id, body, state) SELECT id, 'older draft', 'pending' FROM items WHERE external_id = 'old-row'").run();
  previous.db.prepare("INSERT INTO drafts (item_id, body, state) SELECT id, 'newer draft', 'pending' FROM items WHERE external_id = 'old-row'").run();
  previous.db.prepare(`INSERT INTO deliveries (key, chat_uid, status, created_at, updated_at)
    VALUES ('old-delivery', 'cht_dm', 'sent', '2026-09-22T00:00:00.000Z', '2026-09-22T00:00:00.000Z')`).run();
  previous.close();

  const migrated = openStore(dir);
  t.after(() => migrated.close());
  assert.equal((migrated.db.prepare("SELECT schema_version FROM meta").get() as { schema_version: number }).schema_version, 17);
  assert.equal((migrated.db.prepare("SELECT origin FROM items WHERE external_id = 'old-row'").get() as { origin: string }).origin, "live");
  assert.equal((migrated.db.prepare("SELECT body FROM deliveries WHERE key = 'old-delivery'").get() as { body: string | null }).body, null);
  assert.equal((migrated.db.prepare("SELECT body FROM drafts WHERE item_id = (SELECT id FROM items WHERE external_id = 'old-row') AND state = 'pending'").get() as { body: string }).body, "newer draft");
  assert.equal((migrated.db.prepare("SELECT approved_sha256 FROM drafts WHERE item_id = (SELECT id FROM items WHERE external_id = 'old-row') AND state = 'pending'").get() as { approved_sha256: string | null }).approved_sha256, null);
});

test("a duplicate source and external id is rejected", async t => {
  const store = openStore(await home(t));
  t.after(() => store.close());
  const insert = store.db.prepare("INSERT INTO items (source, external_id) VALUES (?, ?)");
  insert.run("hn", "1");
  assert.throws(() => insert.run("hn", "1"));
  assert.equal((store.db.prepare("SELECT COUNT(*) AS n FROM items").get() as { n: number }).n, 1);
});

test("a duplicate delivery key is rejected", async t => {
  const store = openStore(await home(t));
  t.after(() => store.close());
  const insert = store.db.prepare("INSERT INTO deliveries (key, chat_uid, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)");
  insert.run("k1", "chat", "sent", "2026-09-22T00:00:00.000Z", "2026-09-22T00:00:00.000Z");
  assert.throws(() => insert.run("k1", "other", "failed", "2026-09-22T00:00:00.000Z", "2026-09-22T00:00:00.000Z"));
  assert.equal((store.db.prepare("SELECT COUNT(*) AS n FROM deliveries").get() as { n: number }).n, 1);
});

test("saveConfig rejects a config without company.name", async t => {
  const store = openStore(await home(t));
  t.after(() => store.close());
  for (const config of [{}, { company: {} }, { company: { name: "  " } }]) {
    assert.throws(() => saveConfig(store, config as { company: { name: string } }), /company\.name/);
  }
  saveConfig(store, { company: { name: "Plow" } });
  assert.deepEqual(getConfig(store), { company: { name: "Plow" } });
});

test("saveConfig rejects an invalid IANA timezone", async t => {
  const store = openStore(await home(t));
  t.after(() => store.close());
  assert.throws(() => saveConfig(store, { company: { name: "Plow" }, tz: "Not/AZone" }), /valid IANA timezone/);
  saveConfig(store, { company: { name: "Plow" }, tz: "America/Sao_Paulo" });
  assert.equal(getConfig(store)?.tz, "America/Sao_Paulo");
});

test("secrets.json is created with mode 0600", async t => {
  const dir = await home(t);
  writeSecrets(dir, { github: "token" });
  assert.equal((await fs.stat(path.join(dir, "secrets.json"))).mode & 0o777, 0o600);
  assert.deepEqual(readSecrets(dir), { github: "token" });
});

test("tx rolls back when the function throws", async t => {
  const store = openStore(await home(t));
  t.after(() => store.close());
  assert.throws(() => store.tx(() => {
    store.db.prepare("INSERT INTO items (source, external_id) VALUES (?, ?)").run("hn", "1");
    throw new Error("nope");
  }));
  assert.equal((store.db.prepare("SELECT COUNT(*) AS n FROM items").get() as { n: number }).n, 0);
});

test("two processes can open a new database at the same time", async t => {
  const open = childSource(`
    const store = openStore(process.env.AHA_HOME);
    store.close();
  `);
  for (let round = 0; round < 5; round++) {
    const dir = await home(t);
    const results = await Promise.all([0, 1].map(() => new Promise<{ status: number | null; stderr: string }>(resolve => {
      const child = runStore(dir, open);
      let stderr = "";
      child.stderr?.on("data", chunk => { stderr += chunk; });
      child.on("close", status => resolve({ status, stderr }));
    })));
    for (const result of results) assert.equal(result.status, 0, result.stderr);
    const store = openStore(dir);
    t.after(() => store.close());
    assert.equal((store.db.prepare("SELECT schema_version FROM meta").get() as { schema_version: number }).schema_version, 17);
    assert.deepEqual(tables(store), TABLES);
  }
});

test("a writer waits while another process holds BEGIN IMMEDIATE", async t => {
  const dir = await home(t);
  openStore(dir).close();
  const holder = runStore(dir, childSource(`
    const store = openStore(process.env.AHA_HOME);
    store.db.exec("BEGIN IMMEDIATE");
    process.stdout.write("ready\\n");
    await new Promise(resolve => setTimeout(resolve, 1000));
    store.db.exec("COMMIT");
    store.close();
  `), { timeout: 10_000 });
  t.after(() => holder.kill());
  await new Promise<void>((resolve, reject) => {
    const onClose = (code: number | null) => reject(new Error(`holder exited ${code}`));
    holder.on("close", onClose);
    holder.stdout?.on("data", chunk => {
      if (!String(chunk).includes("ready")) return;
      holder.off("close", onClose);
      resolve();
    });
  });
  const started = Date.now();
  const writer = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", childSource(`
    const store = openStore(process.env.AHA_HOME);
    store.tx(() => store.db.prepare("INSERT INTO items (source, external_id) VALUES (?, ?)").run("hn", "1"));
    store.close();
  `)], { env: { ...process.env, AHA_HOME: dir }, encoding: "utf8", timeout: 10_000 });
  assert.equal(writer.status, 0, writer.stderr);
  assert.ok(Date.now() - started >= 800);
  const closed = await new Promise<number | null>(resolve => holder.on("close", resolve));
  assert.equal(closed, 0);
  const store = openStore(dir);
  t.after(() => store.close());
  assert.equal((store.db.prepare("SELECT COUNT(*) AS n FROM items").get() as { n: number }).n, 1);
});

test("openStore records the schema version even when the SQL does not", async t => {
  const dir = await home(t);
  const sql = "CREATE TABLE meta (schema_version INTEGER NOT NULL); CREATE TABLE scratch (id INTEGER PRIMARY KEY);";
  const first = openStore(dir, [sql]);
  assert.equal((first.db.prepare("SELECT schema_version FROM meta").get() as { schema_version: number }).schema_version, 1);
  assert.ok(tables(first).includes("scratch"));
  first.close();
  const second = openStore(dir, [sql]);
  t.after(() => second.close());
  assert.equal((second.db.prepare("SELECT schema_version FROM meta").get() as { schema_version: number }).schema_version, 1);
  assert.equal((second.db.prepare("SELECT COUNT(*) AS n FROM scratch").get() as { n: number }).n, 0);
});
