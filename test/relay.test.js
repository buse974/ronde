import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createChannels, requestKey } from '../server/channels.js';
import { RELAY_TOOL } from '../server/relay.js';
import { buildArgs } from '../server/runner.js';
import { setup } from './helpers.js';

const KEY = 'CLE-SECRETE-0123456789';

/** Canaux avec un faux réseau qui renvoie la clé dans sa réponse (pour vérifier le masquage). */
function apiChannels() {
  const ctx = setup();
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), method: init.method, headers: init.headers, body: init.body });
    return new Response(JSON.stringify({ ok: true, echo: KEY }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const channels = createChannels({ store: ctx.store, appSecret: 's', mailer: ctx.mailer, config: ctx.config, fetchImpl, log: { error() {} } });
  return { channels, calls };
}

async function rpc(app, token, method, params = {}) {
  return request(app)
    .post('/relay/mcp')
    .set('Authorization', `Bearer ${token}`)
    .set('Accept', 'application/json, text/event-stream')
    .send({ jsonrpc: '2.0', id: 1, method, params });
}

describe('canal API', () => {
  it('ajoute la clé là où le canal le dit, et la masque dans la réponse', async () => {
    const { channels, calls } = apiChannels();
    channels.save({ name: 'Bearer', type: 'api', target: 'https://api.exemple.fr/v1', token: KEY, place: 'bearer' });
    channels.save({ name: 'Entete', type: 'api', target: 'https://api.exemple.fr', token: KEY, place: 'header', keyName: 'X-API-Key' });
    channels.save({ name: 'Url', type: 'api', target: 'https://api.exemple.fr', token: KEY, place: 'query', keyName: 'apikey' });
    channels.save({ name: 'Corps', type: 'api', target: 'https://home.exemple.fr', token: KEY, place: 'body' });

    const r = await channels.call('Bearer', { methode: 'GET', chemin: '/etat' });
    expect(calls.at(-1)).toMatchObject({ url: 'https://api.exemple.fr/v1/etat', method: 'GET' });
    expect(calls.at(-1).headers.authorization).toBe(`Bearer ${KEY}`);
    expect(r).toMatchObject({ statut: 200, type: 'application/json' });
    expect(r.reponse).not.toContain(KEY);
    expect(r.reponse).toContain('•••');

    await channels.call('Entete', { chemin: '/x' });
    expect(calls.at(-1).headers['x-api-key']).toBe(KEY);
    await channels.call('Url', { chemin: '/x?a=1' });
    expect(calls.at(-1).url).toBe(`https://api.exemple.fr/x?a=1&apikey=${KEY}`);
    await channels.call('Corps', { methode: 'POST', chemin: '/core/api/jeeApi.php', corps: { method: 'cmd::execCmd', params: { apikey: '{{cle}}', id: 161 } } });
    expect(JSON.parse(calls.at(-1).body).params).toEqual({ apikey: KEY, id: 161 });
    expect(calls.at(-1).headers['content-type']).toBe('application/json');
  });

  it('refuse un chemin qui sort de l’URL du canal', async () => {
    const { channels, calls } = apiChannels();
    channels.save({ name: 'Api', type: 'api', target: 'https://api.exemple.fr/v1', token: KEY, place: 'bearer' });
    for (const chemin of ['https://evil.com/x', '//evil.com/x', '/../admin', '/%2e%2e/admin']) {
      await expect(channels.call('Api', { chemin })).rejects.toThrow(/chemin/);
    }
    expect(calls).toHaveLength(0);
  });

  it('compare les requêtes enregistrées sans tenir compte de l’ordre des clés', () => {
    expect(requestKey({ methode: 'post', chemin: '/a', corps: { b: 1, a: { d: 2, c: 3 } } })).toBe(requestKey({ methode: 'POST', chemin: '/a', corps: '{"a":{"c":3,"d":2},"b":1}' }));
    expect(requestKey({ methode: 'POST', chemin: '/a', corps: { id: 161 } })).not.toBe(requestKey({ methode: 'POST', chemin: '/a', corps: { id: 160 } }));
  });
});

describe('relais des canaux', () => {
  it('donne l’outil appeler_canal, limité aux requêtes enregistrées pendant un passage', async () => {
    const { app, channels, relay, posts } = setup();
    channels.save({ name: 'Maison', type: 'api', target: 'https://home.exemple.fr', token: KEY, place: 'body' });
    const off = { canal: 'Maison', methode: 'POST', chemin: '/core/api/jeeApi.php', corps: { method: 'cmd::execCmd', params: { apikey: '{{cle}}', id: 161 } } };
    const { canal, ...enregistree } = off;
    const session = relay.open({ label: 'test', allowed: [{ name: 'Maison', free: false, requests: [enregistree] }] });
    const token = JSON.parse(session.mcpConfig).mcpServers.canaux.headers.Authorization.replace('Bearer ', '');
    expect(JSON.parse(session.mcpConfig).mcpServers.canaux.url).toBe(`http://127.0.0.1:${setup().config.port}/relay/mcp`);

    const list = await rpc(app, token, 'tools/list');
    expect(list.body.result.tools.map((t) => t.name)).toEqual(['appeler_canal']);

    const okCall = await rpc(app, token, 'tools/call', { name: 'appeler_canal', arguments: off });
    expect(okCall.body.result.isError, okCall.body.result.content[0].text).toBeFalsy();
    expect(posts.at(-1).body.params).toEqual({ apikey: KEY, id: 161 });

    const other = await rpc(app, token, 'tools/call', { name: 'appeler_canal', arguments: { ...off, corps: { ...off.corps, params: { apikey: '{{cle}}', id: 999 } } } });
    expect(other.body.result.isError).toBe(true);
    expect(other.body.result.content[0].text).toMatch(/Requête non enregistrée/);
    const unknown = await rpc(app, token, 'tools/call', { name: 'appeler_canal', arguments: { ...off, canal: 'Banque' } });
    expect(unknown.body.result.content[0].text).toMatch(/non permis/);
    expect(posts).toHaveLength(1);
    expect(session.calls).toEqual([{ canal: 'Maison', methode: 'POST', chemin: '/core/api/jeeApi.php', statut: 200 }]);

    // Jeton inconnu, ou session fermée : refusé.
    expect((await rpc(app, 'faux', 'tools/list')).status).toBe(403);
    session.close();
    expect((await rpc(app, token, 'tools/list')).status).toBe(403);
    expect(relay.openSessions).toBe(0);
  });

  it('un passage d’une ronde avec un canal API reçoit le relais, et seulement lui', async () => {
    const args = buildArgs({ allowedTools: ['Read', RELAY_TOOL], maxTurns: 3, mcpConfig: '{"mcpServers":{}}' });
    expect(args).toEqual(expect.arrayContaining(['--tools', 'Read', '--mcp-config', '{"mcpServers":{}}', '--strict-mcp-config', '--allowedTools', 'Read', RELAY_TOOL]));
    expect(args[args.indexOf('--tools') + 1]).toBe('Read'); // pas d'outil MCP dans --tools

    const { store, channels, executor, relay } = setup();
    channels.save({ name: 'Maison', type: 'api', target: 'https://home.exemple.fr', token: KEY, place: 'body' });
    const id = store.createTask({ name: 'Lumière', prompt: 'MODE:env', cron: '', allowed_tools: ['Read'], max_turns: 2, timeout_sec: 60, active: true, notify: false });
    channels.setForTask(id, [{ name: 'Maison', mode: 'requests', requests: [{ methode: 'POST', chemin: '/x' }] }]);
    const run = executor.start(store.getTask(id), 'manual');
    await run.done;
    const seen = JSON.parse(store.getRun(run.runId).result);
    expect(seen.args).toEqual(expect.arrayContaining(['--mcp-config', '--strict-mcp-config', RELAY_TOOL]));
    expect(JSON.stringify(seen)).not.toContain(KEY);
    expect(relay.openSessions).toBe(0); // session fermée après le passage

    // Sans canal API : pas de relais.
    const id2 = store.createTask({ name: 'Disque', prompt: 'MODE:env', cron: '', allowed_tools: ['Read'], max_turns: 2, timeout_sec: 60, active: true, notify: false });
    const run2 = executor.start(store.getTask(id2), 'manual');
    await run2.done;
    expect(JSON.parse(store.getRun(run2.runId).result).args).not.toContain('--mcp-config');
  });
});
