import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { normalizeConfig } from '../server/channels.js';
import { setup } from './helpers.js';

const HOST = '127.0.0.1';
const PASSWORD = 'motdepasse-solide';
const form = (agent, url, body = {}) => agent.post(url).set('Host', HOST).set('Origin', `http://${HOST}`).type('form').send(body);
const SLACK = 'https://hooks.slack.com/services/T000/B000/secretsecret';

async function admin() {
  const ctx = setup();
  const agent = request.agent(ctx.app);
  await form(agent, '/setup', { setup_code: 'ABCDE-12345', username: 'admin', password: PASSWORD, password_confirm: PASSWORD, alert_email: '' });
  return { ...ctx, agent, asks: ctx.app.locals.asks };
}
const ronde = (store, over = {}) =>
  store.createTask({ name: 'Disque', prompt: 'MODE:ok', cron: '0 * * * *', allowed_tools: ['Read'], max_turns: 2, timeout_sec: 60, active: true, ...over });

describe('canaux', () => {
  it('valide la configuration de chaque type', () => {
    expect(normalizeConfig('mail', { target: 'a@b.fr, c@d.fr ; a@b.fr' }).config.to).toEqual(['a@b.fr', 'c@d.fr']);
    expect(() => normalizeConfig('mail', { target: 'pas-un-mail' })).toThrow(/adresse invalide/);
    expect(() => normalizeConfig('slack', { target: 'https://evil.com/x' })).toThrow(/hooks.slack.com/);
    expect(() => normalizeConfig('teams', { target: 'http://x.fr/hook' })).toThrow(/https/);
    expect(normalizeConfig('webhook', { target: 'http://192.168.1.10/hook', token: 'abc' }).config).toEqual({ url: 'http://192.168.1.10/hook', token: 'abc' });
    expect(normalizeConfig('slack', { target: SLACK }).preview).not.toContain('secretsecret');
    expect(() => normalizeConfig('sms', {})).toThrow(/type de canal inconnu/);
  });

  it('se crée et se teste dans les réglages, accès chiffrés et masqués', async () => {
    const { agent, store, posts } = await admin();
    const page = await form(agent, '/settings/channels', { name: 'Slack équipe', type: 'slack', target: SLACK });
    expect(page.text).toContain('le message de test est parti');
    expect(posts.at(-1)).toMatchObject({ url: SLACK, body: { text: expect.stringContaining('Test du canal « Slack équipe »') } });
    expect(page.text).not.toContain('secretsecret');
    expect(JSON.stringify(store.db.prepare('SELECT * FROM channels').all())).not.toContain('secretsecret'); // chiffré

    const ko = await form(agent, '/settings/channels', { name: 'Webhook cassé', type: 'webhook', target: 'https://exemple.fr/echec' });
    expect(ko.text).toContain('le test a échoué : HTTP 500');
    const bad = await form(agent, '/settings/channels', { name: 'X', type: 'slack', target: 'https://evil.com' });
    expect(bad.status).toBe(400);
  });

  it('envoie selon le mode : à chaque passage, ou en cas d’alerte seulement', async () => {
    const { agent, store, executor, channels, posts, mailer } = await admin();
    const slack = channels.save({ name: 'Slack', type: 'slack', target: SLACK });
    const teams = channels.save({ name: 'Teams', type: 'teams', target: 'https://prod.exemple.com/workflows/abc' });
    const hook = channels.save({ name: 'Jeedom', type: 'webhook', target: 'http://192.168.1.10/hook', token: 'jeton' });
    const mail = channels.save({ name: 'Mail équipe', type: 'mail', target: 'equipe@exemple.fr' });
    const id = ronde(store);
    // Depuis la popup Configuration.
    await form(agent, `/tasks/${id}/channels`, { [`mode_${slack.id}`]: 'always', [`mode_${teams.id}`]: 'alert', [`mode_${hook.id}`]: 'always', [`mode_${mail.id}`]: 'alert' });
    expect(channels.forTask(id).map((c) => [c.name, c.mode])).toEqual([['Jeedom', 'always'], ['Mail équipe', 'alert'], ['Slack', 'always'], ['Teams', 'alert']]);

    posts.length = 0;
    await executor.start(store.getTask(id), 'manual').done; // RAS
    expect(posts.map((p) => p.url).sort()).toEqual(['http://192.168.1.10/hook', SLACK]);
    const webhook = posts.find((p) => p.url.includes('192.168'));
    expect(webhook.headers.authorization).toBe('Bearer jeton');
    expect(webhook.body).toMatchObject({ source: 'ronde', ronde: 'Disque', statut: 'ok', libelle: 'RAS', texte: 'RAS' });
    expect(mailer.sent).toHaveLength(0);

    posts.length = 0;
    store.updateTask(id, { ...store.getTask(id), prompt: 'MODE:alert' });
    const run = await executor.start(store.getTask(id), 'manual');
    await run.done;
    expect(posts).toHaveLength(3); // Slack, Teams, Jeedom
    const card = posts.find((p) => p.url.includes('workflows')).body;
    expect(card.attachments[0].contentType).toBe('application/vnd.microsoft.card.adaptive');
    expect(card.attachments[0].content.actions[0].url).toBe(`http://127.0.0.1/runs/${run.runId}`);
    expect(mailer.sent.at(-1)).toMatchObject({ to: 'equipe@exemple.fr', subject: '[ronde] Alerte : Disque' });
    expect(store.getRun(run.runId).alert_sent).toBe(1);

    // L'historique de la ronde le note.
    const hist = store.db.prepare('SELECT messages FROM asks WHERE task_id = ?').get(id).messages;
    expect(hist).toContain('Canaux modifiés depuis l’interface');
  });

  it('sans canal, le mail d’alerte par défaut reste la règle', async () => {
    const { store, executor, mailer, posts } = await admin();
    store.setSetting('alert_email', 'moi@exemple.fr');
    const id = ronde(store, { prompt: 'MODE:alert' });
    await executor.start(store.getTask(id), 'manual').done;
    expect(mailer.sent.at(-1)).toMatchObject({ to: 'moi@exemple.fr' });
    expect(posts).toHaveLength(0);
  });

  it('Claude branche un canal existant sur accord, jamais un canal inconnu', async () => {
    const { agent, asks, store, channels } = await admin();
    channels.save({ name: 'Slack', type: 'slack', target: SLACK });
    const id = ronde(store);
    const say = async (text) => {
      await form(agent, `/tasks/${id}/ask`, { text });
      await asks.drain();
      return asks.forTask(id).messages;
    };
    await say('envoie sur Slack à chaque passage MODE:actcanaux');
    expect(channels.forTask(id).map((c) => [c.name, c.mode])).toEqual([['Slack', 'always']]);
    const msgs = await say('et sur Discord MODE:actcanauxinconnu');
    expect(msgs.at(-1).text).toMatch(/^Je n'ai pas pu le faire : canal « Discord » introuvable/);
    expect(channels.forTask(id)).toHaveLength(1);

    const { tunePrompt } = await import('../server/asks.js');
    const p = tunePrompt({ task: store.getTask(id), run: null, messages: [], timezone: 'Europe/Paris', hostDataDir: '/nope', allowedTools: ['Read'], channels: channels.list(), taskChannels: channels.forTask(id) });
    expect(p).toContain('« Slack » (Slack)');
    expect(p).toContain('Canaux de cette ronde : « Slack » (à chaque passage)');
    expect(p).not.toContain('secretsecret');
  });
});
