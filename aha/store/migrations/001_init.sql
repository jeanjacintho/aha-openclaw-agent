CREATE TABLE meta (
  schema_version INTEGER NOT NULL
);
INSERT INTO meta (schema_version) VALUES (1);

CREATE TABLE config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  json TEXT NOT NULL
);

CREATE TABLE source_runs (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  window TEXT NOT NULL,
  status TEXT NOT NULL,
  detail TEXT
);

CREATE TABLE items (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  external_id TEXT NOT NULL,
  url TEXT,
  author TEXT,
  title TEXT,
  body TEXT,
  lang TEXT,
  published_at TEXT,
  fetched_at TEXT,
  state TEXT NOT NULL DEFAULT 'new',
  UNIQUE (source, external_id)
);

CREATE TABLE classifications (
  item_id INTEGER PRIMARY KEY REFERENCES items (id),
  sentiment REAL,
  category TEXT,
  topic TEXT,
  language TEXT,
  is_question INTEGER,
  urgency TEXT,
  about TEXT,
  confidence REAL
);

CREATE TABLE topics (
  id INTEGER PRIMARY KEY,
  label TEXT NOT NULL UNIQUE
);

CREATE TABLE topic_weekly (
  topic_id INTEGER NOT NULL REFERENCES topics (id),
  iso_week TEXT NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (topic_id, iso_week)
);

CREATE TABLE authors (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  handle TEXT NOT NULL,
  UNIQUE (source, handle)
);

CREATE TABLE drafts (
  id INTEGER PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES items (id),
  body TEXT NOT NULL,
  state TEXT NOT NULL
);

CREATE TABLE ledger (
  key TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  url TEXT
);

CREATE TABLE promises (
  id INTEGER PRIMARY KEY,
  topic TEXT NOT NULL,
  due TEXT NOT NULL,
  owner TEXT NOT NULL,
  status TEXT NOT NULL
);

CREATE TABLE autonomy (
  source TEXT NOT NULL,
  category TEXT NOT NULL,
  level TEXT NOT NULL,
  streak INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (source, category)
);

CREATE TABLE deliveries (
  id INTEGER PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES items (id),
  role TEXT NOT NULL,
  delivered_at TEXT
);

CREATE TABLE feedback_examples (
  id INTEGER PRIMARY KEY,
  item_id INTEGER REFERENCES items (id),
  kind TEXT NOT NULL,
  text TEXT NOT NULL
);

CREATE TABLE people_roles (
  person TEXT NOT NULL,
  role TEXT NOT NULL,
  PRIMARY KEY (person, role)
);

CREATE TABLE flags (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  paused INTEGER NOT NULL DEFAULT 0
);
INSERT INTO flags (id, paused) VALUES (1, 0);
