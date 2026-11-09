import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { setup, OAUTH } from './helpers.js';
import { isAllowedRedirect } from '../server/oauth.js';

const HOST = '127.0.0.1';
const ORIGIN = `http://${HOST}`;
const PASSWORD = 'motdepasse-solide';
const REDIRECT = 'http://localhost:9999/callback';

const form = (agent, url, body) => agent.post(url).set('Host', HOST).set('Origin', ORIGIN).type('form').send(body);

async function installedApp(opts = {}) {
  const ctx = setup({ token: null, ...opts });
  await form(request(ctx.app), '/setup', {
    setup_code: 'ABCDE-12345', username: 'admin', password: PASSWORD, password_confirm: PASSWORD, alert_email: '', claude_token: '',
  });
  ctx.claudeAuth.save(OAUTH);
  return ctx;
}

/** Déroule le flux OAuth complet comme Claude Code : DCR → authorize → consentement → token. */
async function connect(app) {
  const reg = await request(app).post('/register').set('Host', HOST).send({
    client_name: 'Claude Code (test)', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
  });
  expect(reg.status).toBe(201);
  const clientId = reg.body.client_id;
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');

  const auth = await request(app).get('/authorize').set('Host', HOST).query({
    response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge,
    code_challenge_method: 'S256', state: 'etat-42', scope: 'ronde',
  });
  expect(auth.status).toBe(302);
  const reqId = new URL(auth.headers.location, ORIGIN).searchParams.get('req');

  const page = await request(app).get(`/oauth/consent?req=${reqId}`).set('Host', HOST);
  expect(page.text).toContain('Claude Code (test)');
  expect(page.headers['content-security-policy']).toContain('form-action \'self\' http://localhost:9999');

  const bad = await form(request(app), '/oauth/consent', { req: reqId, action: 'allow', username: 'admin', password: 'faux' });
  expect(bad.status).toBe(401);

  const ok = await form(request(app), '/oauth/consent', { req: reqId, action: 'allow', username: 'admin', password: PASSWORD });
  expect(ok.status).toBe(302);
  const back = new URL(ok.headers.location);
  expect(back.origin + back.pathname).toBe(REDIRECT);
  expect(back.searchParams.get('state')).toBe('etat-42');

  const tok = await request(app).post('/token').set('Host', HOST).type('form').send({
    grant_type: 'authorization_code', code: back.searchParams.get('code'), code_verifier: verifier, client_id: clientId, redirect_uri: REDIRECT,
  });
  expect(tok.status).toBe(200);
  return { clientId, ...tok.body, code: back.searchParams.get('code'), verifier };
}

let rpcId = 0;
async function rpc(app, token, method, params = {}) {
  const res = await request(app)
    .post('/mcp')
    .set('Host', HOST)
    .set('Authorization', `Bearer ${token}`)
    .set('Accept', 'application/json, text/event-stream')
    .send({ jsonrpc: '2.0', id: ++rpcId, method, params });
  return res;
}
async function call(app, token, name, args = {}) {
  const res = await rpc(app, token, 'tools/call', { name, arguments: args });
  expect(res.status).toBe(200);
  const r = res.body.result;
  return { isError: !!r.isError, text: r.content[0].text, data: r.isError ? null : JSON.parse(r.content[0].text) };
}

describe('OAuth', () => {
  it('n’accepte que les redirections locales ou claude.ai', () => {
    expect(isAllowedRedirect('http://localhost:1234/callback')).toBe(true);
    expect(isAllowedRedirect('http://127.0.0.1:5/cb')).toBe(true);
    expect(isAllowedRedirect('https://claude.ai/api/mcp/auth_callback')).toBe(true);
    expect(isAllowedRedirect('https://evil.com/cb')).toBe(false);
    expect(isAllowedRedirect('http://claude.ai/cb')).toBe(false);
  });

  it('refuse l’enregistrement d’un client qui redirige ailleurs', async () => {
    const { app } = await installedApp();
    const reg = await request(app).post('/register').set('Host', HOST).send({ redirect_uris: ['https://evil.com/cb'], token_endpoint_auth_method: 'none' });
    expect(reg.status).toBe(400);
  });

  it('publie les métadonnées et exige un jeton sur /mcp', async () => {
    const { app } = await installedApp();
    const meta = await request(app).get('/.well-known/oauth-authorization-server').set('Host', HOST);
    expect(meta.body.issuer).toBe('http://127.0.0.1/');
    const anon = await request(app).post('/mcp').set('Host', HOST).send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(anon.status).toBe(401);
    expect(anon.headers['www-authenticate']).toContain('resource_metadata=');
  });

  it('flux complet : login/mot de passe → jeton → MCP → renouvellement → révocation', async () => {
    const { app, store } = await installedApp();
    const t = await connect(app);

    const list = await rpc(app, t.access_token, 'tools/list');
    expect(list.status).toBe(200);
    const names = list.body.result.tools.map((x) => x.name);
    expect(names).toEqual(expect.arrayContaining(['list_rondes', 'test_prompt', 'create_ronde', 'run_ronde', 'list_host_data']));
    expect(names).not.toContain('delete_ronde');

    // Le code est à usage unique.
    const replay = await request(app).post('/token').set('Host', HOST).type('form').send({
      grant_type: 'authorization_code', code: t.code, code_verifier: t.verifier, client_id: t.clientId, redirect_uri: REDIRECT,
    });
    expect(replay.status).toBe(400);

    // Renouvellement avec rotation.
    const r1 = await request(app).post('/token').set('Host', HOST).type('form').send({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: t.clientId });
    expect(r1.status).toBe(200);
    const r2 = await request(app).post('/token').set('Host', HOST).type('form').send({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: t.clientId });
    expect(r2.status).toBe(400);

    // Révocation depuis les Réglages.
    const grant = store.db.prepare('SELECT id FROM oauth_grants').get();
    const admin = request.agent(app);
    await form(admin, '/login', { username: 'admin', password: PASSWORD });
    const settings = await admin.get('/settings').set('Host', HOST);
    expect(settings.text).toContain('Claude Code (test)');
    await form(admin, `/settings/mcp/grants/${grant.id}/revoke`, {});
    expect((await rpc(app, r1.body.access_token, 'tools/list')).status).toBe(401);
  });

  it('refuser renvoie access_denied', async () => {
    const { app } = await installedApp();
    const reg = await request(app).post('/register').set('Host', HOST).send({ redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' });
    const auth = await request(app).get('/authorize').set('Host', HOST).query({
      response_type: 'code', client_id: reg.body.client_id, redirect_uri: REDIRECT, code_challenge: 'x'.repeat(43), code_challenge_method: 'S256',
    });
    const reqId = new URL(auth.headers.location, ORIGIN).searchParams.get('req');
    const res = await form(request(app), '/oauth/consent', { req: reqId, action: 'deny' });
    expect(new URL(res.headers.location).searchParams.get('error')).toBe('access_denied');
  });
});

describe('outils MCP', () => {
  it('conçoit, essaie, crée, lance et consulte une ronde', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ronde-host-'));
    fs.writeFileSync(path.join(dir, 'fail2ban.txt'), 'fail2ban actif\njail sshd\n');
    const { app, store } = await installedApp({ env: { HOST_DATA_DIR: dir } });
    const { access_token: tok } = await connect(app);

    const data = await call(app, tok, 'list_host_data');
    expect(data.data[0]).toMatchObject({ chemin: '/host-metrics/fail2ban.txt' });
    expect(data.data[0].apercu).toContain('jail sshd');

    const tpl = await call(app, tok, 'list_templates');
    expect(tpl.data.map((t) => t.cle)).toEqual(['disk', 'fail2ban']);

    expect((await call(app, tok, 'preview_cron', { cron: '*/15 * * * *' })).data.prochaines).toHaveLength(5);
    expect((await call(app, tok, 'preview_cron', { cron: 'nope' })).isError).toBe(true);

    const test = await call(app, tok, 'test_prompt', { prompt: 'MODE:alert', allowed_tools: ['Read'] });
    expect(test.data).toMatchObject({ statut: 'alert', reponse: 'Disque / à 92 %', cout_estime_usd: 0.0123 });
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM runs').get().n).toBe(0); // un essai n'est pas enregistré

    const bash = await call(app, tok, 'create_ronde', { name: 'shell', prompt: 'p', allowed_tools: ['Bash'] });
    expect(bash.isError).toBe(true);
    expect(bash.text).toContain('non autorisés via MCP');

    const created = await call(app, tok, 'create_ronde', { name: 'Audit fail2ban', prompt: 'MODE:ok', allowed_tools: ['Read'] });
    expect(created.data).toMatchObject({ cree: true, mode: 'oneshot', creee_via: 'mcp' });
    const id = created.data.id;

    const upd = await call(app, tok, 'update_ronde', { id, cron: '5 * * * *' });
    expect(upd.data).toMatchObject({ mode: 'planifiée', cron: '5 * * * *' });

    const run = await call(app, tok, 'run_ronde', { id });
    expect(run.data).toMatchObject({ statut: 'ok', reponse: 'RAS', declencheur: 'manual' });
    expect((await call(app, tok, 'list_runs', { ronde_id: id })).data).toHaveLength(1);
    expect((await call(app, tok, 'get_ronde', { id })).data.derniers_runs[0].statut).toBe('ok');
    expect((await call(app, tok, 'set_active', { id, active: false })).data.active).toBe(false);
  });

  it('les outils autorisables se règlent dans les Réglages', async () => {
    const { app } = await installedApp();
    const { access_token: tok } = await connect(app);
    const admin = request.agent(app);
    await form(admin, '/login', { username: 'admin', password: PASSWORD });
    await form(admin, '/settings/mcp/tools', { mcp_tools: 'Read\nBash(df:*)' });
    expect((await call(app, tok, 'create_ronde', { name: 'df', prompt: 'p', allowed_tools: ['Bash(df:*)'] })).isError).toBe(false);
    expect((await call(app, tok, 'create_ronde', { name: 'sh', prompt: 'p', allowed_tools: ['Bash'] })).isError).toBe(true);
  });
});

describe('durcissements', () => {
  it('une ronde avec des outils hors politique est verrouillée pour MCP', async () => {
    const { app, store } = await installedApp();
    const { access_token: tok } = await connect(app);
    const id = store.createTask({ name: 'ui', prompt: 'p', cron: '', allowed_tools: ['Bash'], max_turns: 2, timeout_sec: 60, active: true });
    const r = await call(app, tok, 'update_ronde', { id, prompt: 'rm -rf /' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('verrouillée');
    expect(store.getTask(id).prompt).toBe('p');
  });

  it('exige la redirect_uri à l’échange du code', async () => {
    const { app } = await installedApp();
    const reg = await request(app).post('/register').set('Host', HOST).send({ redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' });
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const auth = await request(app).get('/authorize').set('Host', HOST).query({
      response_type: 'code', client_id: reg.body.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256',
    });
    const reqId = new URL(auth.headers.location, ORIGIN).searchParams.get('req');
    const ok = await form(request(app), '/oauth/consent', { req: reqId, action: 'allow', username: 'admin', password: PASSWORD });
    const code = new URL(ok.headers.location).searchParams.get('code');
    const tok = await request(app).post('/token').set('Host', HOST).type('form').send({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: reg.body.client_id });
    expect(tok.status).toBe(400);
  });

  it('révoquer un jeton révoque toute l’autorisation', async () => {
    const { app, store } = await installedApp();
    const t = await connect(app);
    const rev = await request(app).post('/revoke').set('Host', HOST).type('form').send({ token: t.refresh_token, client_id: t.clientId });
    expect(rev.status).toBe(200);
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM oauth_grants').get().n).toBe(0);
    expect((await rpc(app, t.access_token, 'tools/list')).status).toBe(401);
  });
});
