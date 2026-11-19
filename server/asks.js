import fs from 'node:fs';
import { nowIso } from './db.js';
import { classify, isRas, runClaude } from './runner.js';
import { forbiddenRules, missingRules, proposableTools, proposalToolsError } from './tool-policy.js';
import { taskSchema } from './validation.js';

const HISTORY = 20;
const EXEC_TIMEOUT_SEC = 300;
const DESIGN_TIMEOUT_SEC = 240;

/**
 * Outils que Claude utilise lui-même pour répondre à une question libre (« Demander à Claude »).
 * À ne pas confondre avec les outils qu'il peut proposer pour une ronde : proposableTools(store).
 */
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
        return `- ${dir}/${f} (${st.size} octets, modifié ${st.mtime.toISOString()})`;
      })
      .join('\n');
  } catch {
    return '(aucune donnée hôte disponible)';
  }
}

/**
 * La conversation telle que Claude la relit. Les entrées [Historique] sont écrites par ronde
 * à chaque création, modification, pause, archivage… : c'est la mémoire fiable de la ronde.
 */
export function transcriptOf(messages) {
  const when = (iso) => String(iso ?? '').slice(0, 16).replace('T', ' ');
  return messages
    .map((m) => {
      if (m.role === 'user') return `Administrateur : ${m.text}`;
      if (m.role !== 'history') return `Toi (tour précédent) : ${m.text}`;
      let line = `[Historique ${when(m.at)} UTC, écrit par ronde] ${m.text}`;
      if (m.prompt_before != null) line += `\nPrompt avant :\n${m.prompt_before}\nPrompt après :\n${m.prompt_after}`;
      else if (m.after?.prompt) line += `\nPrompt à la création :\n${m.after.prompt}`;
      return line;
    })
    .join('\n\n');
}

/** Les canaux, tels que Claude les voit : noms et types, jamais les accès. */
export function channelsContext(available = [], current = null) {
  const out = available.filter((c) => c.type !== 'api');
  const api = available.filter((c) => c.type === 'api');
  const list = out.length ? out.map((c) => `« ${c.name} » (${c.typeLabel ?? c.type})`).join(', ') : 'aucun (l’administrateur les ajoute dans Réglages > Canaux)';
  let text = `Canaux d'envoi configurés : ${list}. C'est ronde qui envoie la réponse d'une ronde sur ses canaux, « en cas d'alerte » (réponse autre que RAS, ou échec) ou « à chaque passage » ; sans canal, les alertes partent au mail par défaut des réglages. Un canal Mail ou SMTP peut recevoir des destinataires propres à la ronde ("destinataires": ["a@exemple.fr"]), à la place de ceux du canal ; un canal SMTP sans destinataire par défaut l'exige. Tu ne peux pas créer de canal, seulement en brancher un existant.`;
  if (api.length) {
    text += `\nCanaux API configurés : ${api.map((c) => `« ${c.name} »`).join(', ')}. Ici, en conversation avec l'administrateur, tu peux les essayer avec l'outil appeler_canal (requêtes libres). Démarche : si besoin, lis la documentation de l'API avec WebFetch ; essaie la requête et montre le résultat ; ne déclenche une action qui change quelque chose (allumer, éteindre, écrire…) que si l'administrateur te l'a demandé. Quand une requête fait ce qu'il faut et que l'administrateur valide : branche le canal sur la ronde avec cette requête enregistrée ("requetes": [{"methode": "...", "chemin": "...", "corps": ...}]) et écris dans le prompt de la ronde l'appel exact à faire avec l'outil appeler_canal (canal, méthode, chemin, corps). La clé n'apparaît jamais : si l'API la veut dans la requête, écris {{cle}}. Pendant un passage, seule une requête enregistrée à l'identique passe.`;
  }
  if (current) {
    const fmt = (c) =>
      c.type === 'api'
        ? `« ${c.name} » (API, ${c.mode === 'free' ? 'toutes les requêtes' : `requêtes enregistrées : ${(c.requests ?? []).map((r) => `${r.methode} ${r.chemin}${r.corps != null ? ` ${typeof r.corps === 'string' ? r.corps : JSON.stringify(r.corps)}` : ''}`).join(' | ') || 'aucune'}`})`
        : `« ${c.name} » (${c.mode === 'always' ? 'à chaque passage' : 'en cas d’alerte'}${c.recipients?.length ? `, à ${c.recipients.join(', ')}` : ''})`;
    text += `\nCanaux de cette ronde : ${current.length ? current.map(fmt).join(', ') : 'aucun'}.`;
  }
  return text;
}

/**
 * Prompt d'une exécution ponctuelle : un court contexte (où Claude tourne,
 * quelles données du serveur il peut lire), puis la demande telle quelle.
 */
/** Où Claude tourne : conteneur (il ne voit pas l'hôte) ou directement sur le serveur. */
export function whereContext({ hostDataDir, inContainer = true }) {
  return inContainer
    ? `tu tournes dans le conteneur de « ronde », sur un serveur Linux, sans personne pour te répondre. Tu ne vois pas directement le système de l'hôte : un df ou un ps ici ne décriraient que le conteneur. Les données de l'hôte sont relevées toutes les 15 minutes dans ${hostDataDir}, lisibles avec l'outil Read`
    : `tu tournes directement sur le serveur Linux de « ronde », sous un compte de service sans privilège, sans personne pour te répondre. Des données relevées toutes les 15 minutes (disque, fail2ban…) sont dans ${hostDataDir}, lisibles avec l'outil Read`;
}

export function execPrompt({ text, hostDataDir, inContainer = true, tools, proposable = [], history = [], channels = [] }) {
  const previous = history.length ? `Échanges précédents de cette conversation :\n\n${transcriptOf(history)}\n\n` : '';
  return `Contexte : ${whereContext({ hostDataDir, inContainer })} :
${hostDataListing(hostDataDir)}
Outils disponibles : ${tools.length ? tools.join(', ') : 'aucun'}. Tu ne peux lancer aucune commande ici.
Si la demande exige une commande (php -m, dpkg -l…) : dis que tu ne peux pas la lancer dans cette conversation, mais qu'une ronde le pourra, et mets "ronde": true. Outils qu'une ronde peut utiliser (liste réglée par l'administrateur) : ${proposable.join(', ') || 'aucun'}. Si la règle nécessaire n'y est pas, dis laquelle. ${MISSING_RULE}
Réponds en français, de façon concise, en citant les chiffres et l'heure de la mesure. Si l'information demandée n'est pas dans ces données, dis-le simplement et indique quelle donnée il faudrait relever.

${channels.length ? `${channelsContext(channels)}\n\n` : ''}Si l'administrateur demande explicitement de créer une ronde ou un oneshot (« crée-moi une ronde qui… », « fais-en un oneshot… »), ne fais pas le travail ici : réponds en une phrase que tu prépares la ronde, et mets "creer": true dans le bloc final. L'interface enchaîne aussitôt sur sa conception, dans cette même conversation.

Sinon, évalue si cette demande gagnerait à devenir une « ronde » : une vérification que Claude referait régulièrement et qui n'alerterait qu'en cas de problème (espace disque, sécurité, sauvegardes, certificats, dérive d'une valeur…). Une question ponctuelle, une explication ou une demande d'information générale n'est pas une ronde.
Termine TOUJOURS ta réponse par un bloc \`\`\`json contenant {"ronde": true} ou {"ronde": false} (et "creer": true pour une demande de création). N'en parle pas dans ta réponse : l'interface pose elle-même la question.

${previous}Demande :
${text}`;
}

/** Libellé d'une étape en cours, à partir d'un appel d'outil de Claude. */
export function describeTool(name, input = {}) {
  const host = (p) => String(p ?? '').replace(/^.*\/host-metrics/, '/host-metrics');
  if (name === 'Read') return `Lecture de ${host(input.file_path)}`;
  if (name === 'Glob') return `Recherche de fichiers : ${input.pattern ?? ''}`;
  if (name === 'Grep') return `Recherche de « ${input.pattern ?? ''} »${input.path ? ` dans ${host(input.path)}` : ''}`;
  if (name === 'WebFetch') return `Lecture de ${input.url ?? 'une page web'}`;
  if (name.endsWith('__appeler_canal')) return `Appel du canal « ${input.canal ?? '?'} » : ${input.methode ?? 'GET'} ${input.chemin ?? '/'}`;
  return `Outil ${name}`;
}

/** Texte en cours d'écriture, sans le bloc JSON final (même incomplet). */
export function visibleText(text) {
  const i = String(text ?? '').indexOf('```json');
  return (i >= 0 ? text.slice(0, i) : String(text ?? '')).trim();
}

/** Comment signaler une règle qui manque : l'interface en fait un bouton, l'administrateur décide. */
const MISSING_RULE = `Ajoute alors au bloc json final "manque": ["Bash(php -m)"] : la règle exacte et étroite (une commande ou un préfixe précis, jamais un nom d'outil seul comme Bash, ni Bash(*)). Tu ne peux pas l'ajouter toi-même.`;

/**
 * Consigne sur les outils d'une ronde : la liste réglée par l'administrateur, et quoi dire
 * quand le besoin la dépasse (jamais « impossible » : la règle qui manque et les deux issues).
 */
export function toolsRule(allowedTools, kept = []) {
  const extra = kept.filter((r) => !allowedTools.includes(r));
  return `Outils qu'une ronde peut utiliser (liste réglée par l'administrateur) : ${allowedTools.join(', ') || 'aucun'}.${extra.length ? ` Cette ronde porte déjà aussi : ${extra.join(', ')} ; tu peux les garder ou les retirer.` : ''} Ne propose que des règles de cette liste, à l'identique ; un nom d'outil seul (Bash, WebFetch) y autorise toutes les règles de cet outil. Si le besoin demande un outil ou une règle hors liste (par exemple Bash(php -v), Bash(dpkg -l:*), WebFetch), ne dis pas que c'est impossible : dis quelle règle exacte manque, et que l'administrateur peut soit l'ajouter (bouton sous ta réponse, ou Réglages > Outils proposables), soit créer la ronde lui-même dans le formulaire manuel. ${MISSING_RULE} Ne mets jamais une règle hors liste dans une proposition : elle serait refusée tant qu'elle n'est pas ajoutée.`;
}

/** Prompt d'un tour de conception : consignes, données disponibles, conversation. */
export function designPrompt({ messages, timezone, hostDataDir, allowedTools, channels = [] }) {
  const transcript = transcriptOf(messages);
  return `Tu aides l'administrateur de « ronde » à concevoir une ronde. Une ronde est un prompt que Claude exécutera seul, sans personne pour lui répondre, avec \`claude -p\`, sur ce serveur, à heure fixe (cron) ou à la demande.

Règles d'une ronde :
- Le prompt de la ronde doit demander de répondre exactement « RAS » s'il n'y a rien à signaler. Toute autre réponse déclenche une alerte par mail : elle doit alors être courte et donner les chiffres utiles.
- Les données du serveur sont lisibles dans ${hostDataDir} avec l'outil Read. Fichiers disponibles :
${hostDataListing(hostDataDir)}
- ${toolsRule(allowedTools)}
- Fréquence : expression cron à 5 champs, fuseau ${timezone}. Chaîne vide pour une ronde manuelle.
- ${channelsContext(channels)} Si l'administrateur veut recevoir la réponse quelque part, ou si la ronde appelle un canal API, ajoute "canaux": [{"nom": "...", "quand": "alerte" | "toujours"}, {"nom": "<canal Mail ou SMTP>", "quand": "alerte", "destinataires": ["..."]}, {"nom": "<canal API>", "requetes": [...]}] à la ronde proposée ("destinataires" facultatif).

Ta démarche :
1. Si c'est utile, lis les fichiers de ${hostDataDir} pour connaître les valeurs actuelles et proposer des seuils réalistes.
2. S'il te manque une information importante (seuil, exception connue, fréquence), pose au plus 3 questions courtes.
3. Sinon, propose la ronde complète et explique tes choix en 2 ou 3 phrases.
4. Quand l'administrateur valide explicitement ta dernière proposition (« ok », « vas-y », « crée-la »…), crée-la avec l'action « creer », en reprenant cette proposition (avec ses éventuels derniers ajustements). Réponds alors en une phrase claire ce que tu as créé, sans plus. Sans accord explicite, ne crée rien : propose.

Réponds en français, de façon concise. Termine TOUJOURS ta réponse par un bloc \`\`\`json contenant soit
{"type": "question"}
soit
{"type": "proposal", "ronde": {"name": "...", "prompt": "...", "cron": "...", "allowed_tools": ["Read"], "max_turns": 4, "timeout_sec": 300}}
soit
{"type": "action", "action": "creer", "ronde": {"name": "...", "prompt": "...", "cron": "...", "allowed_tools": ["Read"], "max_turns": 4, "timeout_sec": 300}}

Conversation jusqu'ici :

${transcript}`;
}

/**
 * Prompt d'un tour de réglage : l'administrateur commente le résultat d'un
 * passage d'une ronde existante. Claude explique et, si on le lui demande,
 * propose une nouvelle version de la ronde.
 */
export function tunePrompt({ task, run, runCommented = true, messages, timezone, hostDataDir, allowedTools, channels = [], taskChannels = [] }) {
  const transcript = transcriptOf(messages);
  const etat = task.archived_at ? `archivée depuis le ${task.archived_at.slice(0, 10)} (elle ne tourne plus)` : task.active ? 'active' : 'en pause';
  const cut = (t, n) => (t && t.length > n ? `${t.slice(0, n)}\n[… tronqué]` : t);
  const runPart = run
    ? `${runCommented ? 'Passage que l\'administrateur regarde en ce moment' : 'Dernier passage'} (${run.started_at}, ${run.trigger === 'manual' ? 'lancé à la main' : 'planifié'}, statut ${run.status}${run.num_turns != null ? `, ${run.num_turns} tours` : ''}) :
<reponse>
${cut(run.result, 6000) ?? '(aucune réponse)'}
</reponse>${run.error ? `\nErreur : ${run.error}` : ''}`
    : '(aucun passage pour l\'instant)';
  return `Tu aides l'administrateur de « ronde » à comprendre et régler une ronde existante. Une ronde est un prompt que Claude exécute seul, sans personne pour lui répondre, avec \`claude -p\`, sur ce serveur, à heure fixe (cron) ou à la demande. S'il n'y a rien à signaler, la ronde doit répondre exactement « RAS » ; toute autre réponse déclenche une alerte par mail.

La ronde « ${task.name} » :
- État : ${etat}
- Fréquence : ${task.cron ? `\`${task.cron}\` (fuseau ${timezone})` : 'manuelle'}
- Outils : ${task.allowed_tools.join(', ') || 'aucun'} ; tours maximum : ${task.max_turns} ; délai : ${task.timeout_sec} s
- ${channelsContext(channels, taskChannels)}
- Prompt actuel :
<prompt>
${task.prompt}
</prompt>

${runPart}

Les données du serveur sont lisibles dans ${hostDataDir} avec l'outil Read :
${hostDataListing(hostDataDir)}

Ta démarche :
- Si l'administrateur demande pourquoi la ronde a répondu ainsi, explique-le à partir du prompt et des données (relis-les si c'est utile), en citant les chiffres.
- S'il veut que la ronde se comporte autrement la prochaine fois, propose la ronde modifiée : garde ce qui marche, change seulement ce qui est nécessaire, et dis en une ou deux phrases ce que tu as changé.
- ${toolsRule(allowedTools, task.allowed_tools)}
- S'il manque une information importante, pose au plus 2 questions courtes.
- Tu peux agir sur la ronde, mais UNIQUEMENT sur accord explicite de l'administrateur (« ok », « vas-y », « applique », « mets-la en pause », « remets-la active »…), et seulement pour ce qui vient d'être discuté. Actions : « modifier » (applique une version de la ronde, tous les champs repris), « canaux » (remplace la liste des canaux de la ronde, parmi les canaux configurés), « pause », « reprendre », « archiver », « restaurer » (sort des archives ; ajoute "active": true si on te demande aussi de la réactiver). Une ronde archivée ne peut qu'être restaurée.
- Quand tu agis, dis-le en une phrase claire (« C'est fait : alerte au-dessus de 95 %, /boot ignoré. »), sans roman, sauf si on te demande le détail.
- Les lignes [Historique] de la conversation sont écrites par ronde : c'est la trace fiable de ce qui a été fait (création, modifications avec le prompt avant / après, pauses, archivage). Appuie-toi dessus pour savoir où en est la ronde ou revenir à une version précédente.

Réponds en français, de façon concise. Termine TOUJOURS ta réponse par un bloc \`\`\`json contenant soit
{"type": "answer"}
soit
{"type": "proposal", "ronde": {"name": "...", "prompt": "...", "cron": "...", "allowed_tools": ["Read"], "max_turns": 4, "timeout_sec": 300}}
soit
{"type": "action", "action": "modifier", "ronde": {"name": "...", "prompt": "...", "cron": "...", "allowed_tools": ["Read"], "max_turns": 4, "timeout_sec": 300, "canaux": [...]}} ("canaux" facultatif : la liste complète, pour changer prompt et canaux d'un seul coup)
soit
{"type": "action", "action": "canaux", "canaux": [{"nom": "...", "quand": "alerte" | "toujours"}, {"nom": "<canal Mail ou SMTP>", "quand": "alerte", "destinataires": ["..."]}, {"nom": "<canal API>", "requetes": [{"methode": "POST", "chemin": "/...", "corps": {...}}]}]} (liste complète, canaux déjà branchés et leurs destinataires compris ; [] pour n'en garder aucun)
soit
{"type": "action", "action": "pause"} (ou "reprendre", "archiver", {"type": "action", "action": "restaurer", "active": true})
(dans une proposition ou une modification, reprends tous les champs, y compris ceux qui ne changent pas).

Conversation jusqu'ici :

${transcript}`;
}

export function createAsks({ db, store, channels = null, relay = null, config, claudeAuth, log = console }) {
  const q = (sql) => db.prepare(sql);
  // Plusieurs conversations en parallèle (plafond : mémoire du serveur, quota Claude),
  // mais une seule réponse à la fois dans une même conversation.
  const maxParallel = Math.max(1, config.maxParallelAsks ?? 3);
  const running = new Set();
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
      // Règles signalées par la dernière réponse de Claude, pas encore dans la liste proposable.
      missing_tools: (() => {
        const last = JSON.parse(row.messages).findLast((m) => m.role !== 'history');
        return last?.role === 'claude' && last.missing ? forbiddenRules(last.missing, proposableTools(store)) : [];
      })(),
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

  async function call(id, prompt, allowedTools, maxTurns, timeoutSec, { apiChannels = false } = {}) {
    const auth = claudeAuth.resolve();
    if (!auth) return { r: { status: 'failed', error: 'Aucun token Claude configuré (Réglages).' }, out: null };
    const ctrl = new AbortController();
    controllers.set(id, ctrl);
    // En conversation (avec l'administrateur, en direct) : tous les canaux API, requêtes libres, pour essayer.
    const api = apiChannels && channels && relay ? channels.list().filter((c) => c.type === 'api') : [];
    const session = relay?.open({ label: `conversation #${id}`, allowed: api.map((c) => ({ name: c.name, free: true })) });
    try {
      const out = await runClaude({
        prompt,
        allowedTools: session ? [...allowedTools, session.tool] : allowedTools,
        mcpConfig: session?.mcpConfig ?? null,
        maxTurns,
        timeoutSec,
        auth,
        config,
        timezone: config.timezone,
        onEvent: onEventFor(id),
        signal: ctrl.signal,
      });
      return { r: classify(out), out };
    } finally {
      session?.close();
      live.delete(id);
      controllers.delete(id);
    }
  }

  /** raw = prompt envoyé tel quel (essai d'une ronde proposée, comme un vrai passage). */
  async function runExec(id, raw) {
    const ask = parse(q('SELECT * FROM asks WHERE id = ?').get(id));
    const tools = ask.allowed_tools;
    const question = ask.messages.at(-1).text;
    const chans = channels ? channels.list() : [];
    const full = raw
      ? question
      : execPrompt({ text: question, history: ask.messages.slice(0, -1), hostDataDir: config.hostDataDir, inContainer: config.inContainer, tools, proposable: proposableTools(store), channels: chans });
    // Question de l'accueil : avec l'administrateur, en direct ; il peut essayer les canaux API (et lire leur doc).
    const { r, out } = await call(id, full, raw ? tools : [...tools, 'WebFetch'], 10, EXEC_TIMEOUT_SEC, { apiChannels: !raw });
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
        messages: JSON.stringify([...freshMessages(id), claudeMessage(text, block)]),
        error: null,
      });
      // Demande explicite de création : on enchaîne sur la conception, dans la même conversation.
      if (block?.creer === true) {
        update(id, { kind: 'design', status: 'running', suggest_ronde: 0 });
        await runDesignTurn(id);
      }
    }
  }

  /** Réponse de Claude, avec les règles qu'il signale comme manquantes (bouton d'ajout). */
  function claudeMessage(text, block) {
    const missing = missingRules(block?.manque, store);
    return { role: 'claude', text, ...(missing.length ? { missing } : {}) };
  }

  /** Messages relus en base : une entrée d'historique a pu s'ajouter pendant que Claude répondait. */
  const freshMessages = (id) => parse(q('SELECT * FROM asks WHERE id = ?').get(id)).messages;

  /** Une ronde proposée par Claude, complétée par la ronde existante, puis validée. */
  function candidateOf(ronde, base = {}) {
    const candidate = {
      name: ronde.name ?? base.name ?? '',
      prompt: ronde.prompt ?? base.prompt ?? '',
      cron: ronde.cron ?? base.cron ?? '',
      allowed_tools: Array.isArray(ronde.allowed_tools) ? ronde.allowed_tools : base.allowed_tools ? JSON.parse(base.allowed_tools) : ['Read'],
      max_turns: ronde.max_turns ?? base.max_turns ?? 4,
      timeout_sec: ronde.timeout_sec ?? base.timeout_sec ?? 300,
      active: base.active == null ? true : !!base.active,
      notify: base.notify == null ? true : !!base.notify,
      run_at: base.run_at ?? null,
    };
    const parsed = taskSchema(config.timezone).safeParse(candidate);
    if (!parsed.success) return { data: candidate, error: parsed.error.issues.map((i) => `${i.path.join('.')} : ${i.message}`).join(' ; ') };
    // Liste réglée par l'administrateur, plus les règles que la ronde existante porte déjà.
    const error = proposalToolsError(parsed.data.allowed_tools, store, base.allowed_tools ? JSON.parse(base.allowed_tools) : []);
    return error ? { data: parsed.data, error } : { data: parsed.data };
  }

  /** [{ nom, quand, destinataires? }] → [{ name, mode, recipients? }], en vérifiant que chaque canal existe. */
  function wantedChannels(list) {
    if (!channels) throw new Error('canaux indisponibles.');
    return list.map((c) => {
      const name = c.nom ?? c.name;
      if (!channels.findByName(name)) throw new Error(`canal « ${name} » introuvable (Réglages > Canaux).`);
      const quand = c.quand ?? c.mode;
      if (Array.isArray(c.requetes) || quand === 'libre') return { name, mode: quand === 'libre' ? 'free' : 'requests', requests: c.requetes ?? [] };
      const recipients = c.destinataires ?? c.recipients;
      return { name, mode: ['toujours', 'always'].includes(quand) ? 'always' : 'alert', ...(recipients ? { recipients } : {}) };
    });
  }

  /** Exécute l'action demandée par Claude, avec les mêmes fonctions que les boutons. Lève une erreur lisible. */
  function executeAction(ask, block) {
    const row = ask.task_id ? q('SELECT * FROM tasks WHERE id = ?').get(ask.task_id) : null;
    const action = block.action;
    if (action === 'creer') {
      if (row) throw new Error('cette conversation a déjà sa ronde.');
      const { data, error } = candidateOf(block.ronde ?? {});
      if (error) throw new Error(error);
      if (Array.isArray(block.ronde?.canaux)) channels.check(wantedChannels(block.ronde.canaux)); // vérifie avant de créer
      const taskId = store.createTask(data, { by: 'claude', askId: ask.id });
      if (Array.isArray(block.ronde?.canaux) && block.ronde.canaux.length) channels.setForTask(taskId, wantedChannels(block.ronde.canaux), { by: 'claude' });
      return;
    }
    if (!row) throw new Error('aucune ronde rattachée à cette conversation.');
    if (row.archived_at && action !== 'restaurer') throw new Error('la ronde est archivée : il faut d’abord la restaurer.');
    if (action === 'modifier') {
      const { data, error } = candidateOf(block.ronde ?? {}, row);
      if (error) throw new Error(error);
      // Prompt et canaux d'un seul « ok » (ex. requête API enregistrée + prompt qui l'appelle).
      const wanted = Array.isArray(block.ronde?.canaux) ? wantedChannels(block.ronde.canaux) : null;
      store.updateTask(row.id, data, { by: 'claude' });
      if (wanted) channels.setForTask(row.id, wanted, { by: 'claude' });
    } else if (action === 'canaux') {
      if (!Array.isArray(block.canaux)) throw new Error('liste de canaux manquante.');
      channels.setForTask(row.id, wantedChannels(block.canaux), { by: 'claude' });
    } else if (action === 'pause') store.setTaskActive(row.id, false, { by: 'claude' });
    else if (action === 'reprendre') store.setTaskActive(row.id, true, { by: 'claude' });
    else if (action === 'archiver') store.archiveTask(row.id, { by: 'claude' });
    else if (action === 'restaurer') store.restoreTask(row.id, { by: 'claude', active: block.active === true });
    else throw new Error(`action inconnue (${action}).`);
  }

  async function runDesignTurn(id) {
    const ask = parse(q('SELECT * FROM asks WHERE id = ?').get(id));
    // Relue à chaque tour : un changement dans les Réglages vaut dès le message suivant.
    const ctx = { messages: ask.messages, timezone: config.timezone, hostDataDir: config.hostDataDir, allowedTools: proposableTools(store), channels: channels ? channels.list() : [] };
    let prompt;
    // Conversation rattachée à une ronde (réglage, ou conception terminée) : on parle de la ronde existante.
    if (ask.task_id) {
      const row = q('SELECT * FROM tasks WHERE id = ?').get(ask.task_id);
      if (!row) {
        update(id, { status: 'failed', error: 'Ronde introuvable.' });
        return;
      }
      const task = { ...row, allowed_tools: JSON.parse(row.allowed_tools) };
      const run = ask.run_id
        ? q('SELECT * FROM runs WHERE id = ?').get(ask.run_id)
        : q(`SELECT * FROM runs WHERE task_id = ? AND status != 'running' ORDER BY started_at DESC, id DESC LIMIT 1`).get(ask.task_id);
      prompt = tunePrompt({ ...ctx, task, run, runCommented: !!ask.run_id, taskChannels: channels ? channels.forTask(task.id) : [] });
    } else {
      prompt = designPrompt(ctx);
    }
    // Outils de Claude lui-même pendant la conversation, indépendants de la liste proposable :
    // il peut proposer Bash(php -v) pour la ronde, jamais le lancer ici.
    // Conception et réglage : lire la doc d'une API (WebFetch) et essayer ses canaux.
    const { r } = await call(id, prompt, ['Read', 'Glob', 'WebFetch'], 12, DESIGN_TIMEOUT_SEC, { apiChannels: true });
    addUsage(id, r);
    if (r.status === 'failed') {
      update(id, { status: 'failed', error: r.error });
      return;
    }
    const block = extractJsonBlock(r.result);
    let text = stripJsonBlock(r.result) || '(réponse vide)';
    let proposal = null;
    let acted = false;
    if (block?.type === 'proposal' && block.ronde) {
      const base = ask.task_id ? (q('SELECT * FROM tasks WHERE id = ?').get(ask.task_id) ?? {}) : {};
      const { data, error } = candidateOf(block.ronde, base);
      proposal = { ...data, error: error ?? null };
    } else if (block?.type === 'action') {
      try {
        executeAction(ask, block);
        acted = true;
      } catch (err) {
        // Claude a pu écrire « c'est fait » : le fil ne doit pas mentir.
        text = `Je n'ai pas pu le faire : ${err.message}`;
      }
    }
    const current = parse(q('SELECT * FROM asks WHERE id = ?').get(id));
    const linked = !!current.task_id;
    update(id, {
      status: proposal ? 'proposal' : linked || acted ? 'done' : 'question',
      messages: JSON.stringify([...current.messages, { ...claudeMessage(text, block), ...(proposal ? { proposal: true } : {}) }]),
      // Après une action, la proposition est appliquée (ou caduque) : on la retire.
      proposal: proposal ? JSON.stringify(proposal) : acted ? null : current.proposal ? JSON.stringify(current.proposal) : null,
      error: null,
    });
  }

  function launch(id, job) {
    running.add(id);
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
        running.delete(id);
        inFlight.delete(done);
      });
    inFlight.add(done);
    return done;
  }

  return {
    /** Plafond atteint : aucune nouvelle conversation ne peut démarrer. */
    get busy() {
      return running.size >= maxParallel;
    },

    /** Lance une demande. Retourne { id, done } ou null si le plafond est atteint. */
    start(kind, text, tools, { raw = false, title = text, history = [], taskId = null, runId = null } = {}) {
      if (this.busy) return null;
      const now = nowIso();
      const messages = [...history, { role: 'user', text }];
      const id = Number(
        q(
          `INSERT INTO asks (kind, status, title, allowed_tools, messages, task_id, run_id, created_at, updated_at) VALUES (?, 'running', ?, ?, ?, ?, ?, ?, ?)`,
        ).run(kind, title.slice(0, 200), JSON.stringify(tools), JSON.stringify(messages), taskId, runId, now, now).lastInsertRowid,
      );
      const done = launch(id, () => (kind === 'exec' ? runExec(id, raw) : runDesignTurn(id)));
      // Ménage : on ne garde que les dernières demandes libres. Celles rattachées à une ronde restent.
      q(
        `DELETE FROM asks WHERE task_id IS NULL AND id NOT IN (SELECT id FROM asks WHERE task_id IS NULL ORDER BY created_at DESC, id DESC LIMIT ${HISTORY})`,
      ).run();
      return { id, done };
    },

    /** Suite de la conversation (demande ponctuelle ou conception). Retourne { done } ou { error }. */
    reply(id, text, { kind = null } = {}) {
      const ask = this.get(id);
      if (!ask) return { error: 'Demande introuvable.' };
      if (running.has(id) || ask.status === 'running') return { error: 'Claude réfléchit déjà, attends sa réponse.' };
      if (this.busy) return { error: 'Trop de conversations avec Claude en cours, réessaie dans un instant.' };
      // kind : « design » pour transformer une question en conception de ronde, dans la même conversation.
      const k = kind ?? ask.kind;
      update(id, { kind: k, status: 'running', suggest_ronde: 0, messages: JSON.stringify([...ask.messages, { role: 'user', text }]) });
      return { done: launch(id, () => (k === 'exec' && !ask.task_id ? runExec(id, false) : runDesignTurn(id))) };
    },

    /** Retire la proposition affichée (appliquée par le bouton). */
    clearProposal(id) {
      q(`UPDATE asks SET proposal = NULL, status = CASE WHEN status = 'running' THEN status ELSE 'done' END WHERE id = ?`).run(id);
    },

    /** Conversation de la ronde (une par ronde). */
    forTask(taskId) {
      return parse(q('SELECT * FROM asks WHERE task_id = ?').get(taskId));
    },

    /**
     * Message à Claude à propos d'une ronde : continue sa conversation, ou en ouvre une.
     * runId : passage que l'administrateur regarde (null : le dernier passage). Retourne { id, done } ou { error }.
     */
    talk(taskId, text, { runId = null, tools, title } = {}) {
      const conv = this.forTask(taskId);
      if (!conv) {
        const started = this.start('tune', text, tools, { title, taskId, runId });
        return started ?? { error: 'Trop de conversations avec Claude en cours, réessaie dans un instant.' };
      }
      q('UPDATE asks SET run_id = ? WHERE id = ?').run(runId, conv.id);
      const r = this.reply(conv.id, text);
      return r.error ? r : { id: conv.id, done: r.done };
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
      // Demandes libres seulement : celles devenues des rondes se retrouvent sur la page de leur ronde.
      return q("SELECT * FROM asks WHERE task_id IS NULL AND messages != '[]' ORDER BY created_at DESC, id DESC LIMIT ?").all(limit).map(parse);
    },

    recoverOrphans() {
      return q(`UPDATE asks SET status = 'failed', error = 'Interrompue : le serveur a redémarré.' WHERE status = 'running'`).run().changes;
    },

    drain() {
      return Promise.allSettled([...inFlight]);
    },
  };
}
