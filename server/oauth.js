import crypto from 'node:crypto';
import { InvalidClientMetadataError, InvalidGrantError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { nowIso } from './db.js';
import { randomToken, sha256 } from './secrets.js';

const ACCESS_TTL_SEC = 3600;
const REFRESH_TTL_SEC = 30 * 24 * 3600;
const CODE_TTL_MS = 5 * 60 * 1000;
const PENDING_TTL_MS = 10 * 60 * 1000;
const MAX_CLIENTS = 200;
const MAX_PENDING = 100;
const ORPHAN_GRANT_MS = 60 * 60 * 1000;

export const MCP_SCOPE = 'ronde';

/**
 * Redirections autorisées pour les clients enregistrés dynamiquement :
 * boucle locale (Claude Code, outils CLI) et callbacks claude.ai / claude.com.
 * Empêche un tiers d'enregistrer un client qui redirigerait le code vers son site.
 */
export function isAllowedRedirect(uri) {
  let url;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return true;
  return url.protocol === 'https:' && ['claude.ai', 'claude.com'].includes(url.hostname);
}

const now = () => Math.floor(Date.now() / 1000);

/**
 * Serveur d'autorisation OAuth 2.1 pour le MCP de ronde (interface du SDK MCP).
 * L'utilisateur s'authentifie avec le login / mot de passe de ronde sur
 * /oauth/consent ; les jetons sont stockés hachés et rattachés à une
 * autorisation (« grant ») révocable dans Réglages.
 */
export function createOAuthProvider({ db }) {
  const pending = new Map();
  const q = (sql) => db.prepare(sql);

  const clientsStore = {
    getClient(clientId) {
      const row = q('SELECT info FROM oauth_clients WHERE client_id = ?').get(clientId);
      return row ? JSON.parse(row.info) : undefined;
    },
    registerClient(client) {
      const uris = client.redirect_uris ?? [];
      if (!uris.length || !uris.every(isAllowedRedirect)) {
        throw new InvalidClientMetadataError(
          'redirect_uris non autorisées : seules la boucle locale (http://localhost) et claude.ai / claude.com sont acceptées.',
        );
      }
      // Plafond : on évince les plus anciens clients sans autorisation, pour qu'un
      // flot d'enregistrements anonymes ne bloque pas les clients légitimes.
      const excess = q('SELECT COUNT(*) AS n FROM oauth_clients').get().n - MAX_CLIENTS + 1;
      if (excess > 0) {
        q(
          `DELETE FROM oauth_clients WHERE client_id IN (
             SELECT client_id FROM oauth_clients WHERE client_id NOT IN (SELECT client_id FROM oauth_grants)
             ORDER BY created_at LIMIT ?)`,
        ).run(excess);
        if (q('SELECT COUNT(*) AS n FROM oauth_clients').get().n >= MAX_CLIENTS) {
          throw new InvalidClientMetadataError('Trop de clients enregistrés.');
        }
      }
      const full = { ...client, client_id: client.client_id ?? crypto.randomUUID(), client_id_issued_at: client.client_id_issued_at ?? now() };
      q('INSERT INTO oauth_clients (client_id, info, created_at) VALUES (?, ?, ?)').run(full.client_id, JSON.stringify(full), nowIso());
      return full;
    },
  };

  function purge() {
    const t = Date.now();
    for (const [id, p] of pending) if (p.expiresAt < t) pending.delete(id);
    q('DELETE FROM oauth_codes WHERE expires_at < ?').run(t);
    q('DELETE FROM oauth_tokens WHERE expires_at < ?').run(now());
    // Autorisations jamais échangées (consentement abandonné) ou dont tous les jetons ont expiré.
    q(
      `DELETE FROM oauth_grants WHERE created_at < ?
         AND id NOT IN (SELECT grant_id FROM oauth_tokens) AND id NOT IN (SELECT grant_id FROM oauth_codes)`,
    ).run(new Date(Date.now() - ORPHAN_GRANT_MS).toISOString());
  }

  function issueTokens(grantId, clientId, scopes, resource) {
    const access = randomToken();
    const refresh = randomToken();
    const insert = q(
      'INSERT INTO oauth_tokens (token_hash, kind, grant_id, client_id, scopes, resource, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    db.transaction(() => {
      insert.run(sha256(access), 'access', grantId, clientId, scopes, resource, now() + ACCESS_TTL_SEC);
      insert.run(sha256(refresh), 'refresh', grantId, clientId, scopes, resource, now() + REFRESH_TTL_SEC);
      q('UPDATE oauth_grants SET last_used_at = ? WHERE id = ?').run(nowIso(), grantId);
    })();
    return { access_token: access, token_type: 'bearer', expires_in: ACCESS_TTL_SEC, refresh_token: refresh, scope: scopes };
  }

  const redirectWith = (redirectUri, params) => {
    const url = new URL(redirectUri);
    for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, v);
    return url.toString();
  };

  return {
    clientsStore,

    /** Début du flux : on mémorise la demande et on envoie le navigateur sur la page de consentement. */
    async authorize(client, params, res) {
      purge();
      while (pending.size >= MAX_PENDING) pending.delete(pending.keys().next().value);
      const id = randomToken(24);
      pending.set(id, { client, params, expiresAt: Date.now() + PENDING_TTL_MS });
      res.redirect(302, `/oauth/consent?req=${encodeURIComponent(id)}`);
    },

    /** Demande en attente (pour afficher la page de consentement). */
    getPending(id) {
      const p = pending.get(id);
      if (!p || p.expiresAt < Date.now()) return null;
      return {
        clientName: p.client.client_name || 'Client MCP',
        redirectUri: p.params.redirectUri,
        redirectHost: new URL(p.params.redirectUri).host,
      };
    },

    /** L'utilisateur a accepté : crée l'autorisation et le code, retourne l'URL de retour. */
    approve(id, username) {
      const p = pending.get(id);
      pending.delete(id);
      if (!p || p.expiresAt < Date.now()) return null;
      const grantId = crypto.randomUUID();
      const code = randomToken();
      db.transaction(() => {
        q('INSERT INTO oauth_grants (id, client_id, client_name, username, created_at) VALUES (?, ?, ?, ?, ?)').run(
          grantId,
          p.client.client_id,
          p.client.client_name ?? null,
          username,
          nowIso(),
        );
        q(
          `INSERT INTO oauth_codes (code_hash, grant_id, client_id, code_challenge, redirect_uri, resource, scopes, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          sha256(code),
          grantId,
          p.client.client_id,
          p.params.codeChallenge,
          p.params.redirectUri,
          p.params.resource?.toString() ?? null,
          MCP_SCOPE,
          Date.now() + CODE_TTL_MS,
        );
      })();
      return redirectWith(p.params.redirectUri, { code, state: p.params.state });
    },

    /** L'utilisateur a refusé. */
    deny(id) {
      const p = pending.get(id);
      pending.delete(id);
      if (!p) return null;
      return redirectWith(p.params.redirectUri, {
        error: 'access_denied',
        error_description: 'Autorisation refusée',
        state: p.params.state,
      });
    },

    async challengeForAuthorizationCode(client, code) {
      const row = q('SELECT * FROM oauth_codes WHERE code_hash = ?').get(sha256(code));
      if (!row || row.client_id !== client.client_id || row.expires_at < Date.now()) {
        throw new InvalidGrantError('Code d’autorisation invalide ou expiré.');
      }
      return row.code_challenge;
    },

    async exchangeAuthorizationCode(client, code, _verifier, redirectUri) {
      const hash = sha256(code);
      const row = q('SELECT * FROM oauth_codes WHERE code_hash = ?').get(hash);
      q('DELETE FROM oauth_codes WHERE code_hash = ?').run(hash); // usage unique
      if (!row || row.client_id !== client.client_id || row.expires_at < Date.now()) {
        throw new InvalidGrantError('Code d’autorisation invalide ou expiré.');
      }
      if (redirectUri !== row.redirect_uri) {
        throw new InvalidGrantError('redirect_uri différente de celle de la demande.');
      }
      return issueTokens(row.grant_id, client.client_id, row.scopes, row.resource);
    },

    async exchangeRefreshToken(client, refreshToken) {
      const hash = sha256(refreshToken);
      const row = q("SELECT * FROM oauth_tokens WHERE token_hash = ? AND kind = 'refresh'").get(hash);
      if (!row || row.client_id !== client.client_id || row.expires_at < now()) {
        throw new InvalidGrantError('Jeton de renouvellement invalide, expiré ou révoqué.');
      }
      q('DELETE FROM oauth_tokens WHERE token_hash = ?').run(hash); // rotation
      return issueTokens(row.grant_id, client.client_id, row.scopes, row.resource);
    },

    async verifyAccessToken(token) {
      const row = q("SELECT * FROM oauth_tokens WHERE token_hash = ? AND kind = 'access'").get(sha256(token));
      if (!row || row.expires_at < now()) throw new InvalidTokenError('Jeton invalide, expiré ou révoqué.');
      return {
        token,
        clientId: row.client_id,
        scopes: row.scopes.split(' ').filter(Boolean),
        expiresAt: row.expires_at,
        resource: row.resource ? new URL(row.resource) : undefined,
        extra: { grantId: row.grant_id },
      };
    },

    /** Révoquer un jeton (déconnexion du client) révoque toute l'autorisation associée. */
    async revokeToken(client, { token }) {
      const row = q('SELECT grant_id FROM oauth_tokens WHERE token_hash = ? AND client_id = ?').get(sha256(token), client.client_id);
      if (row) q('DELETE FROM oauth_grants WHERE id = ?').run(row.grant_id);
    },

    touchGrant(grantId) {
      q('UPDATE oauth_grants SET last_used_at = ? WHERE id = ?').run(nowIso(), grantId);
    },

    listGrants() {
      return q('SELECT * FROM oauth_grants ORDER BY created_at DESC').all();
    },

    /** Révoque une autorisation : ses codes et jetons sont supprimés (cascade). */
    revokeGrant(id) {
      return q('DELETE FROM oauth_grants WHERE id = ?').run(id).changes;
    },
  };
}
