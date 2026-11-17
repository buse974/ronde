import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { setup } from './helpers.js';
import { extractJsonBlock, stripJsonBlock } from '../server/asks.js';

const HOST = '127.0.0.1';
const PASSWORD = 'motdepasse-solide';
const form = (agent, url, body = {}) => agent.post(url).set('Host', HOST).set('Origin', `http://${HOST}`).type('form').send(body);

async function admin() {
  const ctx = setup();
  const agent = request.agent(ctx.app);
  await form(agent, '/setup', { setup_code: 'ABCDE-12345', username: 'admin', password: PASSWORD, password_confirm: PASSWORD, alert_email: '' });
  return { ...ctx, agent, asks: ctx.app.locals.asks };
}

describe('Demander à Claude', () => {
  it('extrait le bloc JSON final', () => {
    const t = 'Texte\n\n```json\n{"type":"question"}\n```';
    expect(extractJsonBlock(t)).toEqual({ type: 'question' });
    expect(stripJsonBlock(t)).toBe('Texte');
    expect(extractJsonBlock('sans bloc')).toBeNull();
  });

  it('donne du contexte aux demandes ponctuelles', async () => {
    const { execPrompt } = await import('../server/asks.js');
    const p = execPrompt({ text: 'espace disque ?', hostDataDir: '/nope', tools: ['Read'] });
    expect(p).toContain('dans /nope');
    expect(p).toContain('conteneur');
    expect(p).toContain('Outils disponibles : Read');
    expect(p.trim().endsWith('espace disque ?')).toBe(true);
    const natif = execPrompt({ text: 'x', hostDataDir: '/opt/ronde/host-metrics', inContainer: false, tools: [] });
    expect(natif).toContain('directement sur le serveur');
    expect(natif).toContain('/opt/ronde/host-metrics');
    expect(natif).not.toContain('conteneur');
  });

  it('adapte les modèles au dossier de données hôte', async () => {
    const { templatesFor } = await import('../server/examples.js');
    const t = templatesFor('/opt/ronde/host-metrics');
    expect(t.disk.prompt).toContain('/opt/ronde/host-metrics/metrics.txt');
    expect(t.disk.prompt).not.toContain(' /host-metrics/');
  });

  it('répond à une demande ponctuelle sans proposer de ronde', async () => {
    const { agent, asks, store } = await admin();
    const res = await form(agent, '/asks', { prompt: 'capitale de la France ? MODE:plain', tools: ['Bash'] });
    const url = res.headers.location;
    await asks.drain();
    const ask = asks.get(Number(url.split('/').pop()));
    expect(ask).toMatchObject({ kind: 'exec', status: 'done', result: 'Paris.', suggest_ronde: false, allowed_tools: ['Read', 'Grep', 'Glob'] });
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM runs').get().n).toBe(0);
    const page = await agent.get(url).set('Host', HOST);
    expect(page.text).toContain('Paris.');
    expect(page.text).not.toContain('json');
    expect(page.text).not.toContain('carte conseillee');
    expect(page.text).toContain('En faire une ronde');
  });

  it('propose d’en faire une ronde, puis conçoit, préremplit et essaie', async () => {
    const { agent, asks } = await admin();
    const res = await form(agent, '/asks', { prompt: 'espace disque dispo ? MODE:suggest' });
    const execId = Number(res.headers.location.split('/').pop());
    await asks.drain();
    expect(asks.get(execId)).toMatchObject({ suggest_ronde: true, result: 'Il reste 36 Go libres sur 74 Go (47 %).' });
    expect((await agent.get(`/asks/${execId}`).set('Host', HOST)).text).toContain('carte conseillee');

    const design = await form(agent, `/asks/${execId}/to-ronde`);
    const id = Number(design.headers.location.split('/').pop());
    await asks.drain();
    // Le faux claude lit le dernier MODE : ici « suggest » de la première demande → pas de bloc de conception.
    expect(asks.get(id).messages.slice(0, 3).map((m) => m.role)).toEqual(['user', 'claude', 'user']);
    expect(asks.get(id).title).toBe('espace disque dispo ? MODE:suggest');

    await form(agent, `/asks/${id}/reply`, { text: 'seuil 85 % MODE:designq' });
    await asks.drain();
    expect(asks.get(id)).toMatchObject({ status: 'question' });
    expect((await agent.get(`/asks/${id}`).set('Host', HOST)).text).toContain('quel pic');

    await form(agent, `/asks/${id}/reply`, { text: 'ok MODE:designp' });
    await asks.drain();
    const ask = asks.get(id);
    expect(ask.status).toBe('proposal');
    expect(ask.proposal).toMatchObject({ name: 'Sécurité SSH', cron: '5 * * * *', allowed_tools: ['Read'] });

    const formPage = await agent.get(`/tasks/new?from_ask=${id}`).set('Host', HOST);
    expect(formPage.text).toContain('value="Sécurité SSH"');

    const tryRes = await form(agent, `/asks/${id}/try`);
    await asks.drain();
    expect(asks.get(Number(tryRes.headers.location.split('/').pop()))).toMatchObject({ kind: 'exec', status: 'done', title: 'Essai : Sécurité SSH' });
  });

  it('montre Claude en direct puis continue la conversation', async () => {
    const { agent, asks } = await admin();
    const res = await form(agent, '/asks', { prompt: 'espace disque ? MODE:slow' });
    const id = Number(res.headers.location.split('/').pop());
    // Pendant le run : l'étape et le texte partiel sont visibles.
    let live = null;
    for (let i = 0; i < 40 && !live?.text; i++) {
      await new Promise((r) => setTimeout(r, 50));
      live = asks.live(id);
    }
    expect(live.steps).toEqual(['Lecture de /host-metrics/metrics.txt']);
    expect(live.text).toBe('Réponse lente.');
    const status = await agent.get(`/asks/${id}/status`).set('Host', HOST);
    expect(status.text).toContain('Lecture de /host-metrics/metrics.txt');
    await asks.drain();
    expect(asks.live(id)).toBeNull();
    expect((await agent.get(`/asks/${id}/status`).set('Host', HOST)).headers['hx-refresh']).toBe('true');

    // Suite de la conversation.
    await form(agent, `/asks/${id}/reply`, { text: 'et sur /boot ? MODE:plain' });
    await asks.drain();
    const ask = asks.get(id);
    expect(ask.messages.map((m) => m.role)).toEqual(['user', 'claude', 'user', 'claude']);
    expect(ask.messages.at(-1).text).toBe('Paris.');
    expect(ask.result).toBe('Paris.');
  }, 10_000);

  it('une seule demande à la fois', async () => {
    const { agent, asks } = await admin();
    await form(agent, '/asks', { prompt: 'MODE:ok' });
    const second = await form(agent, '/asks', { prompt: 'MODE:ok' });
    expect(second.headers.location).toBe('/tasks?busy=1#demander');
    await asks.drain();
  });

  it('commente un passage : la conversation vit sur la page de la ronde', async () => {
    const { agent, asks, store } = await admin();
    const taskId = store.createTask({ name: 'Disque', prompt: 'Lis /host-metrics/disk.txt. Réponds RAS sous 85 %.', cron: '0 * * * *', allowed_tools: ['Read'], max_turns: 4, timeout_sec: 300, active: true });
    const runId = Number(store.db.prepare(`INSERT INTO runs (task_id, trigger, status, started_at, result) VALUES (?, 'cron', 'alert', ?, ?)`).run(taskId, new Date().toISOString(), 'Disque à 91 %.').lastInsertRowid);

    expect((await agent.get(`/runs/${runId}`).set('Host', HOST)).text).toContain('Commenter ce résultat');
    expect((await agent.get(`/tasks/${taskId}`).set('Host', HOST)).text).toContain('Une question sur cette ronde ?');

    const res = await form(agent, `/runs/${runId}/feedback`, { text: 'pourquoi ? MODE:tunea' });
    expect(res.headers.location).toBe(`/tasks/${taskId}#claude`);
    await asks.drain();
    const conv = asks.forTask(taskId);
    expect(conv).toMatchObject({ kind: 'tune', status: 'done', task_id: taskId, run_id: runId, proposal: null });
    const { tunePrompt } = await import('../server/asks.js');
    const p = tunePrompt({ task: store.getTask(taskId), run: store.getRun(runId), messages: [{ role: 'user', text: 'pourquoi ?' }], timezone: 'Europe/Paris', hostDataDir: '/nope', allowedTools: ['Read'] });
    expect(p).toContain('RAS sous 85 %');
    expect(p).toContain('Disque à 91 %.');
    expect((await agent.get(`/tasks/${taskId}`).set('Host', HOST)).text).toContain('au-dessus du seuil de 85 %');

    // Depuis le panneau de la ronde : même conversation.
    await form(agent, `/tasks/${taskId}/ask`, { text: 'alerte seulement au-dessus de 95 % MODE:tunep' });
    await asks.drain();
    expect(asks.forTask(taskId)).toMatchObject({ id: conv.id, status: 'proposal', proposal: { prompt: 'Lis /host-metrics/disk.txt. Réponds RAS sous 95 %.' } });
    expect(asks.forTask(taskId).messages).toHaveLength(4);
    expect((await agent.get(`/tasks/${taskId}`).set('Host', HOST)).text).toContain('Appliquer à la ronde');

    const applied = await form(agent, `/asks/${conv.id}/apply`);
    expect(applied.headers.location).toBe(`/tasks/${taskId}?tuned=1`);
    expect((await agent.get(applied.headers.location).set('Host', HOST)).text).toContain('Ronde modifiée.');
    expect(store.getTask(taskId)).toMatchObject({ prompt: 'Lis /host-metrics/disk.txt. Réponds RAS sous 95 %.', cron: '0 * * * *', active: true });

    await form(agent, `/tasks/${taskId}/delete`);
    expect(asks.get(conv.id)).toBeFalsy();
  });

  it('rattache la conversation à la ronde ou au oneshot créé', async () => {
    const { agent, asks, store } = await admin();
    // Conception → formulaire → ronde créée : la conversation suit.
    const r = await form(agent, '/asks', { prompt: 'fail2ban ? MODE:plain' });
    const execId = Number(r.headers.location.split('/').pop());
    await asks.drain();
    const d = await form(agent, `/asks/${execId}/to-ronde`);
    const designId = Number(d.headers.location.split('/').pop());
    await asks.drain();
    await form(agent, `/asks/${designId}/reply`, { text: 'ok MODE:designp' });
    await asks.drain();
    const formPage = await agent.get(`/tasks/new?from_ask=${designId}`).set('Host', HOST);
    expect(formPage.text).toContain(`name="from_ask" value="${designId}"`);
    const p = asks.get(designId).proposal;
    const created = await form(agent, '/tasks', { name: p.name, prompt: p.prompt, trigger: 'cron', cron: p.cron, allowed_tools: 'Read', max_turns: 4, timeout_sec: 300, active: 'on', from_ask: designId });
    const taskId = Number(created.headers.location.split('/').pop());
    expect(asks.forTask(taskId)).toMatchObject({ id: designId, kind: 'tune', proposal: null });
    const page = await agent.get(`/tasks/${taskId}`).set('Host', HOST);
    expect(page.text).toContain('Voici ma proposition.');
    expect(page.text).not.toContain('Appliquer à la ronde');

    // « Garder en oneshot » : idem.
    const kept = await form(agent, `/asks/${execId}/keep`);
    const oneshotId = Number(kept.headers.location.split('/')[2]);
    expect(asks.forTask(oneshotId)).toMatchObject({ id: execId, kind: 'tune' });
    // La suite passe par le réglage de ronde, plus par la demande ponctuelle.
    await form(agent, `/tasks/${oneshotId}/ask`, { text: 'plus court MODE:tunea' });
    await asks.drain();
    expect(asks.forTask(oneshotId)).toMatchObject({ status: 'done', result: 'Paris.' });
    expect(asks.forTask(oneshotId).messages.at(-1).text).toContain('au-dessus du seuil');

    // Le ménage des 20 dernières demandes épargne les conversations rattachées.
    for (let i = 0; i < 21; i += 1) {
      await form(agent, '/asks', { prompt: `q${i} MODE:plain` });
      await asks.drain();
    }
    expect(asks.get(execId)).toBeTruthy();
    expect(asks.get(designId)).toBeTruthy();
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM asks WHERE task_id IS NULL').get().n).toBe(20);
  });
});
