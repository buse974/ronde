import { nowIso } from './db.js';
import { smtpTransport as defaultSmtpTransport } from './mailer.js';
import { decrypt, deriveKey, encrypt } from './secrets.js';

/**
 * Canaux : là où ronde envoie la réponse d'une ronde. C'est ronde qui envoie,
 * jamais Claude : les accès (URL, jeton, adresses) sont chiffrés en base et
 * ne ressortent qu'en version masquée.
 */
export const CHANNEL_TYPES = {
  mail: { label: 'Mail', field: 'Adresses (séparées par des virgules)' },
  smtp: { label: 'SMTP', field: 'Hôte SMTP (hôte ou hôte:port)' },
  slack: { label: 'Slack', field: 'URL du webhook entrant Slack' },
  teams: { label: 'Teams', field: 'URL du webhook (Workflows Teams)' },
  webhook: { label: 'Webhook', field: 'URL qui reçoit le résultat en JSON' },
  api: { label: 'API', field: 'URL de base de l’API', tool: true },
};
export const MODES = { alert: 'en cas d’alerte', always: 'à chaque passage', requests: 'requêtes enregistrées', free: 'toutes les requêtes' };
/** Où mettre la clé d'un canal API. {{cle}} est remplacé partout où il apparaît, dans tous les cas. */
export const KEY_PLACES = {
  bearer: 'en-tête Authorization: Bearer',
  header: 'en-tête nommé',
  query: 'paramètre d’URL nommé',
  basic: 'Basic (identifiant:mot de passe)',
  body: 'seulement là où la requête écrit {{cle}}',
};
const API_TIMEOUT_MS = 20_000;
const API_MAX_BODY = 20_000;

/** Forme comparable d'une requête : méthode, chemin, corps JSON normalisé. */
export function requestKey({ methode = 'GET', chemin = '/', corps } = {}) {
  let body = corps ?? '';
  if (typeof body === 'string') {
    try {
      body = body.trim() ? JSON.parse(body) : '';
    } catch {
      body = body.trim();
    }
  }
  const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
  return `${String(methode).toUpperCase()} ${chemin} ${JSON.stringify(canon(body))}`;
}

const EMAIL = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;
/** Types qui envoient un mail, et acceptent donc des destinataires propres à chaque ronde. */
const MAIL_TYPES = ['mail', 'smtp'];
const SEND_TIMEOUT_MS = 10_000;
const STATUS_LABEL = { ok: 'RAS', alert: 'Alerte', failed: 'Échec', done: 'Réponse', test: 'Test' };

function maskUrl(raw) {
  try {
    const u = new URL(raw);
    const p = u.pathname.length > 12 ? `${u.pathname.slice(0, 10)}•••` : u.pathname;
    return `${u.protocol}//${u.host}${p}`;
  } catch {
    return '•••';
  }
}

/** Liste d'adresses (chaîne séparée par virgules, points-virgules ou espaces, ou tableau), dédoublonnée. */
export function parseRecipients(input) {
  const list = (Array.isArray(input) ? input : [input])
    .flatMap((s) => String(s ?? '').split(/[,;\s]+/))
    .map((s) => s.trim())
    .filter(Boolean);
  const bad = list.filter((a) => !EMAIL.test(a));
  if (bad.length) throw new Error(`adresse invalide : ${bad.join(', ')}.`);
  return [...new Set(list)];
}

/** Canal SMTP : sa propre connexion (hôte, port, identifiant, mot de passe, expéditeur). */
function smtpConfig(input) {
  let host = String(input.host ?? input.target ?? '').trim();
  let port = input.port;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(host)) throw new Error('hôte SMTP sans schéma (ex. smtp.office365.com).');
  const hp = host.match(/^(.+):(\d+)$/);
  if (hp) {
    host = hp[1];
    if (port == null || String(port).trim() === '') port = hp[2];
  }
  if (!/^[A-Za-z0-9.-]+$/.test(host)) throw new Error('hôte SMTP requis (ex. smtp.office365.com ou smtp.office365.com:587).');
  port = port == null || String(port).trim() === '' ? 587 : Number(port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('port SMTP invalide (entier entre 1 et 65535).');
  const user = String(input.user ?? '').trim();
  const pass = String(input.token ?? input.pass ?? '');
  const from = String(input.from ?? '').trim() || (EMAIL.test(user) ? user : '');
  if (!from) throw new Error('adresse expéditrice requise (ou un identifiant qui est une adresse mail).');
  if (!EMAIL.test(from)) throw new Error(`adresse expéditrice invalide : ${from}.`);
  const to = parseRecipients(input.to ?? []);
  return {
    config: { host, port, secure: port === 465, user, pass, from, to },
    preview: `${from} via ${host}:${port}${to.length ? ` → ${to.join(', ')}` : ' · destinataires donnés par chaque ronde'}`,
  };
}

/** Valide et normalise la configuration d'un canal. Lève une Error lisible. */
export function normalizeConfig(type, input = {}) {
  if (!CHANNEL_TYPES[type]) throw new Error(`type de canal inconnu (${type}) : ${Object.keys(CHANNEL_TYPES).join(', ')}.`);
  if (type === 'mail') {
    const to = parseRecipients(input.to ?? input.target ?? '');
    if (!to.length) throw new Error('au moins une adresse mail.');
    return { config: { to }, preview: to.join(', ') };
  }
  if (type === 'smtp') return smtpConfig(input);
  if (type === 'api') {
    const url = String(input.url ?? input.target ?? '').trim();
    let u;
    try {
      u = new URL(url);
    } catch {
      throw new Error('URL invalide.');
    }
    if (!['https:', 'http:'].includes(u.protocol)) throw new Error('URL http(s) requise.');
    const place = input.place && KEY_PLACES[input.place] ? input.place : 'bearer';
    const keyName = String(input.keyName ?? input.key_name ?? '').trim();
    if ((place === 'header' || place === 'query') && !/^[A-Za-z0-9_.-]{1,60}$/.test(keyName)) throw new Error('nom de l’en-tête ou du paramètre requis (lettres, chiffres, - _ .).');
    const key = String(input.token ?? input.key ?? '').trim();
    const where = place === 'header' || place === 'query' ? `${KEY_PLACES[place]} « ${keyName} »` : KEY_PLACES[place];
    return { config: { url: url.replace(/\/+$/, ''), key, place, keyName }, preview: `${maskUrl(url)} · clé : ${key ? where : 'aucune'}` };
  }
  const url = String(input.url ?? input.target ?? '').trim();
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new Error('URL invalide.');
  }
  // Un webhook générique peut viser une machine du réseau local (Jeedom…) : http accepté.
  if (u.protocol !== 'https:' && !(type === 'webhook' && u.protocol === 'http:')) throw new Error('URL en https:// requise.');
  if (type === 'slack' && u.host !== 'hooks.slack.com') throw new Error('un webhook Slack commence par https://hooks.slack.com/.');
  const token = String(input.token ?? '').trim();
  return { config: { url, ...(type === 'webhook' && token ? { token } : {}) }, preview: maskUrl(url) + (token ? ' + jeton' : '') };
}

/** Message d'un passage, commun à tous les canaux. */
export function runMessage({ task, run, publicUrl }) {
  const label = STATUS_LABEL[run.status] ?? run.status;
  const url = publicUrl ? `${publicUrl}/runs/${run.id}` : null;
  let text;
  if (run.status === 'failed') text = [`Le passage a échoué : ${run.error ?? 'erreur inconnue'}.`, run.result ? `\n${run.result}` : ''].join('');
  else text = run.result || '(Claude n’a renvoyé aucun texte : voir le détail du passage.)';
  return { title: `${label} : ${task.name}`, status: run.status, label, text, url, task: task.name, runId: run.id };
}

export function createChannels({ store, appSecret, mailer, config, fetchImpl = fetch, smtpTransport = defaultSmtpTransport, log = console }) {
  const db = store.db;
  const q = (sql) => db.prepare(sql);
  const key = deriveKey(appSecret, 'channels');

  const pub = (row) =>
    row && {
      id: row.id,
      name: row.name,
      type: row.type,
      typeLabel: CHANNEL_TYPES[row.type]?.label ?? row.type,
      direction: row.direction,
      preview: row.preview,
      tested_at: row.tested_at,
      test_ok: row.test_ok == null ? null : !!row.test_ok,
      test_error: row.test_error,
    };
  const secretOf = (row) => JSON.parse(decrypt(key, row.config));

  async function post(url, body, headers = {}) {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 200);
      throw new Error(`HTTP ${res.status}${detail ? ` : ${detail}` : ''}`);
    }
  }

  /**
   * Envoie un message sur un canal. Lève une Error en cas d'échec. recipients :
   * destinataires propres à la ronde (mail, smtp), sinon ceux du canal.
   */
  async function deliver(row, m, recipients = []) {
    const c = secretOf(row);
    const link = m.url ? `\n\nDétail : ${m.url}` : '';
    if (MAIL_TYPES.includes(row.type)) {
      const to = recipients?.length ? recipients : (c.to ?? []);
      if (!to.length) throw new Error('aucun destinataire : donnes-en au canal ou à la ronde.');
      const mail = { to: to.join(', '), subject: `[ronde] ${m.title}`, text: `${m.text}${link}` };
      if (row.type === 'mail') {
        if (!mailer.enabled) throw new Error('SMTP non configuré sur le serveur (SMTP_HOST).');
        return mailer.send(mail);
      }
      // Un transport par envoi : hors 465, STARTTLS exigé dès qu'il y a un identifiant.
      const transport = smtpTransport({ host: c.host, port: c.port, secure: c.secure, user: c.user || undefined, pass: c.pass, requireTLS: !c.secure && !!c.user });
      try {
        await transport.sendMail({ from: c.from, ...mail });
      } finally {
        transport.close?.();
      }
    } else if (row.type === 'slack') {
      await post(c.url, { text: `*${m.title}*\n${m.text}${m.url ? `\n<${m.url}|Voir le passage>` : ''}` });
    } else if (row.type === 'teams') {
      // Format des webhooks « Workflows » de Teams : une carte adaptative.
      await post(c.url, {
        type: 'message',
        attachments: [
          {
            contentType: 'application/vnd.microsoft.card.adaptive',
            content: {
              $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
              type: 'AdaptiveCard',
              version: '1.4',
              body: [
                { type: 'TextBlock', text: m.title, weight: 'Bolder', size: 'Medium', wrap: true },
                { type: 'TextBlock', text: m.text, wrap: true },
              ],
              actions: m.url ? [{ type: 'Action.OpenUrl', title: 'Voir le passage', url: m.url }] : [],
            },
          },
        ],
      });
    } else if (row.type === 'webhook') {
      await post(
        c.url,
        { source: 'ronde', ronde: m.task, statut: m.status, libelle: m.label, titre: m.title, texte: m.text, url: m.url, run_id: m.runId, date: nowIso() },
        c.token ? { authorization: `Bearer ${c.token}` } : {},
      );
    } else {
      throw new Error(`type de canal inconnu (${row.type}).`);
    }
  }

  /**
   * Appel d'un canal API, construit par Claude, envoyé par ronde : la clé n'est
   * ajoutée qu'ici ({{cle}}, en-tête, paramètre d'URL ou Basic) et masquée dans la réponse.
   */
  async function callApi(row, { methode = 'GET', chemin = '/', entetes = {}, corps } = {}) {
    const c = secretOf(row);
    const put = (v) => String(v).split('{{cle}}').join(c.key ?? '');
    const base = new URL(`${c.url}/`);
    const rel = String(chemin || '/');
    if (/^[a-z]+:/i.test(rel) || rel.startsWith('//')) throw new Error('le chemin doit être relatif à l’URL du canal (ex. /api/etat).');
    const target = new URL(put(rel.replace(/^\//, '')), base);
    if (target.origin !== base.origin || !target.pathname.startsWith(base.pathname.replace(/\/$/, ''))) throw new Error('le chemin sort de l’URL du canal.');
    if (c.place === 'query' && c.key) target.searchParams.set(c.keyName, c.key);
    const headers = {};
    for (const [k, v] of Object.entries(entetes ?? {})) {
      if (!/^[A-Za-z0-9-]{1,60}$/.test(k) || /^(host|content-length)$/i.test(k)) continue;
      headers[k.toLowerCase()] = put(v);
    }
    if (c.key && c.place === 'bearer') headers.authorization = `Bearer ${c.key}`;
    if (c.key && c.place === 'header') headers[c.keyName.toLowerCase()] = c.key;
    if (c.key && c.place === 'basic') headers.authorization = `Basic ${Buffer.from(c.key).toString('base64')}`;
    const method = String(methode).toUpperCase();
    let body;
    if (corps != null && corps !== '' && !['GET', 'HEAD'].includes(method)) {
      body = put(typeof corps === 'string' ? corps : JSON.stringify(corps));
      if (!headers['content-type']) headers['content-type'] = typeof corps === 'string' && !/^\s*[[{]/.test(corps) ? 'text/plain' : 'application/json';
    }
    const res = await fetchImpl(target, { method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(API_TIMEOUT_MS) });
    let text = await res.text().catch(() => '');
    if (c.key) text = text.split(c.key).join('•••');
    if (text.length > API_MAX_BODY) text = `${text.slice(0, API_MAX_BODY)}\n[… tronqué]`;
    return { statut: res.status, type: res.headers.get('content-type') ?? null, reponse: text };
  }

  const byName = (name) => q('SELECT * FROM channels WHERE name = ?').get(String(name ?? '').trim());

  /** Résout et valide les canaux voulus pour une ronde. Lève une Error lisible. */
  const resolveWanted = (wanted) =>
    wanted.map((w) => {
      const row = w.id ? q('SELECT * FROM channels WHERE id = ?').get(w.id) : byName(w.name);
      if (!row) throw new Error(`canal « ${w.name ?? w.id} » introuvable (Réglages > Canaux).`);
      if (row.type === 'api') {
        const requests = (w.requests ?? []).map((x) => ({ methode: String(x.methode ?? 'GET').toUpperCase(), chemin: String(x.chemin ?? '/'), ...(x.corps != null ? { corps: x.corps } : {}) }));
        const mode = w.mode === 'free' || w.mode === 'libre' ? 'free' : 'requests';
        return { row, mode, requests, recipients: [] };
      }
      const mode = w.mode === 'always' || w.mode === 'toujours' ? 'always' : 'alert';
      const recipients = MAIL_TYPES.includes(row.type) ? parseRecipients(w.recipients ?? []) : [];
      if (row.type === 'smtp' && !recipients.length && !secretOf(row).to?.length)
        throw new Error(`le canal « ${row.name} » n'a pas de destinataire par défaut : donne les destinataires de cette ronde.`);
      return { row, mode, requests: [], recipients };
    });

  return {
    list() {
      return q('SELECT * FROM channels ORDER BY name COLLATE NOCASE').all().map(pub);
    },
    get(id) {
      return pub(q('SELECT * FROM channels WHERE id = ?').get(id));
    },
    findByName(name) {
      return pub(byName(name));
    },

    /** Appel d'un canal API par son nom (le relais vérifie les droits avant). */
    async call(name, request) {
      const row = byName(name);
      if (!row || row.type !== 'api') throw new Error(`canal API « ${name} » introuvable.`);
      return callApi(row, request);
    },

    /** Crée (ou remplace, si le nom existe) un canal. Retourne le canal masqué. */
    save({ name, type, ...input }) {
      const n = String(name ?? '').trim();
      if (!n || n.length > 60) throw new Error('nom requis (60 caractères maximum).');
      const { config: c, preview } = normalizeConfig(type, input);
      const now = nowIso();
      const existing = byName(n);
      // SMTP réenregistré sans mot de passe : on garde celui déjà enregistré.
      if (type === 'smtp' && existing?.type === 'smtp' && !c.pass) c.pass = secretOf(existing).pass ?? '';
      if (existing) {
        q('UPDATE channels SET type = ?, config = ?, preview = ?, tested_at = NULL, test_ok = NULL, test_error = NULL, updated_at = ? WHERE id = ?').run(
          type,
          encrypt(key, JSON.stringify(c)),
          preview,
          now,
          existing.id,
        );
        return this.get(existing.id);
      }
      const id = Number(
        q('INSERT INTO channels (name, type, config, preview, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(
          n,
          type,
          encrypt(key, JSON.stringify(c)),
          preview,
          now,
          now,
        ).lastInsertRowid,
      );
      return this.get(id);
    },

    /** Supprime un canal ; les rondes qui l'utilisaient le notent dans leur historique. */
    remove(id) {
      const row = q('SELECT * FROM channels WHERE id = ?').get(id);
      if (!row) return;
      const tasks = q('SELECT task_id FROM task_channels WHERE channel_id = ?').all(id);
      db.transaction(() => {
        q('DELETE FROM channels WHERE id = ?').run(id);
        for (const t of tasks) store.addHistory(t.task_id, `Canal « ${row.name} » supprimé des réglages : il n'est plus utilisé par cette ronde.`, { by: 'ui' });
      })();
    },

    /**
     * Envoie un message de test et retient le résultat. Retourne { ok, error }. Mail, SMTP :
     * aux destinataires donnés, sinon ceux du canal, sinon (SMTP) à l'expéditeur, ce qui vérifie l'authentification.
     */
    async test(id, text = 'Message de test : ce canal recevra les réponses des rondes.', { to } = {}) {
      const row = q('SELECT * FROM channels WHERE id = ?').get(id);
      if (!row) return { ok: false, error: 'canal introuvable.' };
      let error = null;
      try {
        if (row.type === 'api') {
          // Un canal API se teste en joignant son URL : une réponse HTTP suffit, sauf clé refusée.
          const r = await callApi(row, { methode: 'GET', chemin: '/' });
          if (r.statut === 401 || r.statut === 403) error = `clé refusée (HTTP ${r.statut}).`;
          else if (r.statut >= 500) error = `HTTP ${r.statut}.`;
        } else {
          let recipients = MAIL_TYPES.includes(row.type) ? parseRecipients(to ?? []) : [];
          if (!recipients.length && row.type === 'smtp' && !secretOf(row).to?.length) recipients = [secretOf(row).from];
          await deliver(row, { title: `Test du canal « ${row.name} »`, status: 'test', label: 'Test', text, url: config.publicUrl || null, task: null, runId: null }, recipients);
        }
      } catch (err) {
        error = err.message;
      }
      q('UPDATE channels SET tested_at = ?, test_ok = ?, test_error = ? WHERE id = ?').run(nowIso(), error ? 0 : 1, error, id);
      return { ok: !error, error };
    },

    /** Vérifie des canaux voulus sans rien enregistrer (avant de créer une ronde). */
    check(wanted) {
      resolveWanted(wanted);
    },

    /** Canaux de sortie d'une ronde. */
    forTask(taskId) {
      return q(
        `SELECT c.*, tc.mode, tc.requests, tc.recipients FROM task_channels tc JOIN channels c ON c.id = tc.channel_id WHERE tc.task_id = ? ORDER BY c.name COLLATE NOCASE`,
      )
        .all(taskId)
        .map((r) => ({ ...pub(r), mode: r.mode, requests: JSON.parse(r.requests ?? '[]'), recipients: JSON.parse(r.recipients ?? '[]') }));
    },

    /**
     * Remplace les canaux d'une ronde : [{ name | id, mode, recipients? }]. recipients (mail,
     * smtp) : destinataires propres à la ronde, sinon ceux du canal. Note le changement dans
     * l'historique. Lève une Error si un canal n'existe pas ou n'a aucun destinataire.
     */
    setForTask(taskId, wanted, { by = 'ui' } = {}) {
      const resolved = resolveWanted(wanted);
      const describe = (list) =>
        list.length
          ? list.map((c) => `${c.name} (${MODES[c.mode]}${c.mode === 'requests' ? ` : ${c.requests.length}` : ''}${c.recipients?.length ? `, à ${c.recipients.join(', ')}` : ''})`).join(', ')
          : 'aucun';
      const before = describe(this.forTask(taskId));
      db.transaction(() => {
        q('DELETE FROM task_channels WHERE task_id = ?').run(taskId);
        for (const { row, mode, requests, recipients } of resolved)
          q('INSERT INTO task_channels (task_id, channel_id, mode, requests, recipients) VALUES (?, ?, ?, ?, ?)').run(taskId, row.id, mode, JSON.stringify(requests), JSON.stringify(recipients));
      })();
      const after = describe(this.forTask(taskId));
      if (before !== after) {
        const BY = { ui: 'depuis l’interface', claude: 'par Claude, sur ton accord', mcp: 'via MCP' };
        store.addHistory(taskId, `Canaux modifiés ${BY[by] ?? by} : ${before} → ${after}.`, { by });
      }
    },

    /**
     * Après un passage : envoie la réponse sur les canaux de la ronde. Sans canal,
     * le mail d'alerte des réglages reste la règle (alertes et échecs seulement).
     * Retourne le nombre d'envois réussis.
     */
    async notifyRun(task, run) {
      if (run.stopped) return 0; // arrêté à la main : c'est toi qui l'as demandé
      const problem = run.status === 'alert' || run.status === 'failed';
      const m = runMessage({ task, run, publicUrl: config.publicUrl });
      const attached = q(`SELECT c.*, tc.mode, tc.recipients FROM task_channels tc JOIN channels c ON c.id = tc.channel_id WHERE tc.task_id = ? AND c.type != 'api'`).all(task.id);
      let sent = 0;
      if (attached.length) {
        for (const row of attached) {
          if (row.mode !== 'always' && !problem) continue;
          try {
            await deliver(row, m, JSON.parse(row.recipients ?? '[]'));
            sent += 1;
          } catch (err) {
            log.error(`[ronde] canal « ${row.name} », passage #${run.id} : ${err.message}`);
          }
        }
        return sent;
      }
      const to = store.getSetting('alert_email');
      if (!problem || task.notify === false || !to) return 0;
      try {
        await mailer.send({ to, subject: `[ronde] ${m.title}`, text: `${m.text}${m.url ? `\n\nDétail : ${m.url}` : ''}` });
        return 1;
      } catch (err) {
        log.error(`[ronde] envoi de l'alerte du passage #${run.id} impossible : ${err.message}`);
        return 0;
      }
    },
  };
}
