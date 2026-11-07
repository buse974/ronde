import fs from 'node:fs';
import crypto from 'node:crypto';
import 'dotenv/config';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { createStore } from './store.js';
import { loadAppSecret } from './secrets.js';
import { createClaudeAuth } from './claude-auth.js';
import { createMailer } from './mailer.js';
import { createExecutor, startScheduler } from './scheduler.js';
import { isSetupDone } from './auth.js';
import { createApp } from './app.js';
import { killAllRuns } from './runner.js';

const config = loadConfig();

// /data contient la base et le secret : accessible au seul process app.
fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
try {
  fs.chmodSync(config.dataDir, 0o700);
} catch {
  /* volume dont on n'est pas propriétaire : on garde ses droits */
}

const appSecret = loadAppSecret(config);
const db = openDb(config.dbPath);
const store = createStore(db);

const orphans = store.recoverOrphanRuns();
if (orphans) console.warn(`[ronde] ${orphans} run(s) interrompu(s) marqué(s) en échec`);
store.purgeSessions();

const claudeAuth = createClaudeAuth({ store, appSecret, envToken: config.envClaudeToken });
const mailer = createMailer(config);
const executor = createExecutor({ store, config, claudeAuth, mailer });

// Code d'installation : exigé par l'écran de premier accès, affiché uniquement dans les logs.
let setupCode = null;
if (!isSetupDone(store)) {
  const raw = crypto.randomBytes(5).toString('hex').toUpperCase();
  setupCode = `${raw.slice(0, 5)}-${raw.slice(5)}`;
  const lines = [`Code d'installation ronde : ${setupCode}`, 'À saisir sur /setup pour créer le compte admin.'];
  const width = Math.max(...lines.map((l) => l.length)) + 4;
  console.log('');
  console.log(`  ┌${'─'.repeat(width)}┐`);
  for (const l of lines) console.log(`  │  ${l.padEnd(width - 4)}  │`);
  console.log(`  └${'─'.repeat(width)}┘`);
  console.log('');
}

const app = createApp({ store, config, claudeAuth, mailer, executor, setupCode });
const scheduler = startScheduler({ store, executor, timezone: config.timezone });

const server = app.listen(config.port, () => {
  console.log(`[ronde] écoute sur le port ${config.port} (fuseau ${config.timezone})`);
  if (!mailer.enabled) console.warn('[ronde] SMTP_HOST absent : les alertes mail sont désactivées');
  if (config.runner.uid == null) console.warn('[ronde] RUNNER_UID absent : claude tourne sous le même utilisateur que l’app (dev uniquement)');
});

function shutdown(signal) {
  console.log(`[ronde] ${signal} reçu, arrêt`);
  scheduler.stop();
  const killed = killAllRuns('SIGTERM');
  if (killed) console.log(`[ronde] ${killed} run(s) en cours interrompu(s)`);
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
