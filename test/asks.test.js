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
    expect(page.text).toContain('Créer une ronde');
  });

  it('une question devient une ronde dans la même conversation, puis la page de la ronde', async () => {
    const { agent, asks, store } = await admin();
    const res = await form(agent, '/asks', { prompt: 'espace disque dispo ? MODE:suggest' });
    const id = Number(res.headers.location.split('/').pop());
    await asks.drain();
    expect(asks.get(id)).toMatchObject({ suggest_ronde: true, result: 'Il reste 36 Go libres sur 74 Go (47 %).' });
    const page = (await agent.get(`/asks/${id}`).set('Host', HOST)).text;
    expect(page).toContain('À surveiller régulièrement');
    expect(page).toContain('Garder en oneshot');

    // « Créer une ronde » continue la même conversation, en conception.
    const design = await form(agent, `/asks/${id}/to-ronde`);
    expect(design.headers.location).toBe(`/asks/${id}`);
    await asks.drain();
    expect(asks.get(id)).toMatchObject({ kind: 'design' });
    expect(asks.get(id).messages.map((m) => m.role)).toEqual(['user', 'claude', 'user', 'claude']);
    expect((await agent.get(`/asks/${id}`).set('Host', HOST)).text).toContain('En préparation');

    await form(agent, `/asks/${id}/reply`, { text: 'seuil 85 % MODE:designq' });
    await asks.drain();
    expect(asks.get(id)).toMatchObject({ status: 'question' });
    expect((await agent.get(`/asks/${id}`).set('Host', HOST)).text).toContain('quel pic');

    await form(agent, `/asks/${id}/reply`, { text: 'ok MODE:designp' });
    await asks.drain();
    expect(asks.get(id).proposal).toMatchObject({ name: 'Sécurité SSH', cron: '5 * * * *', allowed_tools: ['Read'] });
    expect((await agent.get(`/asks/${id}`).set('Host', HOST)).text).toContain('Créer la ronde');

    const tryRes = await form(agent, `/asks/${id}/try`);
    await asks.drain();
    expect(asks.get(Number(tryRes.headers.location.split('/').pop()))).toMatchObject({ kind: 'exec', status: 'done', title: 'Essai : Sécurité SSH' });

    // « Créer la ronde » : directement, sans formulaire ; la conversation suit sur la page de la ronde.
    const created = await form(agent, `/asks/${id}/create`);
    const taskId = Number(created.headers.location.split('/').pop());
    expect(store.getTask(taskId)).toMatchObject({ name: 'Sécurité SSH', cron: '5 * * * *', active: true, notify: true });
    expect(asks.forTask(taskId)).toMatchObject({ id, kind: 'tune', proposal: null });
    expect((await agent.get(`/asks/${id}`).set('Host', HOST)).headers.location).toBe(`/tasks/${taskId}#claude`);
    const taskPage = (await agent.get(`/tasks/${taskId}`).set('Host', HOST)).text;
    expect(taskPage).toContain('quel pic');
    expect(taskPage).not.toContain('/edit');
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

  it('plusieurs conversations en parallèle, une réponse à la fois par conversation', async () => {
    const { agent, asks } = await admin(); // plafond par défaut : 3
    const ids = [];
    for (let i = 0; i < 3; i += 1) {
      const r = await form(agent, '/asks', { prompt: 'MODE:slow' });
      expect(r.headers.location).toMatch(/^\/asks\/\d+$/);
      ids.push(Number(r.headers.location.split('/').pop()));
    }
    // Même conversation : refusé tant que Claude répond.
    const again = await form(agent, `/asks/${ids[0]}/reply`, { text: 'et alors ?' });
    expect(again.status).toBe(409);
    // Plafond atteint : une 4e conversation attend.
    const fourth = await form(agent, '/asks', { prompt: 'MODE:ok' });
    expect(fourth.headers.location).toBe('/tasks?busy=1#demander');
    await asks.drain();
    expect(ids.map((id) => asks.get(id).status)).toEqual(['done', 'done', 'done']);
    expect(asks.busy).toBe(false);
  });

  it('depuis un passage : la conversation de la ronde est à côté, avec ce passage en contexte', async () => {
    const { agent, asks, store } = await admin();
    const taskId = store.createTask({ name: 'Disque', prompt: 'Lis /host-metrics/disk.txt. Réponds RAS sous 85 %.', cron: '0 * * * *', allowed_tools: ['Read'], max_turns: 4, timeout_sec: 300, active: true });
    const runId = Number(store.db.prepare(`INSERT INTO runs (task_id, trigger, status, started_at, result) VALUES (?, 'cron', 'alert', ?, ?)`).run(taskId, new Date().toISOString(), 'Disque à 91 %.').lastInsertRowid);

    const runPage = (await agent.get(`/runs/${runId}`).set('Host', HOST)).text;
    expect(runPage).not.toContain('Commenter ce résultat');
    expect(runPage).toContain(`action="/tasks/${taskId}/ask"`);
    expect(runPage).toContain(`name="run_id" value="${runId}"`);
    expect((await agent.get(`/tasks/${taskId}`).set('Host', HOST)).text).toContain('Demande pourquoi elle a répondu ça');

    const res = await form(agent, `/tasks/${taskId}/ask`, { text: 'pourquoi ? MODE:tunea', run_id: runId });
    expect(res.headers.location).toBe(`/runs/${runId}#claude`);
    await asks.drain();
    expect((await agent.get(`/runs/${runId}`).set('Host', HOST)).text).toContain('au-dessus du seuil de 85 %');
    const conv = asks.forTask(taskId);
    expect(conv).toMatchObject({ kind: 'tune', status: 'done', task_id: taskId, run_id: runId, proposal: null });
    const { tunePrompt } = await import('../server/asks.js');
    const p = tunePrompt({ task: store.getTask(taskId), run: store.getRun(runId), messages: [{ role: 'user', text: 'pourquoi ?' }], timezone: 'Europe/Paris', hostDataDir: '/nope', allowedTools: ['Read'] });
    expect(p).toContain('RAS sous 85 %');
    expect(p).toContain('Disque à 91 %.');
    expect(p).toContain('Passage que l\'administrateur regarde');
    expect((await agent.get(`/tasks/${taskId}`).set('Host', HOST)).text).toContain('au-dessus du seuil de 85 %');

    // Depuis la page de la ronde : même conversation, et on ne regarde plus un passage précis.
    await form(agent, `/tasks/${taskId}/ask`, { text: 'alerte seulement au-dessus de 95 % MODE:tunep' });
    await asks.drain();
    expect(asks.forTask(taskId).run_id).toBeNull();
    expect(asks.forTask(taskId)).toMatchObject({ id: conv.id, status: 'proposal', proposal: { prompt: 'Lis /host-metrics/disk.txt. Réponds RAS sous 95 %.' } });
    expect(asks.forTask(taskId).messages.filter((m) => m.role !== 'history')).toHaveLength(4);
    expect((await agent.get(`/tasks/${taskId}`).set('Host', HOST)).text).toContain('/apply"');

    const applied = await form(agent, `/asks/${conv.id}/apply`);
    expect(applied.headers.location).toBe(`/tasks/${taskId}?tuned=1`);
    expect((await agent.get(applied.headers.location).set('Host', HOST)).text).toContain('Ronde modifiée.');
    expect(store.getTask(taskId)).toMatchObject({ prompt: 'Lis /host-metrics/disk.txt. Réponds RAS sous 95 %.', cron: '0 * * * *', active: true });

    // Le bouton laisse une trace dans l'historique, et la proposition disparaît.
    const hist = asks.forTask(taskId).messages.filter((m) => m.role === 'history');
    expect(hist.at(-1)).toMatchObject({ by: 'ui', prompt_before: 'Lis /host-metrics/disk.txt. Réponds RAS sous 85 %.', prompt_after: 'Lis /host-metrics/disk.txt. Réponds RAS sous 95 %.' });
    expect(asks.forTask(taskId).proposal).toBeNull();
  });

  it('rattache la conversation qui crée une ronde ou un oneshot', async () => {
    const { agent, asks, store } = await admin();
    // Formulaire avec from_ask : la conversation devient celle de la ronde.
    let r = await form(agent, '/asks', { prompt: 'fail2ban ? MODE:plain' });
    const designId = Number(r.headers.location.split('/').pop());
    await asks.drain();
    await form(agent, `/asks/${designId}/to-ronde`);
    await asks.drain();
    await form(agent, `/asks/${designId}/reply`, { text: 'ok MODE:designp' });
    await asks.drain();
    const p = asks.get(designId).proposal;
    const created = await form(agent, '/tasks', { name: p.name, prompt: p.prompt, trigger: 'cron', cron: p.cron, allowed_tools: 'Read', max_turns: 4, timeout_sec: 300, active: 'on', from_ask: designId });
    const taskId = Number(created.headers.location.split('/').pop());
    expect(asks.forTask(taskId)).toMatchObject({ id: designId, kind: 'tune', proposal: null });
    expect(asks.forTask(taskId).messages.at(-1)).toMatchObject({ role: 'history', by: 'form' });
    const page = await agent.get(`/tasks/${taskId}`).set('Host', HOST);
    expect(page.text).toContain('Voici ma proposition.');
    expect(page.text).not.toContain('/apply"');
    expect(page.text).not.toContain('Historique ·'); // invisible hors debug

    // « Garder en oneshot ».
    r = await form(agent, '/asks', { prompt: 'point Docker ? MODE:plain' });
    const execId = Number(r.headers.location.split('/').pop());
    await asks.drain();
    const kept = await form(agent, `/asks/${execId}/keep`);
    const oneshotId = Number(kept.headers.location.split('/')[2]);
    expect(asks.forTask(oneshotId)).toMatchObject({ id: execId, kind: 'tune' });
    // La suite passe par le réglage de ronde, plus par la demande ponctuelle.
    await form(agent, `/tasks/${oneshotId}/ask`, { text: 'plus court MODE:tunea' });
    await asks.drain();
    expect(asks.forTask(oneshotId).messages.at(-1).text).toContain('au-dessus du seuil');

    // Demandes récentes : seulement les conversations libres. Le ménage épargne les rondes.
    expect(asks.recent().map((a) => a.id)).not.toContain(execId);
    for (let i = 0; i < 21; i += 1) {
      await form(agent, '/asks', { prompt: `q${i} MODE:plain` });
      await asks.drain();
    }
    expect(asks.get(execId)).toBeTruthy();
    expect(asks.get(designId)).toBeTruthy();
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM asks WHERE task_id IS NULL').get().n).toBe(20);
  });

  it('Claude agit sur accord : créer, modifier, pause, archiver, restaurer', async () => {
    const { agent, asks, store } = await admin();
    let r = await form(agent, '/asks', { prompt: 'surveille le disque MODE:plain' });
    const id = Number(r.headers.location.split('/').pop());
    await asks.drain();
    await form(agent, `/asks/${id}/to-ronde`);
    await asks.drain();
    // « ok crée-la » → action creer
    await form(agent, `/asks/${id}/reply`, { text: 'ok crée-la MODE:actcreer' });
    await asks.drain();
    const taskId = asks.get(id).task_id;
    expect(store.getTask(taskId)).toMatchObject({ name: 'Disque', cron: '0 * * * *', active: true });
    const conv = asks.forTask(taskId);
    expect(conv.messages.at(-1)).toMatchObject({ role: 'claude', text: 'C’est fait : ronde Disque créée.' });
    expect(conv.messages.at(-2)).toMatchObject({ role: 'history', by: 'claude' });
    expect((await agent.get(`/asks/${id}`).set('Host', HOST)).headers.location).toBe(`/tasks/${taskId}#claude`);

    const say = async (text) => {
      await form(agent, `/tasks/${taskId}/ask`, { text });
      await asks.drain();
      return asks.forTask(taskId).messages;
    };
    await say('ok applique MODE:actmodifier');
    expect(store.getTask(taskId)).toMatchObject({ prompt: 'Lis /host-metrics/disk.txt. Réponds RAS sous 95 %.', cron: '0 * * * *' });
    await say('mets-la en pause MODE:actpause');
    expect(store.getTask(taskId).active).toBe(false);
    await say('archive-la MODE:actarchiver');
    expect(store.getTask(taskId).archived_at).toBeTruthy();
    expect((await agent.get('/archives').set('Host', HOST)).text).toContain('Disque');
    expect((await agent.get(`/tasks/${taskId}`).set('Host', HOST)).text).toContain('Archivée le');
    // Archivée : modifier est refusé, et le fil le dit au lieu de « c'est fait ».
    let msgs = await say('ok applique MODE:actmodifier');
    expect(msgs.at(-1).text).toMatch(/^Je n'ai pas pu le faire : la ronde est archivée/);
    msgs = await say('remets-la active MODE:actrestaurer');
    expect(store.getTask(taskId)).toMatchObject({ archived_at: null, active: true });

    // L'historique dit tout, dans l'ordre, et Claude le relit.
    const hist = msgs.filter((m) => m.role === 'history').map((m) => m.text);
    expect(hist).toHaveLength(5);
    expect(hist[0]).toMatch(/^Ronde « Disque » créée par Claude/);
    expect(hist[1]).toMatch(/prompt modifié/);
    expect(hist[2]).toMatch(/^Mise en pause/);
    expect(hist[3]).toMatch(/^Archivée/);
    expect(hist[4]).toMatch(/^Restaurée .*réactivée/);
    const { tunePrompt } = await import('../server/asks.js');
    const prompt = tunePrompt({ task: store.getTask(taskId), run: null, messages: msgs, timezone: 'Europe/Paris', hostDataDir: '/nope', allowedTools: ['Read'] });
    expect(prompt).toContain('[Historique');
    expect(prompt).toContain('Prompt avant :');

    // Mode debug : l'historique s'affiche.
    expect((await agent.get(`/tasks/${taskId}`).set('Host', HOST)).text).not.toContain('Historique ·');
    await form(agent, '/settings/debug', { debug: '1' });
    expect((await agent.get(`/tasks/${taskId}`).set('Host', HOST)).text).toContain('Historique ·');
  });
});
