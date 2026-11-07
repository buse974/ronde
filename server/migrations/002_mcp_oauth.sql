-- Origine de la tâche : ui | mcp | template
ALTER TABLE tasks ADD COLUMN created_via TEXT NOT NULL DEFAULT 'ui';

-- Clients OAuth enregistrés dynamiquement (RFC 7591), ex. Claude Code.
CREATE TABLE oauth_clients (
  client_id  TEXT PRIMARY KEY,
  info       TEXT NOT NULL, -- OAuthClientInformationFull (JSON)
  created_at TEXT NOT NULL
);

-- Une autorisation accordée par l'admin à un client (révocable dans Réglages).
CREATE TABLE oauth_grants (
  id           TEXT PRIMARY KEY,
  client_id    TEXT NOT NULL,
  client_name  TEXT,
  username     TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  last_used_at TEXT
);

-- Codes d'autorisation (usage unique, 5 min).
CREATE TABLE oauth_codes (
  code_hash      TEXT PRIMARY KEY,
  grant_id       TEXT NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
  client_id      TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  redirect_uri   TEXT NOT NULL,
  resource       TEXT,
  scopes         TEXT NOT NULL,
  expires_at     INTEGER NOT NULL
);

-- Jetons d'accès (1 h) et de renouvellement (30 j), stockés hachés.
CREATE TABLE oauth_tokens (
  token_hash TEXT PRIMARY KEY,
  kind       TEXT NOT NULL, -- access | refresh
  grant_id   TEXT NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
  client_id  TEXT NOT NULL,
  scopes     TEXT NOT NULL,
  resource   TEXT,
  expires_at INTEGER NOT NULL
);
CREATE INDEX oauth_tokens_grant ON oauth_tokens (grant_id);
