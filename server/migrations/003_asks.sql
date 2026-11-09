-- Demandes faites depuis l'interface : exécution ponctuelle ou conception guidée d'une ronde.
CREATE TABLE asks (
  id            INTEGER PRIMARY KEY,
  kind          TEXT NOT NULL,                    -- exec | design
  status        TEXT NOT NULL DEFAULT 'running',  -- running | done | failed | question | proposal
  title         TEXT NOT NULL,                    -- première demande, pour l'historique
  allowed_tools TEXT NOT NULL DEFAULT '[]',
  messages      TEXT NOT NULL DEFAULT '[]',       -- design : [{ role: 'user'|'claude', text, proposal? }]
  result        TEXT,
  is_ras        INTEGER,
  error         TEXT,
  proposal      TEXT,                             -- design : dernière proposition (JSON)
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd      REAL NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX asks_created ON asks (created_at DESC);
