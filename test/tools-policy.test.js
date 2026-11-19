import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { setup } from './helpers.js';
import { designPrompt, tunePrompt } from '../server/asks.js';
import { DEFAULT_PROPOSABLE_TOOLS, forbiddenRules, proposableTools } from '../server/tool-policy.js';

const HOST = '127.0.0.1';
const PASSWORD = 'motdepasse-solide';
const form = (agent, url, body = {}) => agent.post(url).set('Host', HOST).set('Origin', `http://${HOST}`).type('form').send(body);

async function admin() {
  const ctx = setup();
  const agent = request.agent(ctx.app);
  await form(agent, '/setup', { setup_code: 'ABCDE-12345', username: 'admin', password: PASSWORD, password_confirm: PASSWORD, alert_email: '' });
  return { ...ctx, agent, asks: ctx.app.locals.asks };
}

/** Ouvre une conversation de conception (question libre → « Créer une ronde »). */
async function designConversation({ agent, asks }) {
  const r = await form(agent, '/asks', { prompt: 'version de PHP et paquets ? MODE:plain' });
  const id = Number(r.headers.location.split('/').pop());
  await asks.drain();
  await form(agent, `/asks/${id}/to-ronde`);
  await asks.drain();
  return id;
}

/** Envoie un message dans la conversation et rend la dernière réponse de Claude. */
async function say({ agent, asks }, id, text) {
  await form(agent, `/asks/${id}/reply`, { text });
  await asks.drain();
  return asks.get(id).messages.at(-1).text;
}

const echoed = (text) => ({
  args: JSON.parse(/^ARGS (.*)$/m.exec(text)[1]),
  prompt: text.slice(text.indexOf('PROMPT ') + 7),
});
const toolsArg = (args) => args[args.indexOf('--tools') + 1];
const ctx = { messages: [], timezone: 'Europe/Paris', hostDataDir: '/nope' };

describe('Outils proposables : liste transmise à Claude', () => {
  it('designPrompt reprend la liste, et dit quoi faire quand le besoin la dépasse', () => {
    const p = designPrompt({ ...ctx, allowedTools: ['Read', 'Bash(php -v)', 'WebFetch'] });
    expect(p).toContain('Outils qu\'une ronde peut utiliser (liste réglée par l\'administrateur) : Read, Bash(php -v), WebFetch.');
    expect(p).toContain('ne dis pas que c\'est impossible');
    expect(p).toContain('Réglages > Outils proposables');
    expect(p).toContain('formulaire manuel');
    expect(p).not.toContain('N\'en propose pas d\'autres');
  });

  it('tunePrompt reprend la liste, plus les règles que la ronde porte déjà', () => {
    const task = { name: 'Disque', prompt: 'p', cron: '', active: true, allowed_tools: ['Read', 'Bash(df:*)'], max_turns: 4, timeout_sec: 300 };
    const p = tunePrompt({ ...ctx, task, run: null, allowedTools: ['Read', 'Grep', 'Glob'] });
    expect(p).toContain('liste réglée par l\'administrateur) : Read, Grep, Glob.');
    expect(p).toContain('Cette ronde porte déjà aussi : Bash(df:*) ; tu peux les garder ou les retirer.');
    expect(p).toContain('Réglages > Outils proposables');
  });

  it('par défaut Read, Grep, Glob ; les règles étroites ne couvrent qu’elles-mêmes', () => {
    const { store } = setup();
    expect(proposableTools(store)).toEqual(DEFAULT_PROPOSABLE_TOOLS);
    expect(DEFAULT_PROPOSABLE_TOOLS).toEqual(['Read', 'Grep', 'Glob']);
    expect(forbiddenRules(['Bash(php -v)', 'Bash(dpkg -l:*)', 'Bash(rm:*)', 'Bash', 'WebFetch'], ['Bash(php -v)', 'Bash(dpkg -l:*)', 'WebFetch'])).toEqual(['Bash(rm:*)', 'Bash']);
    expect(forbiddenRules(['Bash(rm:*)'], ['Bash'])).toEqual([]);
  });

  it('la conception lit le réglage à chaque tour ; les outils de Claude, eux, ne changent pas', async () => {
    const app = await admin();
    const id = await designConversation(app);

    let e = echoed(await say(app, id, 'MODE:echo'));
    expect(e.prompt).toContain('liste réglée par l\'administrateur) : Read, Grep, Glob.');
    expect(toolsArg(e.args)).toBe('Read,Glob,WebFetch');

    // L'administrateur élargit la liste en cours de conversation : vaut dès le tour suivant.
    await form(app.agent, '/settings/tools', { tools: 'Read\nBash(php -v)\nBash(dpkg -l:*)\nWebFetch' });
    e = echoed(await say(app, id, 'et maintenant ? MODE:echo'));
    expect(e.prompt).toContain('liste réglée par l\'administrateur) : Read, Bash(php -v), Bash(dpkg -l:*), WebFetch.');
    // Claude peut proposer Bash pour la ronde, jamais le lancer pendant la conception.
    expect(toolsArg(e.args)).toBe('Read,Glob,WebFetch');
    expect(e.args.join(' ')).not.toContain('Bash');

    // Question libre : toujours Read, Grep, Glob (+ WebFetch), quelle que soit la liste.
    const r = await form(app.agent, '/asks', { prompt: 'MODE:echo' });
    const execId = Number(r.headers.location.split('/').pop());
    await app.asks.drain();
    expect(app.asks.get(execId).allowed_tools).toEqual(['Read', 'Grep', 'Glob']);
    expect(toolsArg(echoed(app.asks.get(execId).result).args)).toBe('Read,Grep,Glob,WebFetch');
  });

  it('le réglage d’une ronde lit aussi la liste à chaque tour', async () => {
    const app = await admin();
    const taskId = app.store.createTask({ name: 'Disque', prompt: 'p', cron: '', allowed_tools: ['Read', 'Bash(df:*)'], max_turns: 2, timeout_sec: 60, active: true });
    await form(app.agent, `/tasks/${taskId}/ask`, { text: 'MODE:echo' });
    await app.asks.drain();
    let e = echoed(app.asks.forTask(taskId).messages.at(-1).text);
    expect(e.prompt).toContain(') : Read, Grep, Glob. Cette ronde porte déjà aussi : Bash(df:*)');
    expect(toolsArg(e.args)).toBe('Read,Glob,WebFetch');

    await form(app.agent, '/settings/tools', { tools: 'Read\nBash(php -v)' });
    await form(app.agent, `/tasks/${taskId}/ask`, { text: 'encore MODE:echo' });
    await app.asks.drain();
    e = echoed(app.asks.forTask(taskId).messages.at(-1).text);
    expect(e.prompt).toContain(') : Read, Bash(php -v). Cette ronde porte déjà aussi : Bash(df:*)');
  });
});

describe('Outils proposables : refus côté serveur', () => {
  it('une proposition hors liste est marquée invalide, sans création ni essai possibles', async () => {
    const app = await admin();
    const id = await designConversation(app);
    await say(app, id, 'MODE:designphp');
    const p = app.asks.get(id).proposal;
    expect(p.error).toContain('outils hors de la liste proposable : Bash(php -v)');
    expect(p.error).toContain('Réglages > Outils proposables');
    const page = (await app.agent.get(`/asks/${id}`).set('Host', HOST)).text;
    expect(page).toContain(`/tasks/new?from_ask=${id}`);
    expect(page).toMatch(/action="\/asks\/\d+\/create"><button type="submit" disabled/);

    const created = await form(app.agent, `/asks/${id}/create`);
    expect(created.status).toBe(302); // proposition invalide : rien à créer
    const tried = await form(app.agent, `/asks/${id}/try`);
    expect(tried.status).toBe(400);
    expect(tried.text).toContain('Essai refusé');
    expect(app.store.listTasks()).toHaveLength(0);

    // Une fois la règle ajoutée par l'administrateur, la même proposition passe.
    await form(app.agent, '/settings/tools', { tools: 'Read\nBash(php -v)' });
    await say(app, id, 'c’est ajouté MODE:designphp');
    expect(app.asks.get(id).proposal.error).toBeNull();
    const ok = await form(app.agent, `/asks/${id}/create`);
    const taskId = Number(ok.headers.location.split('/').pop());
    expect(app.store.getTask(taskId).allowed_tools).toEqual(['Read', 'Bash(php -v)']);
  });

  it('l’action « creer » hors liste est refusée, et le fil le dit', async () => {
    const app = await admin();
    const id = await designConversation(app);
    const text = await say(app, id, 'ok crée-la MODE:actcreerphp');
    expect(text).toMatch(/^Je n'ai pas pu le faire : outils hors de la liste proposable : Bash\(php -v\)/);
    expect(app.asks.get(id).task_id).toBeNull();
    expect(app.store.listTasks()).toHaveLength(0);
  });

  it('liste réduite en cours de conversation : « Créer » sur une proposition affichée avant est refusé', async () => {
    const app = await admin();
    await form(app.agent, '/settings/tools', { tools: 'Read\nBash(php -v)' });
    const id = await designConversation(app);
    await say(app, id, 'MODE:designphp');
    expect(app.asks.get(id).proposal.error).toBeNull(); // valide au moment où elle s'affiche

    await form(app.agent, '/settings/tools', { tools: 'Read\nGrep\nGlob' });
    const res = await form(app.agent, `/asks/${id}/create`);
    expect(res.status).toBe(400);
    expect(res.text).toContain('Création refusée');
    expect(res.text).toContain('Bash(php -v)');
    expect(app.store.listTasks()).toHaveLength(0);
    expect((await form(app.agent, `/asks/${id}/try`)).status).toBe(400);
  });

  it('réglage d’une ronde : ses règles restent permises, on n’en ajoute pas hors liste', async () => {
    const app = await admin();
    const taskId = app.store.createTask({ name: 'Disque', prompt: 'df -h', cron: '0 * * * *', allowed_tools: ['Read', 'Bash(df:*)'], max_turns: 2, timeout_sec: 60, active: true });
    const talk = async (text) => {
      await form(app.agent, `/tasks/${taskId}/ask`, { text });
      await app.asks.drain();
      return app.asks.forTask(taskId).messages.at(-1).text;
    };

    // Garder Bash(df:*) : permis.
    expect(await talk('ok applique MODE:actmodifierdf')).toBe('C’est fait : seuil à 95 %.');
    expect(app.store.getTask(taskId)).toMatchObject({ prompt: 'df -h. RAS sous 95 %.', allowed_tools: ['Read', 'Bash(df:*)'] });

    // Ajouter Bash(php -v), hors liste : refusé.
    expect(await talk('ajoute php MODE:actmodifierphp')).toMatch(/^Je n'ai pas pu le faire : outils hors de la liste proposable : Bash\(php -v\)/);
    expect(app.store.getTask(taskId).allowed_tools).toEqual(['Read', 'Bash(df:*)']);

    // Retirer Read et garder Bash(df:*) via le bouton « Appliquer » : permis.
    await talk('propose MODE:tunepdf');
    expect(app.asks.forTask(taskId).proposal.error).toBeNull();
    const applied = await form(app.agent, `/asks/${app.asks.forTask(taskId).id}/apply`);
    expect(applied.headers.location).toBe(`/tasks/${taskId}?tuned=1`);
    expect(app.store.getTask(taskId).allowed_tools).toEqual(['Bash(df:*)']);
  });

  it('« Appliquer » relit la liste et les règles de la ronde au clic', async () => {
    const app = await admin();
    await form(app.agent, '/settings/tools', { tools: 'Read\nBash(df:*)' });
    const taskId = app.store.createTask({ name: 'Disque', prompt: 'p', cron: '', allowed_tools: ['Read'], max_turns: 2, timeout_sec: 60, active: true });
    await form(app.agent, `/tasks/${taskId}/ask`, { text: 'propose MODE:tunepdf' });
    await app.asks.drain();
    expect(app.asks.forTask(taskId).proposal.error).toBeNull();

    await form(app.agent, '/settings/tools', { tools: 'Read' });
    const res = await form(app.agent, `/asks/${app.asks.forTask(taskId).id}/apply`);
    expect(res.headers.location).toBe(`/tasks/${taskId}?claude=refused#claude`);
    expect(app.store.getTask(taskId).allowed_tools).toEqual(['Read']);
    const page = (await app.agent.get(`/tasks/${taskId}?claude=refused`).set('Host', HOST)).text;
    expect(page).toContain('hors de la liste proposable');
  });

  it('la page Réglages montre la liste hors section MCP, avec les avertissements', async () => {
    const app = await admin();
    const res = await form(app.agent, '/settings/tools', { tools: 'Bash(php -v)\nrm -rf' });
    expect(res.status).toBe(400);
    expect(proposableTools(app.store)).toEqual(['Read', 'Grep', 'Glob']);
    const page = (await app.agent.get('/settings').set('Host', HOST)).text;
    expect(page).toContain('Outils proposables');
    expect(page).toContain('test_prompt');
    expect(page).toContain('déverrouille la modification par MCP');
    expect(page).toContain('autorise toutes les règles de cet outil');
  });
});

describe('Outil manquant : bouton d’ajout', () => {
  it('seules les règles étroites peuvent devenir un bouton', async () => {
    const { isNarrowRule } = await import('../server/tool-policy.js');
    for (const r of ['Bash(php -m)', 'Bash(dpkg -l:*)', 'WebFetch(domain:php.net)']) expect(isNarrowRule(r)).toBe(true);
    for (const r of ['Bash', 'WebFetch', 'Bash(*)', 'Bash(:*)', 'Bash( )', 'Bash()', 'rm -rf', '']) expect(isNarrowRule(r)).toBe(false);
  });

  it('conception : Claude signale la règle, l’administrateur clique, la conversation reprend', async () => {
    const app = await admin();
    const id = await designConversation(app);
    await say(app, id, 'fais un php -m MODE:manque');
    // Claude ne touche pas à la liste ; seule la règle étroite est retenue.
    expect(proposableTools(app.store)).toEqual(['Read', 'Grep', 'Glob']);
    expect(app.asks.get(id).messages.at(-1).missing).toEqual(['Bash(php -m)']);
    expect(app.asks.get(id).missing_tools).toEqual(['Bash(php -m)']);
    const page = (await app.agent.get(`/asks/${id}`).set('Host', HOST)).text;
    expect(page).toContain(`action="/asks/${id}/tools"`);
    expect(page).toContain('Ajouter <code>Bash(php -m)</code>');
    expect(page).not.toContain('Ajouter <code>Bash</code>');

    // Une règle que Claude n'a pas signalée, ou trop large, ne passe pas par ce bouton.
    for (const rule of ['Bash', 'Bash(rm:*)']) {
      await form(app.agent, `/asks/${id}/tools`, { rule });
      expect(proposableTools(app.store)).toEqual(['Read', 'Grep', 'Glob']);
    }

    await form(app.agent, `/asks/${id}/tools`, { rule: 'Bash(php -m)' });
    await app.asks.drain();
    expect(proposableTools(app.store)).toEqual(['Read', 'Grep', 'Glob', 'Bash(php -m)']);
    const msgs = app.asks.get(id).messages;
    expect(msgs.at(-2)).toMatchObject({ role: 'user', text: 'J\'ai ajouté Bash(php -m) aux outils proposables.' });
    expect(msgs.at(-1).role).toBe('claude');
    expect(app.asks.get(id).missing_tools).toEqual([]);
    expect((await app.agent.get(`/asks/${id}`).set('Host', HOST)).text).not.toContain(`/asks/${id}/tools`);
  });

  it('question libre : le bouton ajoute la règle et passe en conception', async () => {
    const app = await admin();
    const r = await form(app.agent, '/asks', { prompt: 'fais un php -m MODE:execmanque' });
    const id = Number(r.headers.location.split('/').pop());
    await app.asks.drain();
    expect(app.asks.get(id)).toMatchObject({ kind: 'exec', suggest_ronde: true, missing_tools: ['Bash(php -m)'] });
    expect((await app.agent.get(`/asks/${id}`).set('Host', HOST)).text).toContain('Ajouter <code>Bash(php -m)</code>');

    await form(app.agent, `/asks/${id}/tools`, { rule: 'Bash(php -m)' });
    await app.asks.drain();
    expect(proposableTools(app.store)).toContain('Bash(php -m)');
    expect(app.asks.get(id).kind).toBe('design');
    expect(app.asks.get(id).messages.find((m) => m.text?.startsWith('J\'ai ajouté')).text).toBe('J\'ai ajouté Bash(php -m) aux outils proposables. Fais-en une ronde.');
  });

  it('le prompt d’une question libre donne la liste proposable et la consigne « manque »', async () => {
    const { execPrompt } = await import('../server/asks.js');
    const p = execPrompt({ text: 'php -m ?', hostDataDir: '/nope', tools: ['Read'], proposable: ['Read', 'Bash(php -v)'] });
    expect(p).toContain('Tu ne peux lancer aucune commande ici.');
    expect(p).toContain('liste réglée par l\'administrateur) : Read, Bash(php -v).');
    expect(p).toContain('"manque"');
    expect(designPrompt({ ...ctx, allowedTools: ['Read'] })).toContain('Tu ne peux pas l\'ajouter toi-même.');
  });

  it('réglage d’une ronde : le bouton s’affiche dans le panneau Claude', async () => {
    const app = await admin();
    const taskId = app.store.createTask({ name: 'PHP', prompt: 'p', cron: '', allowed_tools: ['Read'], max_turns: 2, timeout_sec: 60, active: true });
    await form(app.agent, `/tasks/${taskId}/ask`, { text: 'ajoute php -m MODE:tunemanque' });
    await app.asks.drain();
    const conv = app.asks.forTask(taskId);
    expect((await app.agent.get(`/tasks/${taskId}`).set('Host', HOST)).text).toContain('Ajouter <code>Bash(php -m)</code>');
    const res = await form(app.agent, `/asks/${conv.id}/tools`, { rule: 'Bash(php -m)' });
    expect(res.headers.location).toBe(`/tasks/${taskId}#claude`);
    await app.asks.drain();
    expect(proposableTools(app.store)).toContain('Bash(php -m)');
    expect(app.asks.forTask(taskId).kind).toBe('tune');
  });
});
