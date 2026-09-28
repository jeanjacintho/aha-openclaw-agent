CREATE TABLE draft_events (
  id INTEGER PRIMARY KEY,
  draft_id INTEGER,
  item_id INTEGER NOT NULL,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  body_sha256 TEXT,
  detail TEXT
);

CREATE INDEX draft_events_item_id_idx ON draft_events (item_id);
