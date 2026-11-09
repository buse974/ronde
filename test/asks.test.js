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
    expect(p).toContain('/host-metrics');
    expect(p).toContain('Outils disponibles : Read');
    expect(p.trim().endsWith('espace disque ?')).toBe(true);
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
    expect(page.text).not.toContain('créer une ronde');
  });

  it('propose d’en faire une ronde, puis conçoit, préremplit et essaie', async () => {
    const { agent, asks } = await admin();
    const res = await form(agent, '/asks', { prompt: 'espace disque dispo ? MODE:suggest' });
    const execId = Number(res.headers.location.split('/').pop());
    await asks.drain();
    expect(asks.get(execId)).toMatchObject({ suggest_ronde: true, result: 'Il reste 36 Go libres sur 74 Go (47 %).' });
    expect((await agent.get(`/asks/${execId}`).set('Host', HOST)).text).toContain('Oui, créer une ronde');

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

  it('une seule demande à la fois', async () => {
    const { agent, asks } = await admin();
    await form(agent, '/asks', { prompt: 'MODE:ok' });
    const second = await form(agent, '/asks', { prompt: 'MODE:ok' });
    expect(second.headers.location).toBe('/tasks?busy=1#demander');
    await asks.drain();
  });
});
