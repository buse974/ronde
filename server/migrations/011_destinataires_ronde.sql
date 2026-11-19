-- Destinataires propres à une ronde, pour un canal mail ou smtp (vide : ceux du canal).
ALTER TABLE task_channels ADD COLUMN recipients TEXT NOT NULL DEFAULT '[]';
