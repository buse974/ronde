-- Canal API : requêtes enregistrées par ronde (les seules permises pendant un passage).
-- mode d'un canal API sur une ronde : requests (requêtes enregistrées) | free (toutes).
ALTER TABLE task_channels ADD COLUMN requests TEXT NOT NULL DEFAULT '[]';
