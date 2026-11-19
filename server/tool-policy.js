import { toolName } from './runner.js';

/**
 * Outils que Claude peut proposer pour une ronde : une seule liste, réglée par
 * l'administrateur (Réglages > Outils proposables), valable pour la conception
 * dans l'interface et pour le MCP. Clé historique : mcp_allowed_tools.
 */
export const DEFAULT_PROPOSABLE_TOOLS = ['Read', 'Grep', 'Glob'];
export const PROPOSABLE_TOOLS_KEY = 'mcp_allowed_tools';

export function proposableTools(store) {
  const raw = store.getSetting(PROPOSABLE_TOOLS_KEY);
  return raw ? JSON.parse(raw) : DEFAULT_PROPOSABLE_TOOLS;
}

/**
 * Règles absentes de `allowed`. Une règle passe si elle y figure à l'identique,
 * ou si `allowed` contient le nom d'outil nu (Bash autorise toutes les règles Bash).
 */
export function forbiddenRules(rules, allowed) {
  return rules.filter((r) => !allowed.includes(r) && !allowed.includes(toolName(r)));
}

/**
 * Refus d'une ronde proposée par Claude dans l'interface, ou null.
 * `kept` : règles que la ronde porte déjà (réglage d'une ronde existante) ;
 * elles restent permises, on peut les garder ou les retirer, pas en ajouter d'autres.
 */
export function proposalToolsError(rules, store, kept = []) {
  const forbidden = forbiddenRules(rules, [...proposableTools(store), ...kept]);
  if (!forbidden.length) return null;
  return (
    `outils hors de la liste proposable : ${forbidden.join(', ')}. ` +
    `L'administrateur peut les ajouter dans Réglages > Outils proposables, ou créer la ronde dans le formulaire manuel`
  );
}

/**
 * Règle étroite : un outil et un motif précis, comme Bash(php -m) ou WebFetch(domain:php.net).
 * Refusés : le nom nu (Bash autorise tout l'outil) et les motifs qui ouvrent tout (Bash(*), Bash(:*)).
 */
export function isNarrowRule(rule) {
  const m = /^([A-Za-z][A-Za-z0-9_]*)\((.{1,200})\)$/.exec(String(rule ?? ''));
  if (!m) return false;
  const pattern = m[2].trim();
  return pattern !== '' && !/^[:*\s]*$/.test(pattern);
}

/** Règles réclamées par Claude (champ "manque"), réduites à celles qu'un clic peut ajouter. */
export function missingRules(raw, store) {
  if (!Array.isArray(raw)) return [];
  const rules = [...new Set(raw.filter((r) => typeof r === 'string').map((r) => r.trim()))].filter(isNarrowRule).slice(0, 5);
  return forbiddenRules(rules, proposableTools(store));
}

/** Ajoute une règle à la liste proposable (clic de l'administrateur). */
export function addProposableTool(store, rule) {
  const list = proposableTools(store);
  if (!list.includes(rule)) store.setSetting(PROPOSABLE_TOOLS_KEY, JSON.stringify([...list, rule]));
}
