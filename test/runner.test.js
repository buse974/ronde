import { describe, expect, it } from 'vitest';
import { buildArgs, buildEnv, classify, isRas, parseOutput } from '../server/runner.js';
import { setup, task } from './helpers.js';

const json = (o) => JSON.stringify({ is_error: false, result: 'RAS', ...o });

describe('isRas', () => {
  it.each(['RAS', 'ras', ' RAS.\n', 'RAS !', 'Ras!!'])('accepte %j', (t) => expect(isRas(t)).toBe(true));
  it.each(['', 'RAS mais disque plein', 'Rien à signaler', null, 'RAS\nsauf X'])('refuse %j', (t) => expect(isRas(t)).toBe(false));
});

describe('classify', () => {
  it('ok si exit 0, is_error false et RAS', () => {
    expect(classify({ exitCode: 0, stdout: json() }).status).toBe('ok');
  });
  it('alert si la réponse n’est pas RAS', () => {
    const r = classify({ exitCode: 0, stdout: json({ result: 'Disque plein' }) });
    expect(r.status).toBe('alert');
    expect(r.error).toBeNull();
  });
  it('failed si exit_code != 0, même avec RAS', () => {
    expect(classify({ exitCode: 1, stdout: json() }).status).toBe('failed');
  });
  it('failed si is_error = true, même avec subtype success', () => {
    expect(classify({ exitCode: 0, stdout: json({ is_error: true, subtype: 'success' }) }).status).toBe('failed');
  });
  it('ignore subtype : success + is_error false + RAS = ok', () => {
    expect(classify({ exitCode: 0, stdout: json({ subtype: 'error_max_turns' }) }).status).toBe('ok');
  });
  it('failed si sortie illisible, timeout ou spawn impossible', () => {
    expect(classify({ exitCode: 0, stdout: 'nope' }).status).toBe('failed');
    expect(classify({ exitCode: null, stdout: '', timedOut: true }).status).toBe('failed');
    expect(classify({ exitCode: null, stdout: '', spawnError: 'ENOENT' }).status).toBe('failed');
  });
  it('extrait usage et coût', () => {
    const r = classify({
      exitCode: 0,
      stdout: json({ total_cost_usd: 0.5, num_turns: 3, usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 } }),
    });
    expect(r).toMatchObject({ cost_usd: 0.5, num_turns: 3, input_tokens: 1, output_tokens: 2, cache_read_tokens: 3, cache_creation_tokens: 4 });
  });
  it('accepte un tableau d’événements', () => {
    expect(parseOutput(JSON.stringify([{ type: 'system' }, { type: 'result', result: 'RAS', is_error: false }])).result).toBe('RAS');
  });
});

describe('buildArgs / buildEnv', () => {
  it('restreint les outils et n’inclut jamais le prompt', () => {
    const args = buildArgs({ allowedTools: ['Read', 'Bash(df:*)', 'Bash(du -sh:*)'], maxTurns: 3 });
    expect(args).toEqual(['-p', '--output-format', 'json', '--max-turns', '3', '--no-session-persistence', '--tools', 'Read,Bash', '--allowedTools', 'Read', 'Bash(df:*)', 'Bash(du -sh:*)']);
  });
  it('aucun outil = --tools ""', () => {
    expect(buildArgs({ allowedTools: [], maxTurns: 1 })).toContain('');
  });
  it('transmet un seul token, selon son type', () => {
    expect(buildEnv({ auth: { type: 'oauth', token: 'a' }, timezone: 'UTC' })).toMatchObject({ CLAUDE_CODE_OAUTH_TOKEN: 'a' });
    const api = buildEnv({ auth: { type: 'api', token: 'b' }, timezone: 'UTC' });
    expect(api.ANTHROPIC_API_KEY).toBe('b');
    expect(api.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });
});

describe('executor (faux binaire claude)', () => {
  const runTask = async (ctx, over) => {
    const id = ctx.store.createTask(task(over));
    const started = ctx.executor.start(ctx.store.getTask(id), 'manual');
    await started.done;
    return ctx.store.getRun(started.runId);
  };

  it('enregistre un run RAS sans alerte', async () => {
    const ctx = setup();
    ctx.store.setSetting('alert_email', 'a@b.c');
    const run = await runTask(ctx, { prompt: 'MODE:ok' });
    expect(run).toMatchObject({ status: 'ok', exit_code: 0, is_error: 0, result: 'RAS', cost_usd: 0.0123, input_tokens: 10, cache_read_tokens: 1000, token_type: 'oauth' });
    expect(ctx.mailer.sent).toHaveLength(0);
  });

  it('alerte par mail quand la réponse n’est pas RAS', async () => {
    const ctx = setup();
    ctx.store.setSetting('alert_email', 'a@b.c');
    const run = await runTask(ctx, { prompt: 'MODE:alert' });
    expect(run.status).toBe('alert');
    expect(run.alert_sent).toBe(1);
    expect(ctx.mailer.sent[0]).toMatchObject({ to: 'a@b.c', status: 'alert', result: 'Disque / à 92 %' });
  });

  it.each([
    ['iserror', 'failed'],
    ['exit', 'failed'],
    ['garbage', 'failed'],
    ['subtype', 'ok'],
  ])('MODE:%s → %s', async (mode, status) => {
    const run = await runTask(setup(), { prompt: `MODE:${mode}` });
    expect(run.status).toBe(status);
  });

  it('n’hérite pas de l’environnement de l’app', async () => {
    process.env.APP_SECRET_LEAK_TEST = 'secret';
    const run = await runTask(setup(), { prompt: 'MODE:env', allowed_tools: ['Read'] });
    delete process.env.APP_SECRET_LEAK_TEST;
    const { keys, args } = JSON.parse(run.result);
    expect(keys).not.toContain('APP_SECRET_LEAK_TEST');
    expect(keys).toContain('CLAUDE_CODE_OAUTH_TOKEN');
    expect(keys).not.toContain('ANTHROPIC_API_KEY');
    expect(args).toContain('--allowedTools');
    expect(args.join(' ')).not.toContain('MODE:env');
  });

  it('timeout → failed', async () => {
    const run = await runTask(setup(), { prompt: 'MODE:sleep', timeout_sec: 1 });
    expect(run).toMatchObject({ status: 'failed', timed_out: 1 });
  }, 10_000);

  it('sans token → failed sans lancer claude', async () => {
    const run = await runTask(setup({ token: null }), { prompt: 'MODE:ok' });
    expect(run.status).toBe('failed');
    expect(run.error).toMatch(/token/i);
  });

  it('binaire introuvable → failed', async () => {
    const run = await runTask(setup({ env: { CLAUDE_BIN: '/nope/claude' } }), {});
    expect(run.status).toBe('failed');
    expect(run.error).toMatch(/Impossible de lancer/);
  });
});

describe('timeout et descendants', () => {
  it('tue aussi les processus lancés par claude', async () => {
    const { execSync } = await import('node:child_process');
    const ctx = setup();
    const id = ctx.store.createTask(task({ prompt: 'MODE:fork', timeout_sec: 1 }));
    const started = ctx.executor.start(ctx.store.getTask(id), 'manual');
    const t0 = Date.now();
    await started.done;
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(ctx.store.getRun(started.runId)).toMatchObject({ status: 'failed', timed_out: 1 });
    await new Promise((r) => setTimeout(r, 200));
    const left = execSync("pgrep -f '^sleep 30$' || true").toString().trim();
    expect(left).toBe('');
  }, 10_000);
});
