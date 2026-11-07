import path from 'node:path';

function int(value, fallback) {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

/**
 * Configuration d'infrastructure, lue depuis l'environnement.
 * Les réglages fonctionnels (admin, token Claude, email d'alerte) vivent en base.
 */
export function loadConfig(env = process.env) {
  const production = env.NODE_ENV === 'production'; // cache des templates
  const dataDir = path.resolve(env.DATA_DIR || './data');

  return {
    production,
    port: int(env.PORT, 3000),
    dataDir,
    dbPath: env.DATABASE_PATH ? path.resolve(env.DATABASE_PATH) : path.join(dataDir, 'ronde.db'),
    timezone: env.TZ || 'Europe/Paris',
    publicUrl: (env.PUBLIC_URL || '').replace(/\/+$/, ''),
    // Désactivés par défaut : ronde peut être exposé en HTTP direct (port 3000).
    // Derrière un reverse proxy HTTPS : TRUST_PROXY=1 et COOKIE_SECURE=true.
    trustProxy: int(env.TRUST_PROXY, 0),
    cookieSecure: bool(env.COOKIE_SECURE, false),

    // Secret applicatif : prioritaire sur /data/secret.key s'il est défini.
    appSecret: env.APP_SECRET || null,

    // Token Claude fourni par l'environnement : prioritaire sur celui saisi dans l'UI.
    envClaudeToken: env.CLAUDE_CODE_OAUTH_TOKEN || env.ANTHROPIC_API_KEY || null,

    // Données de l'hôte lisibles par les rondes (scripts de host/).
    hostDataDir: env.HOST_DATA_DIR || '/host-metrics',

    runner: {
      bin: env.CLAUDE_BIN || 'claude',
      path: env.RUNNER_PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      uid: env.RUNNER_UID ? int(env.RUNNER_UID) : null,
      gid: env.RUNNER_GID ? int(env.RUNNER_GID) : null,
      home: env.RUNNER_HOME || null,
      cwd: env.RUNNER_CWD || env.RUNNER_HOME || null,
      maxStdoutBytes: int(env.RUNNER_MAX_STDOUT, 2 * 1024 * 1024),
      maxStderrBytes: int(env.RUNNER_MAX_STDERR, 64 * 1024),
      killGraceMs: int(env.RUNNER_KILL_GRACE_MS, 10_000),
    },

    smtp: {
      host: env.SMTP_HOST || null,
      port: int(env.SMTP_PORT, 25),
      secure: bool(env.SMTP_SECURE, false),
      user: env.SMTP_USER || null,
      pass: env.SMTP_PASS || null,
      from: env.SMTP_FROM || 'ronde@localhost',
      rejectUnauthorized: bool(env.SMTP_TLS_REJECT_UNAUTHORIZED, true),
    },
  };
}
