import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getConfig, saveConfig } from "../aha/config.ts";
import { readSecrets, writeSecrets } from "../aha/secrets.ts";
import { openStore } from "../aha/store/db.ts";

const TABLES = ["authors", "autonomy", "classifications", "config", "deliveries", "drafts", "feedback_examples", "flags", "items", "ledger", "meta", "people_roles", "promises", "source_runs", "topic_weekly", "topics"];

async function home(t: import("node:test").TestContext) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aha-store-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

function tables(store: ReturnType<typeof openStore>) {
  return (store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map(row => row.name);
}

test("migration creates every table and a second open does nothing", async t => {
  const dir = await home(t);
  const first = openStore(dir);
  assert.deepEqual(tables(first), TABLES);
  assert.equal((first.db.prepare("SELECT schema_version FROM meta").get() as { schema_version: number }).schema_version, 1);
  first.db.prepare("INSERT INTO items (source, external_id) VALUES (?, ?)").run("hn", "1");
  first.close();
  const second = openStore(dir);
  t.after(() => second.close());
  assert.deepEqual(tables(second), TABLES);
  assert.equal((second.db.prepare("SELECT COUNT(*) AS n FROM items").get() as { n: number }).n, 1);
});

test("a duplicate source and external id is rejected", async t => {
  const store = openStore(await home(t));
  t.after(() => store.close());
  const insert = store.db.prepare("INSERT INTO items (source, external_id) VALUES (?, ?)");
  insert.run("hn", "1");
  assert.throws(() => insert.run("hn", "1"));
  assert.equal((store.db.prepare("SELECT COUNT(*) AS n FROM items").get() as { n: number }).n, 1);
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
