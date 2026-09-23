CREATE TABLE promise_proposals (
  id INTEGER PRIMARY KEY,
  topic TEXT NOT NULL,
  due TEXT NOT NULL,
  owner TEXT NOT NULL,
  proposed_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
