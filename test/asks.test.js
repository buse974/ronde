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

  it('exécute une demande ponctuelle et l’affiche', async () => {
    const { agent, asks, store } = await admin();
    const res = await form(agent, '/asks', { prompt: 'MODE:alert combien de place ?', action: 'exec', tools: ['Read', 'Bash'] });
    const url = res.headers.location;
    expect(url).toMatch(/^\/asks\/\d+$/);
    await asks.drain();
    const ask = asks.get(Number(url.split('/').pop()));
    expect(ask).toMatchObject({ kind: 'exec', status: 'done', result: 'Disque / à 92 %', is_ras: false, allowed_tools: ['Read'] }); // Bash ignoré
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM runs').get().n).toBe(0); // pas une ronde
    const page = await agent.get(url).set('Host', HOST);
    expect(page.text).toContain('Disque / à 92 %');
    expect((await agent.get('/tasks').set('Host', HOST)).text).toContain('combien de place');
  });

  it('conçoit une ronde : question, réponse, proposition, formulaire prérempli', async () => {
    const { agent, asks } = await admin();
    const res = await form(agent, '/asks', { prompt: 'surveille fail2ban MODE:designq', action: 'design' });
    const id = Number(res.headers.location.split('/').pop());
    await asks.drain();
    expect(asks.get(id)).toMatchObject({ status: 'question' });
    expect((await agent.get(`/asks/${id}`).set('Host', HOST)).text).toContain('quel pic');

    await form(agent, `/asks/${id}/reply`, { text: '3 fois la moyenne MODE:designp' });
    await asks.drain();
    const ask = asks.get(id);
    expect(ask.status).toBe('proposal');
    expect(ask.messages.map((m) => m.role)).toEqual(['user', 'claude', 'user', 'claude']);
    expect(ask.proposal).toMatchObject({ name: 'Sécurité SSH', cron: '5 * * * *', allowed_tools: ['Read'] });

    const formPage = await agent.get(`/tasks/new?from_ask=${id}`).set('Host', HOST);
    expect(formPage.text).toContain('value="Sécurité SSH"');
    expect(formPage.text).toContain('Proposition de Claude préremplie');

    const tryRes = await form(agent, `/asks/${id}/try`);
    await asks.drain();
    expect(asks.get(Number(tryRes.headers.location.split('/').pop()))).toMatchObject({ kind: 'exec', status: 'done' });
  });

  it('une seule demande à la fois', async () => {
    const { agent, asks } = await admin();
    await form(agent, '/asks', { prompt: 'MODE:ok', action: 'exec' });
    const second = await form(agent, '/asks', { prompt: 'MODE:ok', action: 'exec' });
    expect(second.headers.location).toBe('/tasks?busy=1#demander');
    await asks.drain();
  });
});
