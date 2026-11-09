-- Claude estime que la demande ponctuelle ferait une bonne ronde.
ALTER TABLE asks ADD COLUMN suggest_ronde INTEGER NOT NULL DEFAULT 0;
