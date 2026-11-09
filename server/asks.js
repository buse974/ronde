import fs from 'node:fs';
import { nowIso } from './db.js';
import { classify, isRas, runClaude } from './runner.js';
import { taskSchema } from './validation.js';

const HISTORY = 20;
const EXEC_TIMEOUT_SEC = 300;
const DESIGN_TIMEOUT_SEC = 240;

/** Outils proposés dans la zone « Demander à Claude ». */
export const ASK_TOOLS = ['Read', 'Grep', 'Glob'];
export const ASK_TIMEOUT_MIN = { exec: EXEC_TIMEOUT_SEC / 60, design: DESIGN_TIMEOUT_SEC / 60 };

/** Dernier bloc ```json … ``` d'une réponse de Claude (ou null). */
export function extractJsonBlock(text) {
  const blocks = [...String(text ?? '').matchAll(/```json\s*([\s\S]*?)```/g)];
  if (!blocks.length) return null;
  try {
    return JSON.parse(blocks.at(-1)[1]);
  } catch {
    return null;
  }
}

/** Texte de la réponse sans le bloc JSON final. */
export function stripJsonBlock(text) {
  return String(text ?? '')
    .replace(/```json\s*[\s\S]*?```\s*$/, '')
    .trim();
}

function hostDataListing(dir) {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => !f.startsWith('.'))
      .map((f) => {
        const st = fs.statSync(`${dir}/${f}`);
        return `- /host-metrics/${f} (${st.size} octets, modifié ${st.mtime.toISOString()})`;
      })
      .join('\n');
  } catch {
    return '(aucune donnée hôte disponible)';
  }
}

/**
 * Prompt d'une exécution ponctuelle : un court contexte (où Claude tourne,
 * quelles données du serveur il peut lire), puis la demande telle quelle.
 */
export function execPrompt({ text, hostDataDir, tools, history = [] }) {
  const previous = history.length
    ? `Échanges précédents de cette conversation :\n\n${history
        .map((m) => (m.role === 'user' ? `Administrateur : ${m.text}` : `Toi : ${m.text}`))
        .join('\n\n')}\n\n`
    : '';
  return `Contexte : tu tournes dans le conteneur de « ronde », sur un serveur Linux, sans personne pour te répondre. Tu ne vois pas directement le système de l'hôte : un df ou un ps ici ne décriraient que le conteneur. Les données de l'hôte sont relevées toutes les 15 minutes dans /host-metrics, lisibles avec l'outil Read :
${hostDataListing(hostDataDir)}
Outils disponibles : ${tools.length ? tools.join(', ') : 'aucun'}.
Réponds en français, de façon concise, en citant les chiffres et l'heure de la mesure. Si l'information demandée n'est pas dans ces données, dis-le simplement et indique quelle donnée il faudrait relever.

Ensuite, évalue si cette demande gagnerait à devenir une « ronde » : une vérification que Claude referait régulièrement et qui n'alerterait qu'en cas de problème (espace disque, sécurité, sauvegardes, certificats, dérive d'une valeur…). Une question ponctuelle, une explication ou une demande d'information générale n'est pas une ronde.
Termine TOUJOURS ta réponse par un bloc \`\`\`json contenant {"ronde": true} ou {"ronde": false}. N'en parle pas dans ta réponse : l'interface pose elle-même la question.

${previous}Demande :
${text}`;
}

/** Libellé d'une étape en cours, à partir d'un appel d'outil de Claude. */
export function describeTool(name, input = {}) {
  const host = (p) => String(p ?? '').replace(/^.*\/host-metrics/, '/host-metrics');
  if (name === 'Read') return `Lecture de ${host(input.file_path)}`;
  if (name === 'Glob') return `Recherche de fichiers : ${input.pattern ?? ''}`;
  if (name === 'Grep') return `Recherche de « ${input.pattern ?? ''} »${input.path ? ` dans ${host(input.path)}` : ''}`;
  return `Outil ${name}`;
}

/** Texte en cours d'écriture, sans le bloc JSON final (même incomplet). */
export function visibleText(text) {
  const i = String(text ?? '').indexOf('```json');
  return (i >= 0 ? text.slice(0, i) : String(text ?? '')).trim();
}

/** Prompt d'un tour de conception : consignes, données disponibles, conversation. */
export function designPrompt({ messages, timezone, hostDataDir, allowedTools }) {
  const transcript = messages
    .map((m) => (m.role === 'user' ? `Administrateur : ${m.text}` : `Toi (tour précédent) : ${m.text}`))
    .join('\n\n');
  return `Tu aides l'administrateur de « ronde » à concevoir une ronde. Une ronde est un prompt que Claude exécutera seul, sans personne pour lui répondre, avec \`claude -p\`, sur ce serveur, à heure fixe (cron) ou à la demande.

Règles d'une ronde :
- Le prompt de la ronde doit demander de répondre exactement « RAS » s'il n'y a rien à signaler. Toute autre réponse déclenche une alerte par mail : elle doit alors être courte et donner les chiffres utiles.
- Les données du serveur sont lisibles dans /host-metrics avec l'outil Read. Fichiers disponibles :
${hostDataListing(hostDataDir)}
- Outils qu'une ronde peut utiliser : ${allowedTools.join(', ')}. N'en propose pas d'autres.
- Fréquence : expression cron à 5 champs, fuseau ${timezone}. Chaîne vide pour une ronde manuelle.

Ta démarche :
1. Si c'est utile, lis les fichiers de /host-metrics pour connaître les valeurs actuelles et proposer des seuils réalistes.
2. S'il te manque une information importante (seuil, exception connue, fréquence), pose au plus 3 questions courtes.
3. Sinon, propose la ronde complète et explique tes choix en 2 ou 3 phrases.

Réponds en français, de façon concise. Termine TOUJOURS ta réponse par un bloc \`\`\`json contenant soit
{"type": "question"}
soit
{"type": "proposal", "ronde": {"name": "...", "prompt": "...", "cron": "...", "allowed_tools": ["Read"], "max_turns": 4, "timeout_sec": 300}}

Conversation jusqu'ici :

${transcript}`;
}

export function createAsks({ db, config, claudeAuth, log = console }) {
  const q = (sql) => db.prepare(sql);
  let busy = false;
  const inFlight = new Set();
  /** État en direct des demandes en cours : étapes (outils) et texte partiel. */
  const live = new Map();
  /** Demandes en cours : id → AbortController (bouton « Arrêter »). */
  const controllers = new Map();

  function onEventFor(id) {
    const state = { steps: [], text: '' };
    live.set(id, state);
    return (e) => {
      if (e.type === 'stream_event') {
        if (e.event?.type === 'message_start') state.text = '';
        const d = e.event?.delta;
        if (e.event?.type === 'content_block_delta' && d?.type === 'text_delta') state.text += d.text;
      } else if (e.type === 'assistant') {
        for (const c of e.message?.content ?? []) {
          if (c.type === 'tool_use') state.steps.push(describeTool(c.name, c.input));
        }
      }
      if (state.steps.length > 30) state.steps.splice(0, state.steps.length - 30);
    };
  }

  const parse = (row) =>
    row && {
      ...row,
      suggest_ronde: !!row.suggest_ronde,
      allowed_tools: JSON.parse(row.allowed_tools),
      // Demandes d'avant la conversation : on reconstitue l'échange.
      messages: (() => {
        const m = JSON.parse(row.messages);
        if (m.length || row.kind !== 'exec') return m;
        return [{ role: 'user', text: row.title }, ...(row.result ? [{ role: 'claude', text: row.result }] : [])];
      })(),
      proposal: row.proposal ? JSON.parse(row.proposal) : null,
      is_ras: row.is_ras == null ? null : !!row.is_ras,
    };

  function update(id, fields) {
    const keys = Object.keys(fields);
    q(`UPDATE asks SET ${keys.map((k) => `${k} = @${k}`).join(', ')}, updated_at = @updated_at WHERE id = @id`).run({
      ...fields,
      id,
      updated_at: nowIso(),
    });
  }

  function addUsage(id, r) {
    q(
      `UPDATE asks SET input_tokens = input_tokens + ?, output_tokens = output_tokens + ?, cost_usd = cost_usd + ? WHERE id = ?`,
    ).run(
      (r.input_tokens ?? 0) + (r.cache_read_tokens ?? 0) + (r.cache_creation_tokens ?? 0),
      r.output_tokens ?? 0,
      r.cost_usd ?? 0,
      id,
    );
  }

  async function call(id, prompt, allowedTools, maxTurns, timeoutSec) {
    const auth = claudeAuth.resolve();
    if (!auth) return { r: { status: 'failed', error: 'Aucun token Claude configuré (Réglages).' }, out: null };
    const ctrl = new AbortController();
    controllers.set(id, ctrl);
    try {
      const out = await runClaude({
        prompt, allowedTools, maxTurns, timeoutSec, auth, config, timezone: config.timezone, onEvent: onEventFor(id), signal: ctrl.signal,
      });
      return { r: classify(out), out };
    } finally {
      live.delete(id);
      controllers.delete(id);
    }
  }

  /** raw = prompt envoyé tel quel (essai d'une ronde proposée, comme un vrai passage). */
  async function runExec(id, raw) {
    const ask = parse(q('SELECT * FROM asks WHERE id = ?').get(id));
    const tools = ask.allowed_tools;
    const question = ask.messages.at(-1).text;
    const full = raw ? question : execPrompt({ text: question, history: ask.messages.slice(0, -1), hostDataDir: config.hostDataDir, tools });
    const { r, out } = await call(id, full, tools, 10, EXEC_TIMEOUT_SEC);
    addUsage(id, r);
    if (r.status === 'failed') {
      const detail = r.result ?? (out?.stderr ? out.stderr.slice(-2000) : null);
      update(id, { status: 'failed', error: r.error, result: detail });
    } else {
      const block = raw ? null : extractJsonBlock(r.result);
      const text = (raw ? r.result : stripJsonBlock(r.result)) || '(réponse vide)';
      update(id, {
        status: 'done',
        result: text,
        is_ras: isRas(text) ? 1 : 0,
        suggest_ronde: block?.ronde === true ? 1 : 0,
        messages: JSON.stringify([...ask.messages, { role: 'claude', text }]),
        error: null,
      });
    }
  }

  async function runDesignTurn(id) {
    const ask = parse(q('SELECT * FROM asks WHERE id = ?').get(id));
    const allowed = ask.allowed_tools;
    const prompt = designPrompt({ messages: ask.messages, timezone: config.timezone, hostDataDir: config.hostDataDir, allowedTools: allowed });
    const { r } = await call(id, prompt, ['Read', 'Glob'], 8, DESIGN_TIMEOUT_SEC);
    addUsage(id, r);
    if (r.status === 'failed') {
      update(id, { status: 'failed', error: r.error });
      return;
    }
    const block = extractJsonBlock(r.result);
    const text = stripJsonBlock(r.result) || '(réponse vide)';
    let proposal = null;
    let proposalError = null;
    if (block?.type === 'proposal' && block.ronde) {
      const candidate = {
        name: block.ronde.name ?? '',
        prompt: block.ronde.prompt ?? '',
        cron: block.ronde.cron ?? '',
        allowed_tools: Array.isArray(block.ronde.allowed_tools) ? block.ronde.allowed_tools : ['Read'],
        max_turns: block.ronde.max_turns ?? 4,
        timeout_sec: block.ronde.timeout_sec ?? 300,
        active: true,
      };
      const parsed = taskSchema(config.timezone).safeParse(candidate);
      proposal = parsed.success ? parsed.data : candidate;
      if (!parsed.success) proposalError = parsed.error.issues.map((i) => `${i.path.join('.')} : ${i.message}`).join(' ; ');
    }
    const messages = [...ask.messages, { role: 'claude', text, proposal: !!proposal }];
    update(id, {
      status: proposal ? 'proposal' : 'question',
      messages: JSON.stringify(messages),
      proposal: proposal ? JSON.stringify({ ...proposal, error: proposalError }) : ask.proposal ? JSON.stringify(ask.proposal) : null,
      error: null,
    });
  }

  function launch(id, job) {
    busy = true;
    const done = job()
      .catch((err) => {
        log.error(`[ronde] demande #${id} : ${err.stack || err}`);
        try {
          update(id, { status: 'failed', error: `Erreur interne : ${err.message}` });
        } catch {
          /* base indisponible */
        }
      })
      .finally(() => {
        busy = false;
        inFlight.delete(done);
      });
    inFlight.add(done);
    return done;
  }

  return {
    get busy() {
      return busy;
    },

    /** Lance une demande. Retourne { id, done } ou null si une demande tourne déjà. */
    start(kind, text, tools, { raw = false, title = text, history = [] } = {}) {
      if (busy) return null;
      const now = nowIso();
      const messages = [...history, { role: 'user', text }];
      const id = Number(
        q(
          `INSERT INTO asks (kind, status, title, allowed_tools, messages, created_at, updated_at) VALUES (?, 'running', ?, ?, ?, ?, ?)`,
        ).run(kind, title.slice(0, 200), JSON.stringify(tools), JSON.stringify(messages), now, now).lastInsertRowid,
      );
      const done = launch(id, () => (kind === 'exec' ? runExec(id, raw) : runDesignTurn(id)));
      // Ménage : on ne garde que les dernières demandes.
      q(`DELETE FROM asks WHERE id NOT IN (SELECT id FROM asks ORDER BY created_at DESC, id DESC LIMIT ${HISTORY})`).run();
      return { id, done };
    },

    /** Suite de la conversation (demande ponctuelle ou conception). Retourne { done } ou { error }. */
    reply(id, text) {
      const ask = this.get(id);
      if (!ask) return { error: 'Demande introuvable.' };
      if (busy || ask.status === 'running') return { error: 'Claude réfléchit déjà, attends sa réponse.' };
      update(id, { status: 'running', suggest_ronde: 0, messages: JSON.stringify([...ask.messages, { role: 'user', text }]) });
      return { done: launch(id, () => (ask.kind === 'exec' ? runExec(id, false) : runDesignTurn(id))) };
    },

    /** Arrête une demande en cours. Retourne true si elle tournait. */
    stop(id) {
      const ctrl = controllers.get(id);
      if (!ctrl) return false;
      ctrl.abort();
      return true;
    },

    /** État en direct d'une demande en cours (ou null). */
    live(id) {
      const s = live.get(id);
      return s ? { steps: [...s.steps], text: visibleText(s.text) } : null;
    },

    get(id) {
      return parse(q('SELECT * FROM asks WHERE id = ?').get(id));
    },

    recent(limit = 8) {
      return q('SELECT * FROM asks ORDER BY created_at DESC, id DESC LIMIT ?').all(limit).map(parse);
    },

    recoverOrphans() {
      return q(`UPDATE asks SET status = 'failed', error = 'Interrompue : le serveur a redémarré.' WHERE status = 'running'`).run().changes;
    },

    drain() {
      return Promise.allSettled([...inFlight]);
    },
  };
}
