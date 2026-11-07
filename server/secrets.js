import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Retourne le secret applicatif : APP_SECRET si défini, sinon le contenu de
 * <dataDir>/secret.key, créé au premier démarrage (32 octets aléatoires, mode 600).
 */
export function loadAppSecret({ appSecret, dataDir }) {
  if (appSecret) return appSecret;
  const file = path.join(dataDir, 'secret.key');
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const secret = crypto.randomBytes(32).toString('hex');
  try {
    fs.writeFileSync(file, secret + '\n', { mode: 0o600, flag: 'wx' });
    return secret;
  } catch (err) {
    // Créé entre-temps par un autre process : on relit.
    if (err.code === 'EEXIST') return fs.readFileSync(file, 'utf8').trim();
    throw err;
  }
}

export function deriveKey(secret, purpose) {
  return Buffer.from(crypto.hkdfSync('sha256', secret, 'ronde', purpose, 32));
}

/** AES-256-GCM. Format : v1:<iv>:<tag>:<ciphertext> (base64url). */
export function encrypt(key, plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv, tag, ct].map((p) => (typeof p === 'string' ? p : p.toString('base64url'))).join(':');
}

export function decrypt(key, payload) {
  const [version, iv, tag, ct] = String(payload).split(':');
  if (version !== 'v1' || !iv || !tag || ct === undefined) throw new Error('Format chiffré invalide');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
}

/**
 * Détecte le type de token Claude d'après son préfixe.
 * - oauth : token d'abonnement (`claude setup-token`) → CLAUDE_CODE_OAUTH_TOKEN
 * - api   : clé API facturée à l'usage → ANTHROPIC_API_KEY
 */
export function detectTokenType(token) {
  if (/^sk-ant-oat/.test(token)) return 'oauth';
  if (/^sk-ant-api/.test(token)) return 'api';
  return null;
}

export const TOKEN_ENV_VAR = { oauth: 'CLAUDE_CODE_OAUTH_TOKEN', api: 'ANTHROPIC_API_KEY' };

export function maskToken(token) {
  if (!token) return '';
  const prefix = token.slice(0, 10);
  return `${prefix}…${token.slice(-4)}`;
}

export function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}
