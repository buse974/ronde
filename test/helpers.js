import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../server/db.js';
import { createStore } from '../server/store.js';
import { loadConfig } from '../server/config.js';
import { createClaudeAuth } from '../server/claude-auth.js';
import { createExecutor } from '../server/scheduler.js';
import { createApp } from '../server/app.js';
import { createChannels } from '../server/channels.js';
import { createRelay } from '../server/relay.js';

export const FAKE_CLAUDE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-claude.js');
export const OAUTH = 'sk-ant-oat01-' + 'x'.repeat(40);

export const silentLog = { warn() {}, error() {}, log() {} };

export function fakeMailer() {
  const sent = [];
  return {
    sent,
    enabled: true,
    async sendRunAlert({ to, task, run }) {
      if (!to) return false;
      sent.push({ to, task: task.name, status: run.status, result: run.result });
      return true;
    },
    async send({ to, subject, text }) {
      sent.push({ to, subject, text });
    },
    async sendTest(to) {
      sent.push({ to, test: true });
    },
  };
}

export function setup({ envToken = null, token = OAUTH, env = {} } = {}) {
  const config = loadConfig({ DATA_DIR: '/nonexistent', CLAUDE_BIN: FAKE_CLAUDE, TZ: 'Europe/Paris', RUNNER_KILL_GRACE_MS: '200', PUBLIC_URL: 'http://127.0.0.1', RUNNER_PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, ...env });
  const store = createStore(openDb(':memory:'));
  const claudeAuth = createClaudeAuth({ store, appSecret: 'test-secret', envToken });
  if (token) claudeAuth.save(token);
  const mailer = fakeMailer();
  // Faux réseau : les envois des canaux Slack / Teams / webhook sont enregistrés ici.
  const posts = [];
  const fetchImpl = async (url, init) => {
    let body = init.body;
    try {
      body = JSON.parse(init.body);
    } catch {
      /* corps texte, ou absent */
    }
    posts.push({ url: String(url), method: init.method ?? 'POST', body, headers: init.headers });
    if (String(url).includes('echec')) return new Response('nope', { status: 500 });
    return new Response('ok', { status: 200 });
  };
  const channels = createChannels({ store, appSecret: 'test-secret', mailer, config, fetchImpl, log: silentLog });
  const relay = createRelay({ channels, config, log: silentLog });
  const executor = createExecutor({ store, config, claudeAuth, channels, relay, log: silentLog });
  const app = createApp({ store, config, claudeAuth, mailer, executor, channels, relay, setupCode: 'ABCDE-12345' });
  return { config, store, claudeAuth, mailer, executor, channels, relay, posts, app };
}

export const task = (over = {}) => ({
  name: 'T',
  prompt: 'MODE:ok',
  cron: '0 * * * *',
  allowed_tools: [],
  max_turns: 2,
  timeout_sec: 30,
  active: true,
  ...over,
});
