-- Commentaire sur le résultat d'un passage : la conversation porte sur une ronde existante.
ALTER TABLE asks ADD COLUMN task_id INTEGER;
ALTER TABLE asks ADD COLUMN run_id INTEGER;
