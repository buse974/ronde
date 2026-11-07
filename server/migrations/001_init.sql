CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE sessions (
  id_hash    TEXT PRIMARY KEY,
  username   TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE tasks (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  prompt        TEXT NOT NULL,
  cron          TEXT NOT NULL,
  allowed_tools TEXT NOT NULL DEFAULT '[]', -- tableau JSON
  max_turns     INTEGER NOT NULL DEFAULT 5,
  timeout_sec   INTEGER NOT NULL DEFAULT 600,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE runs (
  id                    INTEGER PRIMARY KEY,
  task_id               INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  trigger               TEXT NOT NULL,                     -- schedule | manual
  status                TEXT NOT NULL DEFAULT 'running',   -- running | ok | alert | failed
  started_at            TEXT NOT NULL,
  finished_at           TEXT,
  duration_ms           INTEGER,
  exit_code             INTEGER,
  is_error              INTEGER,
  timed_out             INTEGER NOT NULL DEFAULT 0,
  result                TEXT,
  error                 TEXT,
  stderr                TEXT,
  input_tokens          INTEGER,
  output_tokens         INTEGER,
  cache_read_tokens     INTEGER,
  cache_creation_tokens INTEGER,
  cost_usd              REAL,
  num_turns             INTEGER,
  session_id            TEXT,
  token_type            TEXT,
  raw_json              TEXT,
  alert_sent            INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX runs_task_started ON runs (task_id, started_at DESC);
CREATE INDEX runs_status ON runs (status);
-- Garantit au plus un run en cours par tâche (anti-chevauchement).
CREATE UNIQUE INDEX runs_one_running_per_task ON runs (task_id) WHERE status = 'running';
