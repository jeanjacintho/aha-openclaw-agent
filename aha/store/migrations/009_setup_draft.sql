CREATE TABLE setup_draft (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  json TEXT NOT NULL DEFAULT '{}',
  deferred_until TEXT
);
