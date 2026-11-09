import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { localToUtc, parseTaskForm, utcToLocal } from '../server/validation.js';
import { startScheduler } from '../server/scheduler.js';
import { setup, silentLog, task } from './helpers.js';

const HOST = '127.0.0.1';
const PASSWORD = 'motdepasse-solide';
const form = (agent, url, body = {}) => agent.post(url).set('Host', HOST).set('Origin', `http://${HOST}`).type('form').send(body);
const base = { name: 'x', prompt: 'p', allowed_tools: 'Read', max_turns: 3, timeout_sec: 60 };

describe('dates dans le fuseau', () => {
  it('convertit heure locale ↔ UTC, heure d’hiver et d’été', () => {
    expect(localToUtc('2026-11-10T08:00', 'Europe/Paris')).toBe('2026-11-10T07:00:00.000Z');
    expect(localToUtc('2026-07-10T08:00', 'Europe/Paris')).toBe('2026-07-10T06:00:00.000Z');
    expect(utcToLocal('2026-07-10T06:00:00.000Z', 'Europe/Paris')).toBe('2026-07-10T08:00');
    expect(localToUtc('n’importe quoi', 'Europe/Paris')).toBeNull();
  });
});

describe('formulaire : déclenchement', () => {
  const now = new Date('2026-11-09T12:00:00Z');
  it('planifiée exige un cron', () => {
    expect(parseTaskForm({ ...base, trigger: 'cron', cron: '' }, 'Europe/Paris', now).errors.cron).toMatch(/fréquence/);
  });
  it('oneshot : ni cron ni date', () => {
    const { data } = parseTaskForm({ ...base, trigger: 'oneshot', cron: '0 * * * *', run_at: '2026-11-10T08:00' }, 'Europe/Paris', now);
    expect(data).toMatchObject({ cron: '', run_at: null, notify: false });
  });
  it('une seule fois : date future obligatoire', () => {
    expect(parseTaskForm({ ...base, trigger: 'once', run_at: '' }, 'Europe/Paris', now).errors.run_at).toBeTruthy();
    expect(parseTaskForm({ ...base, trigger: 'once', run_at: '2026-11-08T08:00' }, 'Europe/Paris', now).errors.run_at).toMatch(/à venir/);
    const { data } = parseTaskForm({ ...base, trigger: 'once', run_at: '2026-11-10T08:00', notify: 'on' }, 'Europe/Paris', now);
    expect(data).toMatchObject({ cron: '', run_at: '2026-11-10T07:00:00.000Z', active: true, notify: true });
  });
});

describe('scheduler et alertes', () => {
  it('lance un passage unique une seule fois puis le met en pause', async () => {
    const ctx = setup();
    const id = ctx.store.createTask(task({ cron: '', run_at: '2026-11-10T07:00:00.000Z' }));
    const sched = startScheduler({ store: ctx.store, executor: ctx.executor, timezone: 'UTC', log: silentLog, now: () => 0 });
    sched.stop();
    expect(sched.runDue(new Date('2026-11-10T06:59:00Z').getTime())).toHaveLength(0);
    const started = sched.runDue(new Date('2026-11-10T07:00:00Z').getTime());
    expect(started).toHaveLength(1);
    await started[0].done;
    expect(ctx.store.getTask(id).active).toBe(false);
    expect(sched.runDue(new Date('2026-11-10T07:01:00Z').getTime())).toHaveLength(0);
    expect(ctx.store.listRuns(id)).toHaveLength(1);
  });

  it('sans alerte : réponse non RAS = « done », pas de mail', async () => {
    const ctx = setup();
    ctx.store.setSetting('alert_email', 'a@b.c');
    const id = ctx.store.createTask(task({ cron: '', prompt: 'MODE:alert', notify: false }));
    const s = ctx.executor.start(ctx.store.getTask(id), 'manual');
    await s.done;
    expect(ctx.store.getRun(s.runId).status).toBe('done');
    expect(ctx.mailer.sent).toHaveLength(0);
  });
});

describe('interface', () => {
  async function admin() {
    const ctx = setup();
    const agent = request.agent(ctx.app);
    await form(agent, '/setup', { setup_code: 'ABCDE-12345', username: 'admin', password: PASSWORD, password_confirm: PASSWORD, alert_email: '' });
    return { ...ctx, agent, asks: ctx.app.locals.asks };
  }

  it('sépare Rondes et Oneshots', async () => {
    const { agent, store } = await admin();
    store.createTask(task({ name: 'Ronde horaire', cron: '0 * * * *' }));
    store.createTask(task({ name: 'Point Docker', cron: '', notify: false }));
    const page = (await agent.get('/tasks').set('Host', HOST)).text;
    expect(page).toContain('<h2>Oneshots</h2>');
    expect(page.indexOf('Ronde horaire')).toBeLessThan(page.indexOf('<h2>Oneshots</h2>'));
    expect(page.indexOf('Point Docker')).toBeGreaterThan(page.indexOf('<h2>Oneshots</h2>'));
  });

  it('crée une ronde « une seule fois » depuis le formulaire', async () => {
    const { agent, store } = await admin();
    const res = await form(agent, '/tasks', { ...base, name: 'Sauvegarde de cette nuit', trigger: 'once', run_at: '2099-01-01T08:00', notify: 'on' });
    const id = Number(res.headers.location.split('/').pop());
    expect(store.getTask(id)).toMatchObject({ cron: '', run_at: '2099-01-01T07:00:00.000Z', active: true, notify: true });
    expect((await agent.get(`/tasks/${id}`).set('Host', HOST)).text).toContain('Une fois, le 01/01 08:00');
  });

  it('« Garder en oneshot » enregistre la demande', async () => {
    const { agent, store, asks } = await admin();
    const res = await form(agent, '/asks', { prompt: 'point Docker ? MODE:plain' });
    const askId = Number(res.headers.location.split('/').pop());
    await asks.drain();
    expect((await agent.get(`/asks/${askId}`).set('Host', HOST)).text).toContain('Garder en oneshot');
    const kept = await form(agent, `/asks/${askId}/keep`);
    expect(kept.headers.location).toMatch(/^\/tasks\/\d+\/edit\?kept=1$/);
    const t = store.getTask(Number(kept.headers.location.split('/')[2]));
    expect(t).toMatchObject({ cron: '', run_at: null, notify: false, allowed_tools: ['Read', 'Grep', 'Glob'] });
    expect(t.prompt).toContain('point Docker ?');
    expect(t.prompt).toContain('/host-metrics');
  });
});
