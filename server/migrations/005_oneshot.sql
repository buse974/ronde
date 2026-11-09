-- Passage unique programmé (ISO UTC) ; la tâche se désactive après lancement.
ALTER TABLE tasks ADD COLUMN run_at TEXT;
-- Alerte par mail si la réponse n'est pas « RAS » (rondes). 0 = simple réponse (oneshots).
ALTER TABLE tasks ADD COLUMN notify INTEGER NOT NULL DEFAULT 1;
