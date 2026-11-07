import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../server/db.js';
import { createStore } from '../server/store.js';
import { loadConfig } from '../server/config.js';
import { createClaudeAuth } from '../server/claude-auth.js';
import { createExecutor } from '../server/scheduler.js';
import { createApp } from '../server/app.js';

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
  const executor = createExecutor({ store, config, claudeAuth, mailer, log: silentLog });
  const app = createApp({ store, config, claudeAuth, mailer, executor, setupCode: 'ABCDE-12345' });
  return { config, store, claudeAuth, mailer, executor, app };
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
