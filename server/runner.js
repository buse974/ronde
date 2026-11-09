import { spawn } from 'node:child_process';
import { TOKEN_ENV_VAR } from './secrets.js';

/** Nom de l'outil d'une règle de permission : "Bash(df:*)" → "Bash". */
export function toolName(rule) {
  return rule.split('(')[0].trim();
}

/**
 * Arguments de `claude -p`. Le prompt passe par stdin (pas d'argument), ce qui
 * évite toute interprétation d'un prompt commençant par « - » et la limite de
 * taille des arguments.
 *  --tools        : restreint les outils disponibles (vide = aucun)
 *  --allowedTools : autorise ces règles sans demande de permission
 */
export function buildArgs({ allowedTools = [], maxTurns, stream = false }) {
  const tools = [...new Set(allowedTools.map(toolName))];
  const format = stream ? ['--output-format', 'stream-json', '--verbose', '--include-partial-messages'] : ['--output-format', 'json'];
  const args = ['-p', ...format, '--max-turns', String(maxTurns), '--no-session-persistence'];
  args.push('--tools', tools.length ? tools.join(',') : '');
  if (allowedTools.length) args.push('--allowedTools', ...allowedTools);
  return args;
}

/**
 * Environnement du process claude : construit de zéro, sans rien hériter du
 * process app (qui détient les secrets). Seul le token Claude est transmis.
 */
export function buildEnv({ auth, home, timezone, path = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' }) {
  const env = {
    PATH: path,
    HOME: home || process.env.HOME || '/tmp',
    LANG: 'C.UTF-8',
    TZ: timezone,
    CI: '1',
    DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  };
  if (auth) env[TOKEN_ENV_VAR[auth.type]] = auth.token;
  return env;
}

const RAS = /^\s*ras\s*[.!]*\s*$/i;
export const isRas = (text) => typeof text === 'string' && RAS.test(text);

/** Extrait l'objet résultat de la sortie JSON (objet unique, ou tableau d'événements). */
export function parseOutput(stdout) {
  const text = String(stdout ?? '').trim();
  if (!text) return null;
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (Array.isArray(data)) data = data.findLast((e) => e?.type === 'result') ?? null;
  return data && typeof data === 'object' ? data : null;
}

/**
 * Statut d'un run.
 * Échec si exit_code != 0 OU is_error === true (le champ subtype est ignoré),
 * ainsi que si la sortie n'est pas un JSON exploitable ou si le run a expiré.
 * Sinon « ok » si Claude répond RAS, « alert » dans tous les autres cas.
 */
export function classify({ exitCode, stdout, timedOut, spawnError }) {
  const json = parseOutput(stdout);
  const usage = json?.usage ?? {};
  const result = typeof json?.result === 'string' ? json.result : null;
  const isError = json?.is_error === true;

  let error = null;
  if (spawnError) error = `Impossible de lancer claude : ${spawnError}`;
  else if (timedOut) error = 'Délai dépassé : le run a été interrompu.';
  else if (exitCode !== 0) error = `claude s'est terminé avec le code ${exitCode}.`;
  else if (!json) error = 'Sortie JSON illisible.';
  else if (isError) error = 'Claude a signalé une erreur (is_error = true).';

  const failed = !!error;
  return {
    status: failed ? 'failed' : isRas(result) ? 'ok' : 'alert',
    error,
    exit_code: exitCode,
    is_error: json ? isError : null,
    timed_out: !!timedOut,
    result,
    input_tokens: usage.input_tokens ?? null,
    output_tokens: usage.output_tokens ?? null,
    cache_read_tokens: usage.cache_read_input_tokens ?? null,
    cache_creation_tokens: usage.cache_creation_input_tokens ?? null,
    cost_usd: typeof json?.total_cost_usd === 'number' ? json.total_cost_usd : null,
    num_turns: json?.num_turns ?? null,
    session_id: json?.session_id ?? null,
    raw_json: json ? JSON.stringify(json) : null,
  };
}

/** Processus claude en cours (pour l'arrêt du serveur). */
const active = new Set();

function killGroup(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* déjà terminé */
    }
  }
}

/** Arrête tous les runs en cours (arrêt du serveur). */
export function killAllRuns(signal = 'SIGTERM') {
  for (const child of active) killGroup(child, signal);
  return active.size;
}

function capped(limit) {
  const chunks = [];
  let size = 0;
  let truncated = false;
  return {
    push(chunk) {
      if (size >= limit) {
        truncated = true;
        return;
      }
      const slice = chunk.subarray(0, limit - size);
      if (slice.length < chunk.length) truncated = true;
      chunks.push(slice);
      size += slice.length;
    },
    toString() {
      return Buffer.concat(chunks).toString('utf8') + (truncated ? '\n[… tronqué]' : '');
    },
    get truncated() {
      return truncated;
    },
  };
}

/**
 * Lance claude et attend sa fin. Ne lève jamais : les erreurs sont dans le résultat.
 * @returns {Promise<{exitCode, stdout, stderr, timedOut, spawnError, durationMs}>}
 */
/**
 * onEvent : si fourni, claude tourne en stream-json et chaque événement (objet
 * JSON) est transmis au fil de l'eau ; stdout contient alors le seul événement
 * final « result », ce qui garde le reste du code identique.
 */
export function runClaude({ prompt, allowedTools, maxTurns, timeoutSec, auth, config, timezone, onEvent }) {
  const r = config.runner;
  const started = Date.now();
  const stream = typeof onEvent === 'function';
  const args = buildArgs({ allowedTools, maxTurns, stream });
  const options = {
    cwd: r.cwd || undefined,
    env: buildEnv({ auth, home: r.home, timezone, path: r.path }),
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
    // Groupe de processus dédié : le timeout tue claude ET ce qu'il a lancé.
    detached: true,
  };
  if (r.uid != null) options.uid = r.uid;
  if (r.gid != null) options.gid = r.gid;

  return new Promise((resolve) => {
    const stdout = capped(r.maxStdoutBytes);
    let pending = '';
    let finalEvent = null;
    const onLine = (line) => {
      if (!line.trim()) return;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (event.type === 'result') finalEvent = line;
      try {
        onEvent(event);
      } catch {
        /* un affichage en direct ne doit jamais casser le run */
      }
    };
    const stderr = capped(r.maxStderrBytes);
    let timedOut = false;
    let spawnError = null;
    let timer = null;
    let killTimer = null;
    let settled = false;

    const finish = (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      resolve({
        exitCode,
        stdout: stream ? (finalEvent ?? '') : stdout.truncated ? '' : stdout.toString(), // JSON tronqué = inexploitable
        stderr: stderr.toString() + (stdout.truncated ? '\n[sortie standard trop volumineuse, ignorée]' : ''),
        timedOut,
        spawnError,
        durationMs: Date.now() - started,
      });
    };

    let child;
    try {
      child = spawn(r.bin, args, options);
    } catch (err) {
      spawnError = err.message;
      return finish(null);
    }

    active.add(child);
    timer = setTimeout(() => {
      timedOut = true;
      killGroup(child, 'SIGTERM');
      killTimer = setTimeout(() => {
        killGroup(child, 'SIGKILL');
        // Filet de sécurité : si un descendant garde les pipes ouverts, « close »
        // n'arrive jamais. On termine le run quand même.
        killTimer = setTimeout(() => {
          child.stdout.destroy();
          child.stderr.destroy();
          finish(child.exitCode);
        }, 2000);
      }, r.killGraceMs);
    }, timeoutSec * 1000);

    child.stdout.on('data', (c) => {
      if (!stream) return stdout.push(c);
      pending += c.toString('utf8');
      let nl;
      while ((nl = pending.indexOf('\n')) >= 0) {
        onLine(pending.slice(0, nl));
        pending = pending.slice(nl + 1);
      }
      if (pending.length > r.maxStdoutBytes) pending = ''; // ligne démesurée : ignorée
    });
    child.stdout.on('end', () => {
      if (stream && pending) onLine(pending);
    });
    child.stderr.on('data', (c) => stderr.push(c));
    child.on('error', (err) => {
      spawnError = err.message;
      active.delete(child);
      finish(null);
    });
    child.on('exit', () => active.delete(child));
    child.on('close', (code) => finish(code));
    child.stdin.on('error', () => {}); // EPIPE si claude se termine sans lire stdin
    child.stdin.end(prompt);
  });
}
