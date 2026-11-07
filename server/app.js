import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import express from 'express';
import cookieParser from 'cookie-parser';
import { Eta } from 'eta';
import {
  checkCredentials,
  closeSession,
  createRateLimiter,
  hashPassword,
  isSetupDone,
  openSession,
  requireAuth,
  safeNext,
  saveAdmin,
  sameOrigin,
  sessionMiddleware,
} from './auth.js';
import { DISK_TASK } from './examples.js';
import { createHelpers } from './helpers.js';
import { classify, runClaude } from './runner.js';
import { nextRuns, cronError } from './scheduler.js';
import { emailSchema, issuesToErrors, parseTaskForm, setupSchema } from './validation.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PAGE_SIZE = 50;

const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function constantTimeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * @param {object} deps
 * @param {ReturnType<import('./store.js').createStore>} deps.store
 * @param {ReturnType<import('./config.js').loadConfig>} deps.config
 * @param {ReturnType<import('./claude-auth.js').createClaudeAuth>} deps.claudeAuth
 * @param {ReturnType<import('./mailer.js').createMailer>} deps.mailer
 * @param {ReturnType<import('./scheduler.js').createExecutor>} deps.executor
 * @param {string|null} deps.setupCode  code d'installation (affiché dans les logs)
 */
export function createApp({ store, config, claudeAuth, mailer, executor, setupCode }) {
  const app = express();
  const eta = new Eta({ views: path.join(ROOT, 'views'), cache: config.production });
  const h = createHelpers(config.timezone);
  const limiter = createRateLimiter();

  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);

  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'same-origin',
      'Content-Security-Policy':
        "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; frame-ancestors 'none'; form-action 'self'",
    });
    res.view = (name, data = {}) => res.send(eta.render(name, { h, user: req.user, path: req.path, timezone: config.timezone, ...data }));
    next();
  });

  app.get('/health', (req, res) => res.json({ status: 'ok', service: 'ronde', type: 'app' }));
  app.use(express.static(path.join(ROOT, 'public'), { maxAge: config.production ? '1d' : 0 }));
  app.use(express.urlencoded({ extended: false, limit: '100kb' }));
  app.use(cookieParser());
  app.use(sameOrigin());
  app.use(sessionMiddleware(store));

  // --- Installation (premier accès) --------------------------------------
  app.get('/setup', (req, res) => {
    if (isSetupDone(store)) return res.redirect('/');
    res.view('setup', { values: {}, errors: {} });
  });

  app.post(
    '/setup',
    asyncRoute(async (req, res) => {
      if (isSetupDone(store)) return res.redirect('/');
      const values = { ...req.body, alert_email: String(req.body.alert_email ?? '').trim() };
      const errors = {};
      if (limiter.blocked(req.ip)) {
        errors._ = 'Trop de tentatives. Réessaie dans 15 minutes.';
        return res.status(429).view('setup', { values, errors });
      }
      const parsed = setupSchema.safeParse(values);
      if (!parsed.success) Object.assign(errors, issuesToErrors(parsed.error));
      if (!setupCode || !constantTimeEqual(String(values.setup_code ?? '').trim().toUpperCase(), setupCode)) {
        limiter.fail(req.ip);
        errors.setup_code = 'Code d’installation incorrect (voir les logs du conteneur).';
      }
      if (Object.keys(errors).length) return res.status(400).view('setup', { values, errors });

      // Rien n'est enregistré tant que le code et tous les champs ne sont pas valides.
      const { claude_token: token } = parsed.data;
      if (token) {
        try {
          claudeAuth.validate(token);
        } catch (err) {
          return res.status(400).view('setup', { values, errors: { claude_token: err.message } });
        }
      }
      const hash = await hashPassword(parsed.data.password);
      // Deux installations concurrentes : la première gagne.
      if (isSetupDone(store)) return res.redirect('/');
      saveAdmin(store, parsed.data.username, hash);
      if (token) claudeAuth.save(token);
      if (parsed.data.alert_email) store.setSetting('alert_email', parsed.data.alert_email);
      limiter.reset(req.ip);
      openSession(store, config, res, parsed.data.username);
      res.redirect('/tasks');
    }),
  );

  // --- Connexion ---------------------------------------------------------
  app.get('/login', (req, res) => {
    if (!isSetupDone(store)) return res.redirect('/setup');
    if (req.user) return res.redirect('/');
    res.view('login', { next: safeNext(req.query.next), error: null, username: '' });
  });

  app.post(
    '/login',
    asyncRoute(async (req, res) => {
      const username = String(req.body.username ?? '').trim();
      const next = safeNext(req.body.next);
      if (limiter.blocked(req.ip)) {
        return res.status(429).view('login', { next, username, error: 'Trop de tentatives. Réessaie dans 15 minutes.' });
      }
      if (!(await checkCredentials(store, username, String(req.body.password ?? '')))) {
        limiter.fail(req.ip);
        return res.status(401).view('login', { next, username, error: 'Identifiant ou mot de passe incorrect.' });
      }
      limiter.reset(req.ip);
      store.purgeSessions();
      openSession(store, config, res, username);
      res.redirect(next);
    }),
  );

  app.post('/logout', (req, res) => {
    closeSession(store, req, res);
    res.redirect('/login');
  });

  // --- Tout ce qui suit exige d'être connecté ----------------------------
  app.use(requireAuth(store));

  app.get('/', (req, res) => res.redirect('/tasks'));

  app.get('/tasks', (req, res) => {
    res.view('tasks', { tasks: store.listTasks(), tokenStatus: claudeAuth.status() });
  });

  app.get('/tasks/new', (req, res) => {
    res.view('task-form', {
      task: null,
      values: { name: '', prompt: '', cron: '0 * * * *', allowed_tools: [], max_turns: 5, timeout_sec: 600, active: true },
      errors: {},
    });
  });

  app.post('/tasks', (req, res) => {
    const { data, errors, values } = parseTaskForm(req.body, config.timezone);
    if (errors) return res.status(400).view('task-form', { task: null, values, errors });
    const id = store.createTask(data);
    res.redirect(`/tasks/${id}`);
  });

  app.post('/tasks/example', (req, res) => {
    const id = store.createTask(DISK_TASK);
    res.redirect(`/tasks/${id}`);
  });

  app.get('/cron-preview', (req, res) => {
    const expr = String(req.query.cron ?? '').trim();
    const error = cronError(expr, config.timezone);
    res.view('partials/cron-preview', { expr, error, next: error ? [] : nextRuns(expr, config.timezone, 3) });
  });

  const loadTask = (req, res, next) => {
    const task = store.getTask(Number(req.params.id));
    if (!task) return res.status(404).view('error', { message: 'Tâche introuvable.' });
    req.task = task;
    next();
  };

  app.get('/tasks/:id', loadTask, (req, res) => {
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const total = store.countRuns(req.task.id);
    res.view('task', {
      task: req.task,
      runs: store.listRuns(req.task.id, PAGE_SIZE, (page - 1) * PAGE_SIZE),
      stats: store.taskStats(req.task.id),
      page,
      pages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
      started: req.query.started,
    });
  });

  app.get('/tasks/:id/edit', loadTask, (req, res) => {
    res.view('task-form', { task: req.task, values: req.task, errors: {} });
  });

  app.post('/tasks/:id', loadTask, (req, res) => {
    const { data, errors, values } = parseTaskForm(req.body, config.timezone);
    if (errors) return res.status(400).view('task-form', { task: req.task, values, errors });
    store.updateTask(req.task.id, data);
    res.redirect(`/tasks/${req.task.id}`);
  });

  app.post('/tasks/:id/toggle', loadTask, (req, res) => {
    store.setTaskActive(req.task.id, !req.task.active);
    if (req.get('HX-Request')) {
      const task = store.listTasks().find((t) => t.id === req.task.id);
      return res.view('partials/task-row', { t: task });
    }
    res.redirect(`/tasks/${req.task.id}`);
  });

  app.post('/tasks/:id/run', loadTask, (req, res) => {
    const started = executor.start(req.task, 'manual');
    res.redirect(started ? `/runs/${started.runId}` : `/tasks/${req.task.id}?started=busy`);
  });

  app.post('/tasks/:id/delete', loadTask, (req, res) => {
    store.deleteTask(req.task.id);
    res.redirect('/tasks');
  });

  // --- Runs --------------------------------------------------------------
  app.get('/runs/:id', (req, res) => {
    const run = store.getRun(Number(req.params.id));
    if (!run) return res.status(404).view('error', { message: 'Run introuvable.' });
    let pretty = null;
    if (run.raw_json) pretty = JSON.stringify(JSON.parse(run.raw_json), null, 2);
    res.view('run', { run, pretty });
  });

  // Rafraîchissement htmx tant que le run tourne ; recharge la page quand il est fini.
  app.get('/runs/:id/status', (req, res) => {
    const run = store.getRun(Number(req.params.id));
    if (!run) return res.status(404).end();
    if (run.status !== 'running') return res.set('HX-Refresh', 'true').status(204).end();
    res.view('partials/run-running', { run });
  });

  // --- Réglages ----------------------------------------------------------
  const settingsView = (res, extra = {}) =>
    res.view('settings', {
      token: claudeAuth.status(),
      alertEmail: store.getSetting('alert_email') ?? '',
      smtpEnabled: mailer.enabled,
      smtpFrom: config.smtp.from,
      errors: {},
      notice: null,
      ...extra,
    });

  app.get('/settings', (req, res) => settingsView(res));

  app.post('/settings/token', (req, res) => {
    try {
      const type = claudeAuth.save(req.body.claude_token);
      settingsView(res, { notice: type === 'api' ? 'Clé API enregistrée : les runs seront facturés à l’usage.' : 'Token enregistré.' });
    } catch (err) {
      res.status(400);
      settingsView(res, { errors: { claude_token: err.message } });
    }
  });

  app.post('/settings/token/delete', (req, res) => {
    claudeAuth.remove();
    settingsView(res, { notice: 'Token supprimé.' });
  });

  app.post(
    '/settings/token/test',
    asyncRoute(async (req, res) => {
      const auth = claudeAuth.resolve();
      if (!auth) return res.view('partials/token-test', { ok: false, message: 'Aucun token configuré.' });
      const out = await runClaude({
        prompt: 'Réponds uniquement : RAS',
        allowedTools: [],
        maxTurns: 1,
        timeoutSec: 120,
        auth,
        config,
        timezone: config.timezone,
      });
      const r = classify(out);
      const ok = r.status !== 'failed';
      res.view('partials/token-test', {
        ok,
        message: ok ? `Claude répond (« ${(r.result ?? '').slice(0, 80)} »).` : r.error,
        detail: ok ? null : (r.result || out.stderr || '').slice(0, 1000),
        cost: r.cost_usd,
      });
    }),
  );

  app.post('/settings/alerts', (req, res) => {
    const parsed = emailSchema.safeParse(String(req.body.alert_email ?? '').trim());
    if (!parsed.success) {
      res.status(400);
      return settingsView(res, { alertEmail: req.body.alert_email, errors: { alert_email: 'Email invalide.' } });
    }
    if (parsed.data) store.setSetting('alert_email', parsed.data);
    else store.deleteSetting('alert_email');
    settingsView(res, { notice: 'Email d’alerte enregistré.' });
  });

  app.post(
    '/settings/alerts/test',
    asyncRoute(async (req, res) => {
      const to = store.getSetting('alert_email');
      if (!to) return settingsView(res, { errors: { alert_email: 'Renseigne d’abord un email.' } });
      try {
        await mailer.sendTest(to);
        settingsView(res, { notice: `Mail de test envoyé à ${to}.` });
      } catch (err) {
        res.status(502);
        settingsView(res, { errors: { alert_email: `Envoi impossible : ${err.message}` } });
      }
    }),
  );

  // --- Erreurs -----------------------------------------------------------
  app.use((req, res) => res.status(404).view('error', { message: 'Page introuvable.' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).view('error', { message: 'Erreur interne.' });
  });

  return app;
}
