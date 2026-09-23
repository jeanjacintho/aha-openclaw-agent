import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { exportOpenClawSessions } from "../aha/usage/openclaw-export.ts";

function event(id: string, type = "message") {
  return JSON.stringify({ type, id, timestamp: "2026-09-22T12:00:00.000Z", message: type === "message" ? { role: "assistant" } : undefined });
}

async function fixture(t: import("node:test").TestContext, rows: { session_id: string; seq: number; event_json: string }[]) {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), "aha-oc-"));
  t.after(() => fs.rm(state, { recursive: true, force: true }));
  const dbPath = path.join(state, "agents", "main", "agent", "openclaw-agent.sqlite");
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE transcript_events (
    session_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    event_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (session_id, seq)
  )`);
  const insert = db.prepare("INSERT INTO transcript_events (session_id, seq, event_json, created_at) VALUES (?, ?, ?, 1)");
  for (const row of rows) insert.run(row.session_id, row.seq, row.event_json);
  db.close();
  const out = path.join(state, "out");
  return { state, out, dbPath, file: path.join(out, "main", "sessions", "sess-1.jsonl") };
}

const session = "sess-1";

test("exports one session in seq order, and a second pass adds nothing", async t => {
  const rows = [
    { session_id: session, seq: 0, event_json: event("sess-1", "session") },
    { session_id: session, seq: 1, event_json: event("m1") },
    { session_id: session, seq: 2, event_json: event("m2") },
  ];
  const fx = await fixture(t, rows);
  const first = exportOpenClawSessions(fx.state, fx.out);
  assert.deepEqual(first, { sessions: 1, added: 3, errors: [] });
  const lines = (await fs.readFile(fx.file, "utf8")).trim().split("\n").map(line => JSON.parse(line).id);
  assert.deepEqual(lines, ["sess-1", "m1", "m2"]);
  assert.deepEqual(exportOpenClawSessions(fx.state, fx.out), { sessions: 1, added: 0, errors: [] });
  assert.equal((await fs.readFile(fx.file, "utf8")).trim().split("\n").length, 3);
});

test("a removed sqlite event stays, and a new one is appended", async t => {
  const fx = await fixture(t, [
    { session_id: session, seq: 0, event_json: event("sess-1", "session") },
    { session_id: session, seq: 1, event_json: event("m1") },
    { session_id: session, seq: 2, event_json: event("m2") },
  ]);
  exportOpenClawSessions(fx.state, fx.out);
  const db = new DatabaseSync(fx.dbPath);
  db.prepare("DELETE FROM transcript_events WHERE seq = 2").run();
  db.prepare("INSERT INTO transcript_events (session_id, seq, event_json, created_at) VALUES (?, 3, ?, 1)").run(session, event("m3"));
  db.close();
  const again = exportOpenClawSessions(fx.state, fx.out);
  assert.equal(again.added, 1);
  const ids = (await fs.readFile(fx.file, "utf8")).trim().split("\n").map(line => JSON.parse(line).id);
  assert.deepEqual(ids, ["sess-1", "m1", "m2", "m3"]);
});

test("an unsafe session id is refused", async t => {
  const fx = await fixture(t, [
    { session_id: "../evil", seq: 0, event_json: event("x", "session") },
    { session_id: ".hidden", seq: 0, event_json: event("y", "session") },
    { session_id: "a/b", seq: 0, event_json: event("z", "session") },
  ]);
  const result = exportOpenClawSessions(fx.state, fx.out);
  assert.equal(result.sessions, 0);
  assert.equal(result.added, 0);
  assert.equal(result.errors.length, 3);
  const names = await fs.readdir(fx.out);
  assert.deepEqual(names, []);
});

test("a symlink output root becomes a real directory and its target stays", async t => {
  const fx = await fixture(t, [{ session_id: session, seq: 0, event_json: event("sess-1", "session") }]);
  const target = path.join(fx.state, "target");
  await fs.mkdir(target);
  await fs.writeFile(path.join(target, "keep"), "ok");
  await fs.symlink(target, fx.out);
  const result = exportOpenClawSessions(fx.state, fx.out);
  assert.equal(result.errors.length, 0);
  assert.equal((await fs.lstat(fx.out)).isSymbolicLink(), false);
  assert.equal(await fs.readFile(path.join(target, "keep"), "utf8"), "ok");
  assert.equal((await fs.stat(fx.file)).isFile(), true);
});

test("a missing or corrupt database returns an error and does not throw", async t => {
  const empty = await fs.mkdtemp(path.join(os.tmpdir(), "aha-oc-"));
  t.after(() => fs.rm(empty, { recursive: true, force: true }));
  const missing = exportOpenClawSessions(empty, path.join(empty, "out"));
  assert.equal(missing.sessions, 0);
  assert.equal(missing.added, 0);
  assert.equal(missing.errors.length, 1);
  const state = await fs.mkdtemp(path.join(os.tmpdir(), "aha-oc-"));
  t.after(() => fs.rm(state, { recursive: true, force: true }));
  const dbPath = path.join(state, "agents", "main", "agent", "openclaw-agent.sqlite");
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  await fs.writeFile(dbPath, "not a database");
  const corrupt = exportOpenClawSessions(state, path.join(state, "out"));
  assert.equal(corrupt.sessions, 0);
  assert.equal(corrupt.errors.length, 1);
});
