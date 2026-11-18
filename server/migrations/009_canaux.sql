-- Canaux : là où ronde envoie la réponse d'une ronde (et, plus tard, ce qu'une ronde lit).
CREATE TABLE channels (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE COLLATE NOCASE,
  type        TEXT NOT NULL,                     -- mail | slack | teams | webhook
  direction   TEXT NOT NULL DEFAULT 'out',       -- out (envoi) ; in (lecture) plus tard
  config      TEXT NOT NULL,                     -- JSON chiffré (AES-256-GCM) : adresses, URL, jeton
  preview     TEXT NOT NULL DEFAULT '',          -- version masquée, pour l'affichage
  tested_at   TEXT,
  test_ok     INTEGER,
  test_error  TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- Canaux de sortie d'une ronde : en cas d'alerte (ou d'échec) seulement, ou à chaque passage.
CREATE TABLE task_channels (
  task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  mode       TEXT NOT NULL DEFAULT 'alert',      -- alert | always
  PRIMARY KEY (task_id, channel_id)
);
