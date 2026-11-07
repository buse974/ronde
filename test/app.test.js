import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { setup } from './helpers.js';

const HOST = '127.0.0.1';
const ORIGIN = `http://${HOST}`;
const PASSWORD = 'motdepasse-solide';

const post = (agent, url, body = {}) => agent.post(url).set('Host', HOST).set('Origin', ORIGIN).type('form').send(body);

async function installed() {
  const ctx = setup({ token: null });
  const agent = request.agent(ctx.app);
  const res = await post(agent, '/setup', {
    setup_code: 'abcde-12345', username: 'admin', password: PASSWORD, password_confirm: PASSWORD, alert_email: '', claude_token: '',
  });
  expect(res.status).toBe(302);
  return { ...ctx, agent };
}

describe('installation et auth', () => {
  it('redirige vers /setup tant que rien n’est installé', async () => {
    const { app } = setup({ token: null });
    expect((await request(app).get('/tasks')).headers.location).toBe('/setup');
  });

  it('refuse un mauvais code d’installation', async () => {
    const { app, store } = setup({ token: null });
    const res = await post(request(app), '/setup', { setup_code: 'WRONG', username: 'admin', password: PASSWORD, password_confirm: PASSWORD, alert_email: '' });
    expect(res.status).toBe(400);
    expect(store.getSetting('admin_password_hash')).toBeNull();
  });

  it('installe sans email, connecte directement, puis /setup est fermé', async () => {
    const { agent, store } = await installed();
    expect(store.getSetting('alert_email')).toBeNull();
    expect((await agent.get('/tasks')).status).toBe(200);
    expect((await agent.get('/setup')).headers.location).toBe('/');
  });

  it('exige une session ; login KO puis OK, sans redirection ouverte', async () => {
    const { app } = await installed();
    const anon = request.agent(app);
    expect((await anon.get('/tasks')).headers.location).toMatch(/^\/login/);
    expect((await post(anon, '/login', { username: 'admin', password: 'faux' })).status).toBe(401);
    const ok = await post(anon, '/login', { username: 'admin', password: PASSWORD, next: '//evil.com' });
    expect(ok.headers.location).toBe('/');
    expect(ok.headers['set-cookie'][0]).toMatch(/HttpOnly/);
    expect(ok.headers['set-cookie'][0]).toMatch(/SameSite=Strict/);
    expect((await anon.get('/tasks')).status).toBe(200);
  });

  it('refuse un POST d’une autre origine', async () => {
    const { agent } = await installed();
    const res = await agent.post('/tasks/template/disk').set('Host', HOST).set('Origin', 'http://evil.com');
    expect(res.status).toBe(403);
  });
});

describe('tâches', () => {
  it('crée, valide, modifie, désactive et supprime', async () => {
    const { agent, store } = await installed();
    const bad = await post(agent, '/tasks', { name: '', prompt: 'x', cron: 'nope', max_turns: 3, timeout_sec: 60 });
    expect(bad.status).toBe(400);
    expect(bad.text).toContain('Nom requis');

    const created = await post(agent, '/tasks', {
      name: 'Disque', prompt: 'MODE:ok', cron: '*/5 * * * *', allowed_tools: 'Read\nBash(df:*)', max_turns: 3, timeout_sec: 60, active: 'on',
    });
    expect(created.status).toBe(302);
    const id = Number(created.headers.location.split('/').pop());
    expect(store.getTask(id)).toMatchObject({ name: 'Disque', allowed_tools: ['Read', 'Bash(df:*)'], active: true });
    expect((await agent.get(`/tasks/${id}`)).text).toContain('Toutes les 5 minutes');

    await post(agent, `/tasks/${id}`, { name: 'Disque 2', prompt: 'MODE:ok', cron: '0 8 * * *', allowed_tools: '', max_turns: 1, timeout_sec: 30 });
    expect(store.getTask(id)).toMatchObject({ name: 'Disque 2', active: false, allowed_tools: [] });

    await post(agent, `/tasks/${id}/toggle`);
    expect(store.getTask(id).active).toBe(true);

    await post(agent, `/tasks/${id}/delete`);
    expect(store.getTask(id)).toBeNull();
  });

  it('échappe le HTML', async () => {
    const { agent, store } = await installed();
    store.createTask({ name: '<script>x</script>', prompt: 'p', cron: '0 * * * *', allowed_tools: [], max_turns: 1, timeout_sec: 30, active: true });
    const res = await agent.get('/tasks');
    expect(res.text).not.toContain('<script>x</script>');
    expect(res.text).toContain('&lt;script&gt;');
  });

  it('lancement manuel puis détail du run', async () => {
    const { agent, store, executor, claudeAuth } = await installed();
    claudeAuth.save('sk-ant-oat01-' + 'y'.repeat(30));
    const ex = await post(agent, '/tasks/template/disk');
    const id = Number(ex.headers.location.split('/').pop());
    store.updateTask(id, { ...store.getTask(id), prompt: 'MODE:alert' });
    const res = await post(agent, `/tasks/${id}/run`);
    expect(res.headers.location).toMatch(/^\/runs\/\d+$/);
    await executor.drain();
    const page = await agent.get(res.headers.location);
    expect(page.text).toContain('Disque / à 92 %');
    expect(page.text).toContain('Alerte');
    expect((await agent.get(`/tasks/${id}`)).text).toContain('0,0123');
  });
});

describe('réglages', () => {
  it('enregistre le token sans jamais le réafficher', async () => {
    const { agent } = await installed();
    const token = 'sk-ant-oat01-' + 'z'.repeat(30) + 'WXYZ';
    const res = await post(agent, '/settings/token', { claude_token: token });
    expect(res.status).toBe(200);
    expect(res.text).not.toContain(token);
    expect(res.text).toContain('…WXYZ');
    expect((await post(agent, '/settings/token', { claude_token: 'nope' })).status).toBe(400);
  });

  it('teste le token via claude', async () => {
    const { agent } = await installed();
    await post(agent, '/settings/token', { claude_token: 'sk-ant-oat01-' + 'z'.repeat(30) });
    expect((await post(agent, '/settings/token/test')).text).toContain('Claude répond');
  });

  it('valide l’email d’alerte', async () => {
    const { agent, store } = await installed();
    expect((await post(agent, '/settings/alerts', { alert_email: 'pas-un-mail' })).status).toBe(400);
    await post(agent, '/settings/alerts', { alert_email: 'moi@exemple.fr' });
    expect(store.getSetting('alert_email')).toBe('moi@exemple.fr');
  });
});

describe('installation : rien n’est enregistré si le code est faux', () => {
  it('ne persiste pas le token envoyé avec un mauvais code', async () => {
    const { app, store } = setup({ token: null });
    await post(request(app), '/setup', {
      setup_code: 'WRONG', username: 'admin', password: PASSWORD, password_confirm: PASSWORD, alert_email: '', claude_token: 'sk-ant-api03-attaquant',
    });
    expect(store.getSetting('claude_token')).toBeNull();
  });
});
