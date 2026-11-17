import { nowIso } from './db.js';

/** Accès aux données. Toutes les fonctions sont synchrones (better-sqlite3). */
export function createStore(db) {
  const stmt = (sql) => db.prepare(sql);

  const parseTask = (row) =>
    row ? { ...row, active: !!row.active, notify: !!row.notify, allowed_tools: JSON.parse(row.allowed_tools) } : null;

  /** Qui a fait le changement, pour l'historique. */
  const BY = {
    ui: 'depuis l’interface',
    claude: 'par Claude, sur ton accord',
    mcp: 'via MCP',
    form: 'depuis le formulaire',
    scheduler: 'automatiquement',
  };
  const FIELDS = {
    name: 'nom',
    cron: 'fréquence',
    run_at: 'passage unique',
    allowed_tools: 'outils',
    max_turns: 'tours maximum',
    timeout_sec: 'délai maximum',
    active: 'active',
    notify: 'alerte mail',
  };
  const show = (k, v) => {
    if (k === 'allowed_tools') return v.join(', ') || 'aucun';
    if (k === 'active' || k === 'notify') return v ? 'oui' : 'non';
    if (k === 'cron') return v || 'manuelle';
    return v ?? '—';
  };

  /**
   * Ajoute une entrée d'historique (message invisible, sauf en mode debug) à la
   * conversation de la ronde. C'est la mémoire de la ronde : Claude la relit à chaque message.
   */
  function addHistory(taskId, text, details = {}) {
    const conv = stmt('SELECT id, messages FROM asks WHERE task_id = ?').get(taskId);
    if (!conv) return;
    const messages = JSON.parse(conv.messages);
    messages.push({ role: 'history', at: nowIso(), text, ...details });
    stmt('UPDATE asks SET messages = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(messages), nowIso(), conv.id);
  }

  return {
    db,

    // --- Réglages ---------------------------------------------------------
    getSetting(key) {
      return stmt('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null;
    },
    setSetting(key, value) {
      stmt(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      ).run(key, value, nowIso());
    },
    deleteSetting(key) {
      stmt('DELETE FROM settings WHERE key = ?').run(key);
    },

    // --- Sessions ---------------------------------------------------------
    createSession(idHash, username, expiresAt) {
      stmt('INSERT INTO sessions (id_hash, username, expires_at) VALUES (?, ?, ?)').run(idHash, username, expiresAt);
    },
    getSession(idHash) {
      return stmt('SELECT * FROM sessions WHERE id_hash = ? AND expires_at > ?').get(idHash, Date.now()) ?? null;
    },
    deleteSession(idHash) {
      stmt('DELETE FROM sessions WHERE id_hash = ?').run(idHash);
    },
    purgeSessions() {
      stmt('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
    },

    // --- Tâches -----------------------------------------------------------
    /** Rondes en service (ou archivées, avec archived = true). */
    listTasks({ archived = false } = {}) {
      return stmt(
        `SELECT t.*,
                r.id AS last_run_id, r.status AS last_status, r.started_at AS last_started_at,
                substr(COALESCE(r.error, r.result), 1, 160) AS last_excerpt,
                (SELECT COALESCE(SUM(cost_usd), 0) FROM runs WHERE task_id = t.id
                   AND started_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 days')) AS cost_30d
           FROM tasks t
           LEFT JOIN runs r ON r.id = (SELECT id FROM runs WHERE task_id = t.id ORDER BY started_at DESC, id DESC LIMIT 1)
          WHERE t.archived_at IS ${archived ? 'NOT NULL' : 'NULL'}
          ORDER BY ${archived ? 't.archived_at DESC' : 't.name COLLATE NOCASE'}`,
      )
        .all()
        .map(parseTask);
    },
    countArchived() {
      return stmt('SELECT COUNT(*) AS n FROM tasks WHERE archived_at IS NOT NULL').get().n;
    },
    listActiveTasks() {
      // Les tâches sans cron sont manuelles : le scheduler les ignore.
      return stmt("SELECT * FROM tasks WHERE active = 1 AND cron != '' AND archived_at IS NULL").all().map(parseTask);
    },
    /** Passages uniques arrivés à échéance. */
    listDueOnce(untilIso) {
      return stmt("SELECT * FROM tasks WHERE active = 1 AND cron = '' AND run_at IS NOT NULL AND run_at <= ? AND archived_at IS NULL")
        .all(untilIso)
        .map(parseTask);
    },
    getTask(id) {
      return parseTask(stmt('SELECT * FROM tasks WHERE id = ?').get(id));
    },
    addHistory,

    /**
     * Crée la ronde. La conversation vient d'abord : askId est la conversation qui l'a
     * fait naître, elle devient celle de la ronde. Sans conversation (MCP, formulaire),
     * une conversation est ouverte pour elle. Dans tous les cas, l'historique le note.
     */
    createTask(t, { by = 'ui', askId = null } = {}) {
      const now = nowIso();
      return db.transaction(() => {
        const info = stmt(
          `INSERT INTO tasks (name, prompt, cron, allowed_tools, max_turns, timeout_sec, active, created_via, run_at, notify, created_at, updated_at)
           VALUES (@name, @prompt, @cron, @allowed_tools, @max_turns, @timeout_sec, @active, @created_via, @run_at, @notify, @now, @now)`,
        ).run({
          ...t,
          allowed_tools: JSON.stringify(t.allowed_tools),
          active: t.active ? 1 : 0,
          created_via: t.created_via ?? (by === 'mcp' ? 'mcp' : 'ui'),
          run_at: t.run_at ?? null,
          notify: t.notify === false ? 0 : 1,
          now,
        });
        const id = Number(info.lastInsertRowid);
        const linked = askId
          ? stmt(
              `UPDATE asks SET task_id = ?, kind = 'tune', proposal = NULL, suggest_ronde = 0,
                      status = CASE WHEN status = 'running' THEN status ELSE 'done' END, updated_at = ?
                WHERE id = ? AND task_id IS NULL`,
            ).run(id, now, askId).changes
          : 0;
        if (!linked) {
          stmt(`INSERT INTO asks (kind, status, title, task_id, created_at, updated_at) VALUES ('tune', 'done', ?, ?, ?, ?)`).run(
            t.name.slice(0, 200),
            id,
            now,
            now,
          );
        }
        const kind = t.cron ? 'Ronde' : 'Oneshot';
        addHistory(id, `${kind} « ${t.name} » créé${kind === 'Ronde' ? 'e' : ''} ${BY[by] ?? by}.`, {
          by,
          after: { name: t.name, cron: t.cron, run_at: t.run_at ?? null, allowed_tools: t.allowed_tools, max_turns: t.max_turns, timeout_sec: t.timeout_sec, notify: t.notify !== false, prompt: t.prompt },
        });
        return id;
      })();
    },

    /** Modifie la ronde et note dans l'historique ce qui a changé (prompt avant / après compris). */
    updateTask(id, t, { by = 'ui' } = {}) {
      return db.transaction(() => {
        const before = parseTask(stmt('SELECT * FROM tasks WHERE id = ?').get(id));
        stmt(
          `UPDATE tasks SET name = @name, prompt = @prompt, cron = @cron, allowed_tools = @allowed_tools,
                  max_turns = @max_turns, timeout_sec = @timeout_sec, active = @active, run_at = @run_at,
                  notify = @notify, updated_at = @now
            WHERE id = @id`,
        ).run({
          ...t,
          id,
          allowed_tools: JSON.stringify(t.allowed_tools),
          active: t.active ? 1 : 0,
          run_at: t.run_at ?? null,
          notify: t.notify === false ? 0 : 1,
          now: nowIso(),
        });
        if (!before) return;
        const after = { ...before, ...t, notify: t.notify !== false, run_at: t.run_at ?? null, active: !!t.active };
        const changes = Object.keys(FIELDS)
          .filter((k) => JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null))
          .map((k) => `${FIELDS[k]} : ${show(k, before[k])} → ${show(k, after[k])}`);
        const promptChanged = before.prompt !== after.prompt;
        if (promptChanged) changes.push('prompt modifié');
        if (!changes.length) return;
        addHistory(id, `Ronde modifiée ${BY[by] ?? by} : ${changes.join(' ; ')}.`, {
          by,
          ...(promptChanged ? { prompt_before: before.prompt, prompt_after: after.prompt } : {}),
        });
      })();
    },

    setTaskActive(id, active, { by = 'ui', reason = null } = {}) {
      const res = stmt('UPDATE tasks SET active = ?, updated_at = ? WHERE id = ? AND active != ?').run(active ? 1 : 0, nowIso(), id, active ? 1 : 0);
      if (res.changes) addHistory(id, reason ?? `${active ? 'Réactivée' : 'Mise en pause'} ${BY[by] ?? by}.`, { by });
    },

    /** Archive au lieu de supprimer : la ronde ne tourne plus, sa conversation et ses passages restent. */
    archiveTask(id, { by = 'ui' } = {}) {
      const res = stmt('UPDATE tasks SET archived_at = ?, active = 0, updated_at = ? WHERE id = ? AND archived_at IS NULL').run(nowIso(), nowIso(), id);
      if (res.changes) addHistory(id, `Archivée ${BY[by] ?? by}. Elle ne tourne plus.`, { by });
    },

    /** Sort la ronde des archives, en pause sauf si active = true. */
    restoreTask(id, { by = 'ui', active = false } = {}) {
      const res = stmt('UPDATE tasks SET archived_at = NULL, active = ?, updated_at = ? WHERE id = ? AND archived_at IS NOT NULL').run(active ? 1 : 0, nowIso(), id);
      if (res.changes) addHistory(id, `Restaurée ${BY[by] ?? by}${active ? ', et réactivée' : ', en pause'}.`, { by });
    },


    // --- Runs -------------------------------------------------------------
    /**
     * Crée un run « running » sauf si la tâche en a déjà un en cours.
     * Retourne l'id du run, ou null si un run est déjà en cours.
     */
    startRun(taskId, trigger) {
      try {
        const info = stmt(`INSERT INTO runs (task_id, trigger, status, started_at) VALUES (?, ?, 'running', ?)`).run(
          taskId,
          trigger,
          nowIso(),
        );
        return Number(info.lastInsertRowid);
      } catch (err) {
        if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') return null;
        throw err;
      }
    },
    finishRun(id, r) {
      stmt(
        `UPDATE runs SET status = @status, finished_at = @finished_at, duration_ms = @duration_ms,
                exit_code = @exit_code, is_error = @is_error, timed_out = @timed_out, result = @result,
                error = @error, stderr = @stderr, input_tokens = @input_tokens, output_tokens = @output_tokens,
                cache_read_tokens = @cache_read_tokens, cache_creation_tokens = @cache_creation_tokens,
                cost_usd = @cost_usd, num_turns = @num_turns, session_id = @session_id,
                token_type = @token_type, raw_json = @raw_json
          WHERE id = @id`,
      ).run({
        id,
        status: r.status,
        finished_at: nowIso(),
        duration_ms: r.duration_ms ?? null,
        exit_code: r.exit_code ?? null,
        is_error: r.is_error == null ? null : r.is_error ? 1 : 0,
        timed_out: r.timed_out ? 1 : 0,
        result: r.result ?? null,
        error: r.error ?? null,
        stderr: r.stderr || null,
        input_tokens: r.input_tokens ?? null,
        output_tokens: r.output_tokens ?? null,
        cache_read_tokens: r.cache_read_tokens ?? null,
        cache_creation_tokens: r.cache_creation_tokens ?? null,
        cost_usd: r.cost_usd ?? null,
        num_turns: r.num_turns ?? null,
        session_id: r.session_id ?? null,
        token_type: r.token_type ?? null,
        raw_json: r.raw_json ?? null,
      });
    },
    markAlertSent(id) {
      stmt('UPDATE runs SET alert_sent = 1 WHERE id = ?').run(id);
    },
    getRun(id) {
      return (
        stmt('SELECT r.*, t.name AS task_name, t.timeout_sec FROM runs r JOIN tasks t ON t.id = r.task_id WHERE r.id = ?').get(id) ?? null
      );
    },
    listRuns(taskId, limit = 50, offset = 0) {
      return stmt('SELECT * FROM runs WHERE task_id = ? ORDER BY started_at DESC, id DESC LIMIT ? OFFSET ?').all(taskId, limit, offset);
    },
    countRuns(taskId) {
      return stmt('SELECT COUNT(*) AS n FROM runs WHERE task_id = ?').get(taskId).n;
    },
    taskStats(taskId) {
      const window = (days) =>
        stmt(
          `SELECT COUNT(*) AS runs,
                  SUM(status = 'ok') AS ok, SUM(status = 'alert') AS alert, SUM(status = 'failed') AS failed,
                  COALESCE(SUM(input_tokens + COALESCE(cache_read_tokens,0) + COALESCE(cache_creation_tokens,0)), 0) AS tokens_in,
                  COALESCE(SUM(output_tokens), 0) AS tokens_out,
                  COALESCE(SUM(cost_usd), 0) AS cost
             FROM runs WHERE task_id = ? AND status != 'running'
              AND started_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)`,
        ).get(taskId, `-${days} days`);
      return { d7: window(7), d30: window(30) };
    },
    /** Runs de toutes les rondes depuis `hours` heures (cadran). */
    runsSince(hours) {
      return stmt(
        `SELECT r.id, r.task_id, r.status, r.started_at, t.name AS task_name FROM runs r JOIN tasks t ON t.id = r.task_id
          WHERE t.archived_at IS NULL AND r.started_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?) ORDER BY r.started_at`,
      ).all(`-${hours} hours`);
    },
    /** Runs terminés d'une ronde sur `days` jours (bande des 30 nuits). */
    runsForDays(taskId, days) {
      return stmt(
        `SELECT status, started_at FROM runs WHERE task_id = ? AND status != 'running'
           AND started_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)`,
      ).all(taskId, `-${days} days`);
    },
    /** Au démarrage : un run resté « running » a été interrompu (crash, redéploiement). */
    recoverOrphanRuns() {
      return stmt(
        `UPDATE runs SET status = 'failed', finished_at = ?, error = 'Interrompu : le serveur a redémarré pendant le run'
          WHERE status = 'running'`,
      ).run(nowIso()).changes;
    },
  };
}
