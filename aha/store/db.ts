import { mkdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { ahaHome } from "../home.ts";

export type Store = {
  db: DatabaseSync;
  tx<T>(fn: () => T): T;
  close(): void;
};

const FILES = ["001_init.sql", "002_item_assignee.sql", "003_draft_attempts.sql", "004_promise_proposals.sql", "005_autonomy_suggested.sql", "006_draft_edited.sql", "007_forget_audit.sql", "008_classify_attempts.sql"];
const BUSY_MS = 5000;

function defaultMigrations() {
  return FILES.map(name => readFileSync(new URL(`./migrations/${name}`, import.meta.url), "utf8"));
}

function version(db: DatabaseSync) {
  const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get();
  if (!table) return 0;
  const row = db.prepare("SELECT schema_version FROM meta").get() as { schema_version: number } | undefined;
  return row?.schema_version ?? 0;
}

function setVersion(db: DatabaseSync, next: number) {
  const row = db.prepare("SELECT schema_version FROM meta").get();
  if (!row) db.prepare("INSERT INTO meta (schema_version) VALUES (?)").run(next);
  else db.prepare("UPDATE meta SET schema_version = ?").run(next);
}

function locked(error: unknown) {
  return (error as { errstr?: string }).errstr === "database is locked";
}

function wait(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function execWhenFree(db: DatabaseSync, sql: string) {
  const deadline = Date.now() + BUSY_MS;
  for (;;) {
    try {
      db.exec(sql);
      return;
    } catch (error) {
      if (!locked(error) || Date.now() >= deadline) throw error;
      wait(20);
    }
  }
}

function rollback(db: DatabaseSync) {
  try { db.exec("ROLLBACK"); } catch { /* no open transaction */ }
}

function migrate(db: DatabaseSync, migrations: string[]) {
  execWhenFree(db, "BEGIN IMMEDIATE");
  try {
    let current = version(db);
    migrations.forEach((sql, index) => {
      const next = index + 1;
      if (current >= next) return;
      db.exec(sql);
      setVersion(db, next);
      current = next;
    });
    db.exec("COMMIT");
  } catch (error) {
    rollback(db);
    throw error;
  }
}

export function openStore(home = ahaHome(), migrations = defaultMigrations()): Store {
  mkdirSync(home, { recursive: true });
  const db = new DatabaseSync(`${home}/aha.db`, { timeout: BUSY_MS });
  db.exec("PRAGMA busy_timeout = 5000");
  execWhenFree(db, "PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA secure_delete = ON");
  migrate(db, migrations);
  return {
    db,
    tx(fn) {
      execWhenFree(db, "BEGIN IMMEDIATE");
      try {
        const result = fn();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        rollback(db);
        throw error;
      }
    },
    close() {
      db.close();
    },
  };
}
