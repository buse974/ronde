import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { normalizeConfig, parseRecipients } from '../server/channels.js';
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

  it('valide un canal SMTP : hôte, port, TLS, expéditeur, destinataires facultatifs', () => {
    const o365 = normalizeConfig('smtp', { target: 'smtp.office365.com', user: 'monitoring@exemple.fr', token: 'mdp-secret' });
    expect(o365.config).toEqual({ host: 'smtp.office365.com', port: 587, secure: false, user: 'monitoring@exemple.fr', pass: 'mdp-secret', from: 'monitoring@exemple.fr', to: [] });
    expect(o365.preview).toBe('monitoring@exemple.fr via smtp.office365.com:587 · destinataires donnés par chaque ronde');
    expect(o365.preview).not.toContain('mdp-secret');
    const tls = normalizeConfig('smtp', { target: 'mail.exemple.fr:465', from: 'ronde@exemple.fr', to: 'a@b.fr; c@d.fr' });
    expect(tls.config).toMatchObject({ host: 'mail.exemple.fr', port: 465, secure: true, from: 'ronde@exemple.fr', to: ['a@b.fr', 'c@d.fr'] });
    expect(tls.preview).toBe('ronde@exemple.fr via mail.exemple.fr:465 → a@b.fr, c@d.fr');
    expect(normalizeConfig('smtp', { target: 'mail.exemple.fr:465', port: '2525', from: 'r@exemple.fr' }).config).toMatchObject({ port: 2525, secure: false });
    expect(() => normalizeConfig('smtp', { target: 'smtp.exemple.fr', user: 'monitoring' })).toThrow(/adresse expéditrice requise/);
    expect(() => normalizeConfig('smtp', { target: 'smtp.exemple.fr', from: 'pas-une-adresse' })).toThrow(/adresse expéditrice invalide/);
    expect(() => normalizeConfig('smtp', { target: 'smtps://smtp.exemple.fr', from: 'r@exemple.fr' })).toThrow(/sans schéma/);
    expect(() => normalizeConfig('smtp', { target: 'smtp.exemple.fr', port: 70000, from: 'r@exemple.fr' })).toThrow(/port SMTP invalide/);
    expect(() => normalizeConfig('smtp', { target: '', from: 'r@exemple.fr' })).toThrow(/hôte SMTP requis/);
    expect(() => normalizeConfig('sms', {})).toThrow(/mail, smtp, slack, teams, webhook, api/);
    expect(parseRecipients(['a@b.fr', 'c@d.fr a@b.fr'])).toEqual(['a@b.fr', 'c@d.fr']);
    expect(() => parseRecipients('a@b.fr, nope')).toThrow(/adresse invalide : nope/);
  });

  it('crée un canal SMTP dans les réglages : test à l’expéditeur, mot de passe chiffré et jamais réaffiché', async () => {
    const { agent, store, smtpSent, channels } = await admin();
    const page = await form(agent, '/settings/channels', {
      name: 'Office 365', type: 'smtp', target: 'smtp.office365.com', port: '587', user: 'monitoring@exemple.fr', pass: 'mdp-tres-secret', from: '', to: '',
    });
    expect(page.text).toContain('le message de test est parti');
    expect(smtpSent).toHaveLength(1);
    expect(smtpSent[0].options).toMatchObject({ host: 'smtp.office365.com', port: 587, secure: false, requireTLS: true, user: 'monitoring@exemple.fr', pass: 'mdp-tres-secret' });
    expect(smtpSent[0].mail).toMatchObject({ from: 'monitoring@exemple.fr', to: 'monitoring@exemple.fr', subject: '[ronde] Test du canal « Office 365 »' });
    expect(page.text).not.toContain('mdp-tres-secret');
    expect(JSON.stringify(store.db.prepare('SELECT * FROM channels').all())).not.toContain('mdp-tres-secret');
    expect(channels.findByName('Office 365')).toMatchObject({ type: 'smtp', typeLabel: 'SMTP' });

    // Réenregistré sans mot de passe (nouveaux destinataires par défaut) : l'ancien est gardé.
    await form(agent, '/settings/channels', { name: 'Office 365', type: 'smtp', target: 'smtp.office365.com', user: 'monitoring@exemple.fr', pass: '', to: 'equipe@exemple.fr' });
    expect(smtpSent.at(-1).options.pass).toBe('mdp-tres-secret');
    expect(smtpSent.at(-1).mail.to).toBe('equipe@exemple.fr');
    expect(channels.findByName('Office 365').preview).toBe('monitoring@exemple.fr via smtp.office365.com:587 → equipe@exemple.fr');

    // Échec d'envoi : noté, sans mot de passe.
    smtpSent.fail = 'Invalid login: 535 5.7.139 Authentication unsuccessful';
    const ko = await form(agent, `/settings/channels/${channels.findByName('Office 365').id}/test`);
    expect(ko.text).toContain('Le test a échoué : Invalid login');
    const bad = await form(agent, '/settings/channels', { name: 'Y', type: 'smtp', target: 'smtp.exemple.fr', user: 'monitoring' });
    expect(bad.status).toBe(400);
    expect(bad.text).toContain('adresse expéditrice requise');
  });

  it('deux rondes sur le même canal SMTP écrivent chacune à leurs destinataires', async () => {
    const { agent, store, executor, channels, smtpSent } = await admin();
    const smtp = channels.save({ name: 'Office 365', type: 'smtp', target: 'smtp.office365.com:587', user: 'monitoring@exemple.fr', token: 'mdp' });
    const a = ronde(store, { name: 'Disque', prompt: 'MODE:alert' });
    const b = ronde(store, { name: 'Sauvegardes', prompt: 'MODE:alert' });
    expect(() => channels.setForTask(a, [{ name: 'Office 365', mode: 'alert' }])).toThrow(/n'a pas de destinataire par défaut/);
    expect(() => channels.setForTask(a, [{ name: 'Office 365', mode: 'alert', recipients: 'pas-une-adresse' }])).toThrow(/adresse invalide/);
    channels.setForTask(a, [{ name: 'Office 365', mode: 'alert', recipients: ['infra@exemple.fr', 'astreinte@exemple.fr'] }]);
    // Depuis la popup Configuration, pour la seconde.
    await form(agent, `/tasks/${b}/channels`, { [`mode_${smtp.id}`]: 'alert', [`to_${smtp.id}`]: 'compta@exemple.fr' });
    expect(channels.forTask(b)[0].recipients).toEqual(['compta@exemple.fr']);
    // Sans destinataire dans la popup : une page d'erreur, pas une erreur 500.
    const ko = await form(agent, `/tasks/${b}/channels`, { [`mode_${smtp.id}`]: 'alert', [`to_${smtp.id}`]: '' });
    expect(ko.status).toBe(400);
    expect(ko.text).toContain('donne les destinataires de cette ronde');
    expect(channels.forTask(b)[0].recipients).toEqual(['compta@exemple.fr']);
    expect((await agent.get(`/tasks/${b}`).set('Host', HOST)).text).toContain('à compta@exemple.fr');

    await executor.start(store.getTask(a), 'manual').done;
    await executor.start(store.getTask(b), 'manual').done;
    expect(smtpSent.map((s) => [s.mail.from, s.mail.to, s.mail.subject])).toEqual([
      ['monitoring@exemple.fr', 'infra@exemple.fr, astreinte@exemple.fr', '[ronde] Alerte : Disque'],
      ['monitoring@exemple.fr', 'compta@exemple.fr', '[ronde] Alerte : Sauvegardes'],
    ]);
  });

  it('canal mail : les destinataires de la ronde remplacent ceux du canal, et l’historique le note', async () => {
    const { store, executor, channels, mailer } = await admin();
    channels.save({ name: 'Mail équipe', type: 'mail', target: 'equipe@exemple.fr' });
    const id = ronde(store, { prompt: 'MODE:alert' });
    channels.setForTask(id, [{ name: 'Mail équipe', mode: 'alert' }]);
    await executor.start(store.getTask(id), 'manual').done;
    expect(mailer.sent.at(-1).to).toBe('equipe@exemple.fr');

    channels.setForTask(id, [{ name: 'Mail équipe', mode: 'alert', recipients: 'a@b.fr' }]);
    await executor.start(store.getTask(id), 'manual').done;
    expect(mailer.sent.at(-1).to).toBe('a@b.fr');
    const hist = store.db.prepare('SELECT messages FROM asks WHERE task_id = ?').get(id).messages;
    expect(hist).toContain('Mail équipe (en cas d’alerte) → Mail équipe (en cas d’alerte, à a@b.fr)');

    const { channelsContext } = await import('../server/asks.js');
    const ctx = channelsContext(channels.list(), channels.forTask(id));
    expect(ctx).toContain('Un canal Mail ou SMTP peut recevoir des destinataires propres à la ronde');
    expect(ctx).toContain('Canaux de cette ronde : « Mail équipe » (en cas d’alerte, à a@b.fr)');
  });

  it('un canal en échec n’empêche pas les autres', async () => {
    const { store, executor, channels, smtpSent, mailer } = await admin();
    channels.save({ name: 'Office 365', type: 'smtp', target: 'smtp.office365.com', user: 'monitoring@exemple.fr', token: 'mdp' });
    channels.save({ name: 'Mail équipe', type: 'mail', target: 'equipe@exemple.fr' });
    const id = ronde(store, { prompt: 'MODE:alert' });
    channels.setForTask(id, [{ name: 'Office 365', mode: 'alert', recipients: ['x@exemple.fr'] }, { name: 'Mail équipe', mode: 'alert' }]);
    smtpSent.fail = 'connexion refusée';
    await executor.start(store.getTask(id), 'manual').done;
    expect(mailer.sent.at(-1).to).toBe('equipe@exemple.fr');
  });
});
