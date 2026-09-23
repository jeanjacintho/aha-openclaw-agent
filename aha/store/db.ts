import { readFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { ahaHome } from "../worker.ts";

export type Store = {
  db: DatabaseSync;
  tx<T>(fn: () => T): T;
  close(): void;
};

const MIGRATIONS = ["001_init.sql"];

function version(db: DatabaseSync) {
  const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get();
  if (!table) return 0;
  const row = db.prepare("SELECT schema_version FROM meta").get() as { schema_version: number } | undefined;
  return row?.schema_version ?? 0;
}

function migrate(db: DatabaseSync) {
  const current = version(db);
  MIGRATIONS.forEach((name, index) => {
    const next = index + 1;
    if (current >= next) return;
    const sql = readFileSync(new URL(`./migrations/${name}`, import.meta.url), "utf8");
    db.exec("BEGIN");
    try {
      db.exec(sql);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  });
}

export function openStore(home = ahaHome()): Store {
  mkdirSync(home, { recursive: true });
  const db = new DatabaseSync(`${home}/aha.db`);
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  return {
    db,
    tx(fn) {
      db.exec("BEGIN");
      try {
        const result = fn();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    close() {
      db.close();
    },
  };
}
