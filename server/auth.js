import argon2 from 'argon2';
import { randomToken, sha256 } from './secrets.js';

export const COOKIE = 'ronde_sid';
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;

export const isSetupDone = (store) => !!store.getSetting('admin_password_hash');

export const hashPassword = (password) => argon2.hash(password, { type: argon2.argon2id });

export function saveAdmin(store, username, hash) {
  store.db.transaction(() => {
    store.setSetting('admin_user', username);
    store.setSetting('admin_password_hash', hash);
  })();
}

export async function checkCredentials(store, username, password) {
  const hash = store.getSetting('admin_password_hash');
  if (!hash || username !== store.getSetting('admin_user')) {
    // Temps de réponse comparable que l'utilisateur existe ou non.
    await argon2.hash(password).catch(() => {});
    return false;
  }
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

export function openSession(store, config, res, username) {
  const token = randomToken();
  store.createSession(sha256(token), username, Date.now() + SESSION_TTL_MS);
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: config.cookieSecure,
    maxAge: SESSION_TTL_MS,
    path: '/',
  });
}

export function closeSession(store, req, res) {
  const token = req.cookies?.[COOKIE];
  if (token) store.deleteSession(sha256(token));
  res.clearCookie(COOKIE, { path: '/' });
}

/** Charge req.user depuis le cookie de session. */
export function sessionMiddleware(store) {
  return (req, res, next) => {
    const token = req.cookies?.[COOKIE];
    const session = token ? store.getSession(sha256(token)) : null;
    req.user = session?.username ?? null;
    res.locals.user = req.user;
    next();
  };
}

function redirect(req, res, url) {
  if (req.get('HX-Request')) {
    res.set('HX-Redirect', url).status(204).end();
  } else {
    res.redirect(url);
  }
}

/** Exige une installation terminée et une session valide. */
export function requireAuth(store) {
  return (req, res, next) => {
    if (!isSetupDone(store)) return redirect(req, res, '/setup');
    if (!req.user) {
      const nextUrl = req.method === 'GET' ? `?next=${encodeURIComponent(req.originalUrl)}` : '';
      return redirect(req, res, `/login${nextUrl}`);
    }
    next();
  };
}

/**
 * Protection CSRF : en plus du cookie SameSite=Strict, toute requête qui
 * modifie l'état doit venir de la même origine (en-tête Origin, ou Referer).
 */
export function sameOrigin() {
  return (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const source = req.get('Origin') || req.get('Referer');
    let host = null;
    try {
      host = source ? new URL(source).host : null;
    } catch {
      host = null;
    }
    if (!host || host !== req.get('Host')) {
      return res.status(403).send('Requête refusée : origine invalide.');
    }
    next();
  };
}

/** Limiteur en mémoire : `max` tentatives par IP sur `windowMs`. */
export function createRateLimiter({ max = 10, windowMs = 15 * 60 * 1000 } = {}) {
  const hits = new Map();
  return {
    blocked(key) {
      const entry = hits.get(key);
      if (!entry || entry.resetAt < Date.now()) return false;
      return entry.count >= max;
    },
    fail(key) {
      const now = Date.now();
      const entry = hits.get(key);
      if (!entry || entry.resetAt < now) hits.set(key, { count: 1, resetAt: now + windowMs });
      else entry.count += 1;
      if (hits.size > 10_000) {
        for (const [k, v] of hits) if (v.resetAt < now) hits.delete(k);
      }
    },
    reset(key) {
      hits.delete(key);
    },
  };
}

/** Évite les redirections ouvertes après login. */
export function safeNext(value) {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/\\') ? value : '/';
}
