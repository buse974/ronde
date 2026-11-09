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
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { TEMPLATES, templateTask } from './examples.js';
import { ASK_TOOLS, createAsks } from './asks.js';
import { createMcpHandler, DEFAULT_MCP_TOOLS, mcpAllowedTools } from './mcp.js';
import { createOAuthProvider, MCP_SCOPE } from './oauth.js';
import { buildDial, buildStrip, createHelpers, groupRuns, summarize } from './helpers.js';
import { classify, runClaude } from './runner.js';
import { nextRuns, cronError } from './scheduler.js';
import { emailSchema, issuesToErrors, parseTaskForm, parseToolList, setupSchema } from './validation.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PAGE_SIZE = 50;

/** URL publique et activation du MCP : OAuth exige HTTPS (sauf localhost). */
export function mcpEndpoint(config) {
  const base = new URL(config.publicUrl || `http://localhost:${config.port}`);
  const local = ['localhost', '127.0.0.1'].includes(base.hostname);
  return {
    enabled: base.protocol === 'https:' || local,
    issuer: new URL(base.origin),
    url: new URL('/mcp', base.origin),
  };
}

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
  const oauth = createOAuthProvider({ db: store.db });
  const asks = createAsks({ db: store.db, config, claudeAuth });
  asks.recoverOrphans();
  app.locals.asks = asks;
  const mcp = mcpEndpoint(config);

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
  // --- MCP (OAuth 2.1) : monté avant le contrôle Origin, car Claude Code
  // appelle ces routes hors navigateur. --------------------------------------
  if (mcp.enabled) {
    app.use(
      mcpAuthRouter({
        provider: oauth,
        issuerUrl: mcp.issuer,
        resourceServerUrl: mcp.url,
        scopesSupported: [MCP_SCOPE],
        resourceName: 'ronde',
      }),
    );
    const bearer = requireBearerAuth({
      verifier: oauth,
      requiredScopes: [MCP_SCOPE],
      resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcp.url),
    });
    const handler = createMcpHandler({ store, config, claudeAuth, executor, oauth, hostDataDir: config.hostDataDir });
    app.post('/mcp', bearer, express.json({ limit: '1mb' }), asyncRoute(handler));
    app.all('/mcp', (req, res) =>
      res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Méthode non autorisée.' }, id: null }),
    );
  }

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

  // --- Consentement OAuth (connexion de Claude Code au MCP) ---------------
  const consentView = (res, reqId, pendingReq, req, extra = {}) => {
    // La redirection finale part vers le callback du client : autorisée par la CSP de cette page.
    res.set(
      'Content-Security-Policy',
      `default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'; form-action 'self' ${new URL(pendingReq.redirectUri).origin}`,
    );
    res.view('oauth-consent', { reqId, p: pendingReq, user: req.user, error: null, ...extra });
  };

  app.get('/oauth/consent', (req, res) => {
    if (!isSetupDone(store)) return res.redirect('/setup');
    const p = oauth.getPending(String(req.query.req ?? ''));
    if (!p) return res.status(400).view('error', { message: 'Demande d’autorisation expirée. Relance la connexion depuis Claude Code (/mcp).' });
    consentView(res, req.query.req, p, req);
  });

  app.post(
    '/oauth/consent',
    asyncRoute(async (req, res) => {
      const reqId = String(req.body.req ?? '');
      const p = oauth.getPending(reqId);
      if (!p) return res.status(400).view('error', { message: 'Demande d’autorisation expirée. Relance la connexion depuis Claude Code (/mcp).' });
      if (req.body.action === 'deny') return res.redirect(oauth.deny(reqId));

      let username = req.user;
      if (!username) {
        if (limiter.blocked(req.ip)) {
          res.status(429);
          return consentView(res, reqId, p, req, { error: 'Trop de tentatives. Réessaie dans 15 minutes.' });
        }
        const candidate = String(req.body.username ?? '').trim();
        if (!(await checkCredentials(store, candidate, String(req.body.password ?? '')))) {
          limiter.fail(req.ip);
          res.status(401);
          return consentView(res, reqId, p, req, { error: 'Identifiant ou mot de passe incorrect.' });
        }
        limiter.reset(req.ip);
        username = candidate;
      }
      res.redirect(oauth.approve(reqId, username));
    }),
  );

  // --- Tout ce qui suit exige d'être connecté ----------------------------
  app.use(requireAuth(store));

  app.get('/', (req, res) => res.redirect('/tasks'));

  app.get('/tasks', (req, res) => {
    const tasks = store.listTasks();
    const recentRuns = store.runsSince(24);
    res.view('tasks', {
      tasks,
      tokenStatus: claudeAuth.status(),
      templates: TEMPLATES,
      dial: buildDial({ tasks, recentRuns, timezone: config.timezone }),
      asks: asks.recent(),
      askBusy: asks.busy || req.query.busy === '1',
      summary: summarize({ tasks, recentRuns, timezone: config.timezone }),
    });
  });

  app.get('/tasks/new', (req, res) => {
    const proposal = req.query.from_ask ? asks.get(Number(req.query.from_ask))?.proposal : null;
    res.view('task-form', {
      task: null,
      values: proposal
        ? { ...proposal, active: true }
        : { name: '', prompt: '', cron: '0 * * * *', allowed_tools: [], max_turns: 5, timeout_sec: 600, active: true },
      errors: {},
      fromAsk: proposal ? Number(req.query.from_ask) : null,
    });
  });

  // --- Demander à Claude --------------------------------------------------
  app.post('/asks', (req, res) => {
    const text = String(req.body.prompt ?? '').trim();
    if (!text) return res.redirect('/tasks');
    if (text.length > 20_000) return res.status(400).view('error', { message: 'Demande trop longue (20 000 caractères maximum).' });
    const started = asks.start('exec', text, ASK_TOOLS);
    if (!started) return res.redirect('/tasks?busy=1#demander');
    res.redirect(`/asks/${started.id}`);
  });

  const loadAsk = (req, res, next) => {
    const ask = asks.get(Number(req.params.id));
    if (!ask) return res.status(404).view('error', { message: 'Demande introuvable (seules les 20 dernières sont gardées).' });
    req.ask = ask;
    next();
  };

  app.get('/asks/:id', loadAsk, (req, res) => res.view('ask', { ask: req.ask, busy: asks.busy }));

  app.get('/asks/:id/status', loadAsk, (req, res) => {
    if (req.ask.status !== 'running') return res.set('HX-Refresh', 'true').status(204).end();
    res.view('partials/ask-running', { ask: req.ask });
  });

  app.post('/asks/:id/reply', loadAsk, (req, res) => {
    const text = String(req.body.text ?? '').trim();
    if (text) {
      const r = asks.reply(req.ask.id, text.slice(0, 20_000));
      if (r.error) return res.status(409).view('ask', { ask: req.ask, busy: asks.busy, error: r.error });
    }
    res.redirect(`/asks/${req.ask.id}`);
  });

  // « En faire une ronde » : conception guidée à partir de la demande et de la réponse.
  app.post('/asks/:id/to-ronde', loadAsk, (req, res) => {
    const a = req.ask;
    const history = a.result ? [{ role: 'user', text: a.title }, { role: 'claude', text: a.result.slice(0, 4000) }] : [];
    const text = a.result ? 'Fais-en une ronde.' : a.title;
    const started = asks.start('design', text, mcpAllowedTools(store), { title: a.title, history });
    if (!started) return res.status(409).view('ask', { ask: a, busy: true, error: 'Une demande est déjà en cours.' });
    res.redirect(`/asks/${started.id}`);
  });

  app.post('/asks/:id/try', loadAsk, (req, res) => {
    const p = req.ask.proposal;
    if (!p) return res.redirect(`/asks/${req.ask.id}`);
    const started = asks.start('exec', p.prompt, p.allowed_tools ?? ['Read'], { raw: true, title: `Essai : ${p.name}` });
    if (!started) return res.status(409).view('ask', { ask: req.ask, busy: true, error: 'Une demande est déjà en cours.' });
    res.redirect(`/asks/${started.id}`);
  });

  app.post('/tasks', (req, res) => {
    const { data, errors, values } = parseTaskForm(req.body, config.timezone);
    if (errors) return res.status(400).view('task-form', { task: null, values, errors });
    const id = store.createTask(data);
    res.redirect(`/tasks/${id}`);
  });

  app.post('/tasks/template/:key', (req, res) => {
    const task = templateTask(req.params.key);
    if (!task) return res.status(404).view('error', { message: 'Modèle introuvable.' });
    const id = store.createTask(task);
    res.redirect(`/tasks/${id}`);
  });

  app.get('/cron-preview', (req, res) => {
    const expr = String(req.query.cron ?? '').trim();
    const error = cronError(expr, config.timezone, { allowEmpty: true });
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
      runs: groupRuns(store.listRuns(req.task.id, PAGE_SIZE, (page - 1) * PAGE_SIZE)),
      stats: store.taskStats(req.task.id),
      strip: buildStrip(store.runsForDays(req.task.id, 30), config.timezone),
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
      mcp: { ...mcp, url: mcp.url.toString() },
      grants: oauth.listGrants(),
      mcpTools: mcpAllowedTools(store),
      defaultMcpTools: DEFAULT_MCP_TOOLS,
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

  app.post('/settings/mcp/tools', (req, res) => {
    const rules = parseToolList(req.body.mcp_tools);
    if (rules.some((r) => !/^[A-Za-z][A-Za-z0-9_]*(\(.{1,200}\))?$/.test(r))) {
      res.status(400);
      return settingsView(res, { errors: { mcp_tools: 'Règle d’outil invalide (ex : Read, Bash(df:*)).' } });
    }
    store.setSetting('mcp_allowed_tools', JSON.stringify(rules));
    settingsView(res, { notice: 'Outils autorisables via MCP enregistrés.' });
  });

  app.post('/settings/mcp/grants/:id/revoke', (req, res) => {
    oauth.revokeGrant(req.params.id);
    settingsView(res, { notice: 'Accès MCP révoqué.' });
  });

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
