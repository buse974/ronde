import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { TEMPLATES } from './examples.js';
import { classify, runClaude, toolName } from './runner.js';
import { cronError, nextRuns } from './scheduler.js';
import { taskSchema } from './validation.js';

export const DEFAULT_MCP_TOOLS = ['Read', 'Grep', 'Glob'];

/** Outils qu'une ronde créée ou modifiée via MCP a le droit d'utiliser (Réglages). */
export function mcpAllowedTools(store) {
  const raw = store.getSetting('mcp_allowed_tools');
  return raw ? JSON.parse(raw) : DEFAULT_MCP_TOOLS;
}

/** Règles refusées par la politique MCP. */
export function forbiddenRules(rules, allowed) {
  return rules.filter((r) => !allowed.includes(r) && !allowed.includes(toolName(r)));
}

const ok = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
const fail = (message) => ({ isError: true, content: [{ type: 'text', text: message }] });
const clip = (s, n) => (s && s.length > n ? `${s.slice(0, n)}… [tronqué]` : s);

const STATUS_FR = {
  ok: 'RAS : rien à signaler',
  alert: 'Alerte : Claude signale un problème (un mail serait envoyé)',
  failed: 'Échec : erreur technique (un mail serait envoyé)',
  running: 'En cours',
};

const rondeFields = {
  name: z.string().describe('Nom court de la ronde'),
  prompt: z
    .string()
    .describe('Instructions pour Claude. Doit demander de répondre exactement « RAS » s’il n’y a rien à signaler.'),
  cron: z
    .string()
    .describe('Planification cron à 5 champs (fuseau du serveur). Chaîne vide = ronde manuelle, lancée uniquement à la demande.'),
  allowed_tools: z
    .array(z.string())
    .describe('Outils disponibles pour Claude (ex : ["Read"]). Limités par la politique MCP des Réglages.'),
  max_turns: z.number().int().min(1).max(50).describe('Nombre maximum de tours de Claude'),
  timeout_sec: z.number().int().min(30).max(3600).describe('Délai maximum du run en secondes'),
  active: z.boolean().describe('Active (pour une ronde planifiée)'),
};

/**
 * Serveur MCP de ronde (Streamable HTTP, sans session). Un McpServer est créé
 * par requête ; l'authentification OAuth est faite en amont (requireBearerAuth).
 */
export function createMcpHandler({ store, config, claudeAuth, executor, oauth, hostDataDir }) {
  const h = (p) => (config.publicUrl ? `${config.publicUrl}${p}` : p);
  let testRunning = false;

  function summary(t) {
    return {
      id: t.id,
      nom: t.name,
      mode: t.cron ? 'planifiée' : 'manuelle',
      cron: t.cron || null,
      prochain_run: t.cron && t.active ? nextRuns(t.cron, config.timezone, 1)[0]?.toISOString() ?? null : null,
      active: t.active,
      outils: t.allowed_tools,
      dernier_statut: t.last_status ?? null,
      dernier_run: t.last_started_at ?? null,
      cout_estime_30j_usd: t.cost_30d ?? null,
      creee_via: t.created_via,
      url: h(`/tasks/${t.id}`),
    };
  }

  function runView(r, long = false) {
    return {
      id: r.id,
      ronde_id: r.task_id,
      declencheur: r.trigger,
      statut: r.status,
      interpretation: STATUS_FR[r.status],
      debut: r.started_at,
      fin: r.finished_at,
      duree_ms: r.duration_ms,
      code_sortie: r.exit_code,
      is_error: r.is_error == null ? null : !!r.is_error,
      reponse: long ? clip(r.result, 20_000) : clip(r.result, 400),
      erreur: r.error,
      stderr: long ? clip(r.stderr, 4000) : undefined,
      tours: r.num_turns,
      tokens_entree: r.input_tokens == null ? null : r.input_tokens + (r.cache_read_tokens ?? 0) + (r.cache_creation_tokens ?? 0),
      tokens_sortie: r.output_tokens,
      cout_estime_usd: r.cost_usd,
      mail_envoye: !!r.alert_sent,
      url: h(`/runs/${r.id}`),
    };
  }

  /** Valide une ronde complète et la politique d'outils MCP. Retourne { data } ou { error }. */
  function validate(values) {
    const parsed = taskSchema(config.timezone).safeParse(values);
    if (!parsed.success) return { error: parsed.error.issues.map((i) => `${i.path.join('.')} : ${i.message}`).join('\n') };
    const forbidden = forbiddenRules(parsed.data.allowed_tools, mcpAllowedTools(store));
    if (forbidden.length) {
      return {
        error:
          `Outils non autorisés via MCP : ${forbidden.join(', ')}. ` +
          `Autorisés : ${mcpAllowedTools(store).join(', ')}. L’administrateur peut élargir cette liste dans Réglages > Accès MCP, ou créer la ronde dans l’interface.`,
      };
    }
    return { data: parsed.data };
  }

  function buildServer() {
    const server = new McpServer(
      { name: 'ronde', version: '0.2.0' },
      {
        instructions: [
          'ronde lance des « rondes » : des prompts Claude (claude -p) exécutés sur le serveur, planifiés (cron) ou manuels.',
          'Convention : le prompt demande de répondre exactement « RAS » s’il n’y a rien à signaler ; toute autre réponse est une alerte (mail).',
          'Les données de l’hôte (disque, fail2ban…) sont lisibles dans /host-metrics avec l’outil Read : list_host_data montre ce qui existe.',
          'Démarche attendue : comprendre le besoin, regarder les données (list_host_data, list_templates), poser les questions utiles à l’utilisateur (seuils, fréquence, exceptions),',
          'essayer le prompt avec test_prompt et montrer le résultat et le coût, puis créer la ronde avec create_ronde seulement après accord explicite de l’utilisateur.',
        ].join(' '),
      },
    );

    server.registerTool(
      'list_rondes',
      { title: 'Lister les rondes', description: 'Liste les rondes avec leur mode, planification, dernier statut et coût estimé sur 30 jours.', annotations: { readOnlyHint: true } },
      async () => ok(store.listTasks().map(summary)),
    );

    server.registerTool(
      'get_ronde',
      {
        title: 'Détail d’une ronde',
        description: 'Configuration complète d’une ronde, statistiques 7/30 jours et 5 derniers runs.',
        inputSchema: { id: z.number().int() },
        annotations: { readOnlyHint: true },
      },
      async ({ id }) => {
        const t = store.getTask(id);
        if (!t) return fail(`Ronde #${id} introuvable.`);
        return ok({
          ...summary({ ...t, ...store.listTasks().find((x) => x.id === id) }),
          prompt: t.prompt,
          max_turns: t.max_turns,
          timeout_sec: t.timeout_sec,
          stats: store.taskStats(id),
          derniers_runs: store.listRuns(id, 5).map((r) => runView(r)),
        });
      },
    );

    server.registerTool(
      'list_templates',
      { title: 'Modèles de rondes', description: 'Modèles prêts à l’emploi (prompt, outils, planification) et le script hôte dont ils dépendent.', annotations: { readOnlyHint: true } },
      async () => ok(Object.entries(TEMPLATES).map(([key, t]) => ({ cle: key, ...t }))),
    );

    server.registerTool(
      'preview_cron',
      {
        title: 'Vérifier une planification',
        description: 'Valide une expression cron à 5 champs, la traduit et donne les 5 prochaines exécutions.',
        inputSchema: { cron: z.string() },
        annotations: { readOnlyHint: true },
      },
      async ({ cron }) => {
        const error = cronError(cron, config.timezone);
        if (error) return fail(error);
        return ok({ cron, fuseau: config.timezone, prochaines: nextRuns(cron, config.timezone, 5).map((d) => d.toISOString()) });
      },
    );

    server.registerTool(
      'list_host_data',
      {
        title: 'Données de l’hôte',
        description: 'Liste les fichiers lisibles par les rondes dans /host-metrics (produits par les scripts hôte), avec leur âge et un aperçu.',
        annotations: { readOnlyHint: true },
      },
      async () => {
        let files;
        try {
          files = fs.readdirSync(hostDataDir).filter((f) => !f.startsWith('.'));
        } catch (err) {
          return fail(`Dossier ${hostDataDir} illisible : ${err.message}`);
        }
        return ok(
          files.map((f) => {
            const p = path.join(hostDataDir, f);
            try {
              const st = fs.statSync(p);
              if (!st.isFile()) return { chemin: `/host-metrics/${f}`, type: 'autre (non lu)' };
              return {
                chemin: `/host-metrics/${f}`,
                taille: st.size,
                modifie: st.mtime.toISOString(),
                age_minutes: Math.round((Date.now() - st.mtimeMs) / 60000),
                apercu: clip(fs.readFileSync(p, 'utf8').split('\n').slice(0, 30).join('\n'), 3000),
              };
            } catch (err) {
              return { chemin: `/host-metrics/${f}`, erreur: err.code || err.message };
            }
          }),
        );
      },
    );

    server.registerTool(
      'test_prompt',
      {
        title: 'Essayer un prompt',
        description:
          'Lance un essai réel de claude -p sur le serveur, dans les mêmes conditions qu’une ronde, sans rien enregistrer. ' +
          'Retourne le statut (RAS / alerte / échec), la réponse, les tours et le coût estimé. Consomme le quota Claude : un essai à la fois.',
        inputSchema: {
          prompt: z.string(),
          allowed_tools: z.array(z.string()).default(['Read']),
          max_turns: z.number().int().min(1).max(20).default(5),
          timeout_sec: z.number().int().min(30).max(600).default(300),
        },
      },
      async ({ prompt, allowed_tools, max_turns, timeout_sec }) => {
        const forbidden = forbiddenRules(allowed_tools, mcpAllowedTools(store));
        if (forbidden.length) return fail(`Outils non autorisés via MCP : ${forbidden.join(', ')}.`);
        const auth = claudeAuth.resolve();
        if (!auth) return fail('Aucun token Claude configuré dans ronde (Réglages).');
        if (testRunning) return fail('Un essai est déjà en cours, réessaie dans un instant.');
        testRunning = true;
        try {
          const out = await runClaude({ prompt, allowedTools: allowed_tools, maxTurns: max_turns, timeoutSec: timeout_sec, auth, config, timezone: config.timezone });
          const r = classify(out);
          return ok({
            statut: r.status,
            interpretation: STATUS_FR[r.status],
            reponse: clip(r.result, 20_000),
            erreur: r.error,
            stderr: r.status === 'failed' ? clip(out.stderr, 2000) : undefined,
            tours: r.num_turns,
            duree_ms: out.durationMs,
            cout_estime_usd: r.cost_usd,
            type_token: auth.type,
          });
        } finally {
          testRunning = false;
        }
      },
    );

    server.registerTool(
      'create_ronde',
      {
        title: 'Créer une ronde',
        description: 'Crée une ronde. À n’utiliser qu’après accord explicite de l’utilisateur sur le prompt, la planification et les outils.',
        inputSchema: { ...rondeFields, cron: rondeFields.cron.default(''), active: rondeFields.active.default(true), max_turns: rondeFields.max_turns.default(5), timeout_sec: rondeFields.timeout_sec.default(300) },
      },
      async (args) => {
        const { data, error } = validate(args);
        if (error) return fail(error);
        const id = store.createTask({ ...data, created_via: 'mcp' });
        return ok({ cree: true, ...summary(store.listTasks().find((t) => t.id === id)) });
      },
    );

    server.registerTool(
      'update_ronde',
      {
        title: 'Modifier une ronde',
        description: 'Modifie les champs fournis d’une ronde existante. À n’utiliser qu’après accord de l’utilisateur.',
        inputSchema: { id: z.number().int(), ...Object.fromEntries(Object.entries(rondeFields).map(([k, v]) => [k, v.optional()])) },
      },
      async ({ id, ...changes }) => {
        const t = store.getTask(id);
        if (!t) return fail(`Ronde #${id} introuvable.`);
        // Une ronde qui utilise des outils hors politique MCP (ajoutés dans l'interface) est
        // verrouillée : la modifier via MCP permettrait de détourner ces outils avec un autre prompt.
        const locked = forbiddenRules(t.allowed_tools, mcpAllowedTools(store));
        if (locked.length) {
          return fail(`Ronde #${id} verrouillée pour MCP : elle utilise ${locked.join(', ')}, hors des outils autorisables via MCP. Modifie-la dans l’interface.`);
        }
        const merged = { ...t, ...Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined)) };
        const { data, error } = validate(merged);
        if (error) return fail(error);
        store.updateTask(id, data);
        return ok({ modifie: true, ...summary(store.listTasks().find((x) => x.id === id)) });
      },
    );

    server.registerTool(
      'set_active',
      { title: 'Activer / désactiver', description: 'Active ou désactive une ronde planifiée.', inputSchema: { id: z.number().int(), active: z.boolean() } },
      async ({ id, active }) => {
        if (!store.getTask(id)) return fail(`Ronde #${id} introuvable.`);
        store.setTaskActive(id, active);
        return ok({ id, active });
      },
    );

    server.registerTool(
      'run_ronde',
      {
        title: 'Lancer une ronde',
        description: 'Lance une ronde existante maintenant (enregistré dans l’historique, mail si alerte ou échec). Par défaut, attend la fin du run.',
        inputSchema: { id: z.number().int(), attendre: z.boolean().default(true) },
      },
      async ({ id, attendre }) => {
        const t = store.getTask(id);
        if (!t) return fail(`Ronde #${id} introuvable.`);
        const started = executor.start(t, 'manual');
        if (!started) return fail('Un run de cette ronde est déjà en cours.');
        if (!attendre) return ok({ run_id: started.runId, statut: 'running', url: h(`/runs/${started.runId}`) });
        await started.done;
        return ok(runView(store.getRun(started.runId), true));
      },
    );

    server.registerTool(
      'get_run',
      { title: 'Détail d’un run', description: 'Réponse complète, erreur, tokens et coût d’un run.', inputSchema: { id: z.number().int() }, annotations: { readOnlyHint: true } },
      async ({ id }) => {
        const r = store.getRun(id);
        return r ? ok(runView(r, true)) : fail(`Run #${id} introuvable.`);
      },
    );

    server.registerTool(
      'list_runs',
      {
        title: 'Historique d’une ronde',
        description: 'Derniers runs d’une ronde (statut, réponse abrégée, coût).',
        inputSchema: { ronde_id: z.number().int(), limit: z.number().int().min(1).max(50).default(10) },
        annotations: { readOnlyHint: true },
      },
      async ({ ronde_id, limit }) => {
        if (!store.getTask(ronde_id)) return fail(`Ronde #${ronde_id} introuvable.`);
        return ok(store.listRuns(ronde_id, limit).map((r) => runView(r)));
      },
    );

    return server;
  }

  return async (req, res) => {
    if (req.auth?.extra?.grantId) oauth.touchGrant(req.auth.extra.grantId);
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  };
}
