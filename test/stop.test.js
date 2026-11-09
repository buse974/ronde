import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { setup, task } from './helpers.js';

const HOST = '127.0.0.1';
const PASSWORD = 'motdepasse-solide';
const form = (agent, url, body = {}) => agent.post(url).set('Host', HOST).set('Origin', `http://${HOST}`).type('form').send(body);

describe('Arrêter un passage', () => {
  it('arrête un passage en cours, sans mail', async () => {
    const ctx = setup();
    ctx.store.setSetting('alert_email', 'a@b.c');
    const t = ctx.store.getTask(ctx.store.createTask(task({ prompt: 'MODE:sleep', timeout_sec: 60 })));
    const s = ctx.executor.start(t, 'manual');
    await new Promise((r) => setTimeout(r, 200));
    const t0 = Date.now();
    expect(ctx.executor.stop(s.runId)).toBe(true);
    await s.done;
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(ctx.store.getRun(s.runId)).toMatchObject({ status: 'failed', error: 'Arrêté à la main.' });
    expect(ctx.mailer.sent).toHaveLength(0);
    expect(ctx.executor.stop(s.runId)).toBe(false);
  }, 10_000);

  it('bouton Arrêter sur la page d’un passage et d’une demande', async () => {
    const ctx = setup();
    const agent = request.agent(ctx.app);
    await form(agent, '/setup', { setup_code: 'ABCDE-12345', username: 'admin', password: PASSWORD, password_confirm: PASSWORD, alert_email: '' });
    const id = ctx.store.createTask(task({ prompt: 'MODE:sleep', timeout_sec: 120 }));
    const run = await form(agent, `/tasks/${id}/run`);
    const page = await agent.get(run.headers.location).set('Host', HOST);
    expect(page.text).toContain('Arrêter');
    expect(page.text).toContain('délai maximum 2 min');
    await form(agent, `${run.headers.location}/stop`);
    await ctx.executor.drain();
    expect(ctx.store.getRun(Number(run.headers.location.split('/').pop())).error).toBe('Arrêté à la main.');

    const asks = ctx.app.locals.asks;
    const ask = await form(agent, '/asks', { prompt: 'MODE:sleep' });
    await new Promise((r) => setTimeout(r, 200));
    expect((await agent.get(ask.headers.location).set('Host', HOST)).text).toContain('Arrêter');
    await form(agent, `${ask.headers.location}/stop`);
    await asks.drain();
    expect(asks.get(Number(ask.headers.location.split('/').pop()))).toMatchObject({ status: 'failed', error: 'Arrêté à la main.' });
  }, 15_000);
});
