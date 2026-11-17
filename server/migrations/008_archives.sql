-- Une ronde n'est jamais supprimée : elle part aux archives avec sa conversation.
ALTER TABLE tasks ADD COLUMN archived_at TEXT;
CREATE INDEX tasks_archived ON tasks (archived_at);
