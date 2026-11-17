-- Chaque ronde a toujours exactement une conversation avec Claude, supprimée avec elle.
-- SQLite ne sait pas ajouter de contrainte à une colonne existante : on reconstruit la table.
CREATE TABLE asks_new (
  id            INTEGER PRIMARY KEY,
  kind          TEXT NOT NULL,                    -- exec | design | tune (rattachée à une ronde)
  status        TEXT NOT NULL DEFAULT 'running',  -- running | done | failed | question | proposal
  title         TEXT NOT NULL,
  allowed_tools TEXT NOT NULL DEFAULT '[]',
  messages      TEXT NOT NULL DEFAULT '[]',
  result        TEXT,
  is_ras        INTEGER,
  error         TEXT,
  proposal      TEXT,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd      REAL NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  suggest_ronde INTEGER NOT NULL DEFAULT 0,
  task_id       INTEGER UNIQUE REFERENCES tasks(id) ON DELETE CASCADE, -- NULL = demande libre
  run_id        INTEGER REFERENCES runs(id) ON DELETE SET NULL        -- passage commenté
);

-- Plusieurs conversations pour une même ronde : on garde la plus récente rattachée.
INSERT INTO asks_new
SELECT id, kind, status, title, allowed_tools, messages, result, is_ras, error, proposal,
       input_tokens, output_tokens, cost_usd, created_at, updated_at, suggest_ronde,
       CASE WHEN task_id IN (SELECT id FROM tasks)
             AND id = (SELECT a2.id FROM asks a2 WHERE a2.task_id = asks.task_id ORDER BY a2.updated_at DESC, a2.id DESC LIMIT 1)
            THEN task_id END,
       CASE WHEN run_id IN (SELECT id FROM runs) THEN run_id END
  FROM asks;

DROP TABLE asks;
ALTER TABLE asks_new RENAME TO asks;
CREATE INDEX asks_created ON asks (created_at DESC);

-- Rondes sans conversation : une conversation vide.
INSERT INTO asks (kind, status, title, task_id, created_at, updated_at)
SELECT 'tune', 'done', name, id, created_at, created_at FROM tasks
 WHERE id NOT IN (SELECT task_id FROM asks WHERE task_id IS NOT NULL);
