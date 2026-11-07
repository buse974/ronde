import { decrypt, deriveKey, detectTokenType, encrypt, maskToken } from './secrets.js';

const SETTING = 'claude_token';

/**
 * Gestion du token Claude : saisi dans l'UI (chiffré en base) ou fourni par
 * l'environnement, qui est alors prioritaire.
 */
export function createClaudeAuth({ store, appSecret, envToken }) {
  const key = deriveKey(appSecret, 'claude-token');

  function fromDb() {
    const payload = store.getSetting(SETTING);
    if (!payload) return null;
    try {
      return decrypt(key, payload);
    } catch {
      // APP_SECRET changé : le token stocké est illisible.
      return { unreadable: true };
    }
  }

  return {
    /** Token à utiliser pour un run : { token, type } ou null. */
    resolve() {
      if (envToken) return { token: envToken, type: detectTokenType(envToken) ?? 'oauth', source: 'env' };
      const token = fromDb();
      if (!token || typeof token !== 'string') return null;
      return { token, type: detectTokenType(token) ?? 'oauth', source: 'db' };
    },

    /** Infos affichables (jamais le token en clair). */
    status() {
      if (envToken) {
        return { configured: true, source: 'env', type: detectTokenType(envToken), masked: maskToken(envToken) };
      }
      const token = fromDb();
      if (token?.unreadable) return { configured: false, unreadable: true, source: 'db' };
      if (!token) return { configured: false, source: null };
      return { configured: true, source: 'db', type: detectTokenType(token), masked: maskToken(token) };
    },

    /** Vérifie le format d'un token saisi. Retourne { token, type } ou lève une erreur lisible. */
    validate(raw) {
      const token = String(raw ?? '').trim();
      if (!token) throw new Error('Le token est vide.');
      if (/\s/.test(token)) throw new Error('Le token ne doit pas contenir d’espace ni de retour à la ligne.');
      const type = detectTokenType(token);
      if (!type) throw new Error('Format non reconnu : attendu sk-ant-oat… (abonnement) ou sk-ant-api… (clé API).');
      return { token, type };
    },

    /** Enregistre un token saisi (chiffré). Retourne son type. */
    save(raw) {
      const { token, type } = this.validate(raw);
      store.setSetting(SETTING, encrypt(key, token));
      return type;
    },

    remove() {
      store.deleteSetting(SETTING);
    },

    get fromEnv() {
      return !!envToken;
    },
  };
}
