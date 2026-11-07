import { Cron } from 'croner';
import { classify, runClaude } from './runner.js';

const MINUTE = 60_000;

/** Valide une expression cron à 5 champs. Retourne un message d'erreur ou null. */
export function cronError(expr, timezone, { allowEmpty = false } = {}) {
  const value = String(expr ?? '').trim();
  if (!value && allowEmpty) return null;
  if (value.split(/\s+/).length !== 5) return 'Expression cron à 5 champs attendue (minute heure jour mois jour-semaine).';
  try {
    new Cron(value, { timezone, paused: true });
    return null;
  } catch (err) {
    return `Expression cron invalide : ${err.message}`;
  }
}

export function nextRuns(expr, timezone, count = 1, from = new Date()) {
  if (!expr) return [];
  try {
    return new Cron(expr, { timezone, paused: true }).nextRuns(count, from);
  } catch {
    return [];
  }
}

/** La tâche est-elle due pour la minute qui commence à `minuteStart` ? */
export function isDue(expr, timezone, minuteStart) {
  const next = nextRuns(expr, timezone, 1, new Date(minuteStart.getTime() - 1))[0];
  return !!next && next.getTime() === minuteStart.getTime();
}

/**
 * Exécute une tâche : crée le run (sauf si un run est déjà en cours), lance
 * claude, enregistre le résultat et envoie l'alerte si besoin.
 */
export function createExecutor({ store, config, claudeAuth, mailer, log = console }) {
  const inFlight = new Set();

  async function execute(runId, task) {
    const auth = claudeAuth.resolve();
    let outcome;
    if (!auth) {
      outcome = { status: 'failed', error: 'Aucun token Claude configuré (Réglages).', duration_ms: 0 };
    } else {
      const res = await runClaude({
        prompt: task.prompt,
        allowedTools: task.allowed_tools,
        maxTurns: task.max_turns,
        timeoutSec: task.timeout_sec,
        auth,
        config,
        timezone: config.timezone,
      });
      outcome = { ...classify(res), stderr: res.stderr, duration_ms: res.durationMs, token_type: auth.type };
    }
    store.finishRun(runId, outcome);

    if (outcome.status === 'alert' || outcome.status === 'failed') {
      const to = store.getSetting('alert_email');
      try {
        const sent = await mailer.sendRunAlert({ to, task, run: { id: runId, ...outcome } });
        if (sent) store.markAlertSent(runId);
      } catch (err) {
        log.error(`[ronde] envoi de l'alerte du run #${runId} impossible : ${err.message}`);
      }
    }
    return outcome;
  }

  return {
    /**
     * Démarre une tâche. Retourne { runId, done } ou null si un run est déjà en cours.
     * `done` est une promesse résolue à la fin du run (utile pour les tests).
     */
    start(task, trigger) {
      const runId = store.startRun(task.id, trigger);
      if (runId == null) return null;
      const done = execute(runId, task)
        .catch((err) => {
          log.error(`[ronde] run #${runId} : ${err.stack || err}`);
          try {
            store.finishRun(runId, { status: 'failed', error: `Erreur interne : ${err.message}` });
          } catch (dbErr) {
            log.error(`[ronde] run #${runId} : impossible d'enregistrer l'échec : ${dbErr.message}`);
          }
        })
        .finally(() => inFlight.delete(done));
      inFlight.add(done);
      return { runId, done };
    },
    /** Attend la fin des runs en cours (arrêt propre, tests). */
    drain() {
      return Promise.allSettled([...inFlight]);
    },
  };
}

/** Tick aligné sur chaque minute : lance les tâches actives dont le cron correspond. */
export function startScheduler({ store, executor, timezone, log = console, now = () => Date.now() }) {
  let timer = null;
  let lastMinute = 0;
  let stopped = false;

  /** Lance les tâches dues pour la minute `minuteStart` (ms). Retourne les runs démarrés. */
  function runDue(minuteStart) {
    if (minuteStart <= lastMinute) return [];
    lastMinute = minuteStart;
    const date = new Date(minuteStart);
    const started = [];
    for (const task of store.listActiveTasks()) {
      if (!isDue(task.cron, timezone, date)) continue;
      const run = executor.start(task, 'schedule');
      if (run) started.push(run);
      else log.warn(`[ronde] « ${task.name} » : run précédent encore en cours, exécution sautée`);
    }
    return started;
  }

  function tick() {
    try {
      runDue(Math.floor(now() / MINUTE) * MINUTE);
    } catch (err) {
      log.error(`[ronde] scheduler : ${err.stack || err}`);
    }
    schedule();
  }

  function schedule() {
    if (stopped) return;
    const delay = MINUTE - (now() % MINUTE) + 50;
    timer = setTimeout(tick, delay);
  }

  schedule();
  return {
    runDue,
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
  };
}
