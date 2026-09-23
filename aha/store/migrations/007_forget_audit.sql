CREATE TABLE forget_audit (
  id INTEGER PRIMARY KEY,
  target_hash TEXT NOT NULL,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  deleted INTEGER NOT NULL
);
