CREATE TABLE sites (
  id INTEGER PRIMARY KEY,
  url TEXT NOT NULL UNIQUE,
  label TEXT,
  mode TEXT NOT NULL DEFAULT 'mentions',
  active INTEGER NOT NULL DEFAULT 1,
  cursor_json TEXT NOT NULL DEFAULT '{}',
  last_run_at TEXT,
  last_status TEXT,
  last_detail TEXT,
  created_at TEXT NOT NULL
);
