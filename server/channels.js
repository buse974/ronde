import { nowIso } from './db.js';
import { decrypt, deriveKey, encrypt } from './secrets.js';

/**
 * Canaux : là où ronde envoie la réponse d'une ronde. C'est ronde qui envoie,
 * jamais Claude : les accès (URL, jeton, adresses) sont chiffrés en base et
 * ne ressortent qu'en version masquée.
 */
export const CHANNEL_TYPES = {
  mail: { label: 'Mail', field: 'Adresses (séparées par des virgules)' },
  slack: { label: 'Slack', field: 'URL du webhook entrant Slack' },
  teams: { label: 'Teams', field: 'URL du webhook (Workflows Teams)' },
  webhook: { label: 'Webhook', field: 'URL qui reçoit le résultat en JSON' },
};
export const MODES = { alert: 'en cas d’alerte', always: 'à chaque passage' };

const EMAIL = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;
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

/** Valide et normalise la configuration d'un canal. Lève une Error lisible. */
export function normalizeConfig(type, input = {}) {
  if (!CHANNEL_TYPES[type]) throw new Error(`type de canal inconnu (${type}) : mail, slack, teams ou webhook.`);
  if (type === 'mail') {
    const to = String(input.to ?? input.target ?? '')
      .split(/[,;\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (!to.length) throw new Error('au moins une adresse mail.');
    const bad = to.filter((a) => !EMAIL.test(a));
    if (bad.length) throw new Error(`adresse invalide : ${bad.join(', ')}.`);
    return { config: { to: [...new Set(to)] }, preview: [...new Set(to)].join(', ') };
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

export function createChannels({ store, appSecret, mailer, config, fetchImpl = fetch, log = console }) {
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

  /** Envoie un message sur un canal. Lève une Error en cas d'échec. */
  async function deliver(row, m) {
    const c = secretOf(row);
    const link = m.url ? `\n\nDétail : ${m.url}` : '';
    if (row.type === 'mail') {
      if (!mailer.enabled) throw new Error('SMTP non configuré sur le serveur (SMTP_HOST).');
      await mailer.send({ to: c.to.join(', '), subject: `[ronde] ${m.title}`, text: `${m.text}${link}` });
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

  const byName = (name) => q('SELECT * FROM channels WHERE name = ?').get(String(name ?? '').trim());

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

    /** Crée (ou remplace, si le nom existe) un canal. Retourne le canal masqué. */
    save({ name, type, ...input }) {
      const n = String(name ?? '').trim();
      if (!n || n.length > 60) throw new Error('nom requis (60 caractères maximum).');
      const { config: c, preview } = normalizeConfig(type, input);
      const now = nowIso();
      const existing = byName(n);
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

    /** Envoie un message de test et retient le résultat. Retourne { ok, error }. */
    async test(id, text = 'Message de test : ce canal recevra les réponses des rondes.') {
      const row = q('SELECT * FROM channels WHERE id = ?').get(id);
      if (!row) return { ok: false, error: 'canal introuvable.' };
      let error = null;
      try {
        await deliver(row, { title: `Test du canal « ${row.name} »`, status: 'test', label: 'Test', text, url: config.publicUrl || null, task: null, runId: null });
      } catch (err) {
        error = err.message;
      }
      q('UPDATE channels SET tested_at = ?, test_ok = ?, test_error = ? WHERE id = ?').run(nowIso(), error ? 0 : 1, error, id);
      return { ok: !error, error };
    },

    /** Canaux de sortie d'une ronde. */
    forTask(taskId) {
      return q(
        `SELECT c.*, tc.mode FROM task_channels tc JOIN channels c ON c.id = tc.channel_id WHERE tc.task_id = ? ORDER BY c.name COLLATE NOCASE`,
      )
        .all(taskId)
        .map((r) => ({ ...pub(r), mode: r.mode }));
    },

    /**
     * Remplace les canaux d'une ronde : [{ name | id, mode }]. Note le changement dans
     * l'historique. Lève une Error si un canal n'existe pas.
     */
    setForTask(taskId, wanted, { by = 'ui' } = {}) {
      const resolved = wanted.map((w) => {
        const row = w.id ? q('SELECT * FROM channels WHERE id = ?').get(w.id) : byName(w.name);
        if (!row) throw new Error(`canal « ${w.name ?? w.id} » introuvable (Réglages > Canaux).`);
        const mode = w.mode === 'always' || w.mode === 'toujours' ? 'always' : 'alert';
        return { row, mode };
      });
      const describe = (list) => (list.length ? list.map((c) => `${c.name} (${MODES[c.mode]})`).join(', ') : 'aucun');
      const before = describe(this.forTask(taskId));
      db.transaction(() => {
        q('DELETE FROM task_channels WHERE task_id = ?').run(taskId);
        for (const { row, mode } of resolved) q('INSERT INTO task_channels (task_id, channel_id, mode) VALUES (?, ?, ?)').run(taskId, row.id, mode);
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
      const attached = q('SELECT c.*, tc.mode FROM task_channels tc JOIN channels c ON c.id = tc.channel_id WHERE tc.task_id = ?').all(task.id);
      let sent = 0;
      if (attached.length) {
        for (const row of attached) {
          if (row.mode !== 'always' && !problem) continue;
          try {
            await deliver(row, m);
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
