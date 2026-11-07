import { describe, expect, it } from 'vitest';
import { cronError, isDue, startScheduler } from '../server/scheduler.js';
import { setup, silentLog, task } from './helpers.js';

const at = (iso) => new Date(iso);

describe('cron', () => {
  it('valide 5 champs uniquement', () => {
    expect(cronError('0 * * * *', 'UTC')).toBeNull();
    expect(cronError('0 0 * * * *', 'UTC')).toMatch(/5 champs/);
    expect(cronError('99 * * * *', 'UTC')).toMatch(/invalide/);
    expect(cronError('', 'UTC')).toMatch(/5 champs/);
  });
  it('isDue respecte le fuseau', () => {
    // 8h à Paris (UTC+1 en novembre) = 7h UTC
    expect(isDue('0 8 * * *', 'Europe/Paris', at('2026-11-09T07:00:00Z'))).toBe(true);
    expect(isDue('0 8 * * *', 'Europe/Paris', at('2026-11-09T08:00:00Z'))).toBe(false);
    expect(isDue('*/15 * * * *', 'UTC', at('2026-11-09T10:45:00Z'))).toBe(true);
    expect(isDue('*/15 * * * *', 'UTC', at('2026-11-09T10:46:00Z'))).toBe(false);
  });
});

describe('scheduler', () => {
  it('lance les tâches actives dues, une seule fois par minute, sans chevauchement', async () => {
    const ctx = setup();
    const due = ctx.store.createTask(task({ name: 'due', cron: '0 * * * *', prompt: 'MODE:sleep', timeout_sec: 1 }));
    ctx.store.createTask(task({ name: 'inactive', cron: '0 * * * *', active: false }));
    ctx.store.createTask(task({ name: 'later', cron: '30 * * * *' }));

    const sched = startScheduler({ store: ctx.store, executor: ctx.executor, timezone: 'UTC', log: silentLog, now: () => 0 });
    sched.stop();

    const t0 = at('2026-11-09T10:00:00Z').getTime();
    const first = sched.runDue(t0);
    expect(first).toHaveLength(1);
    expect(sched.runDue(t0)).toHaveLength(0); // même minute : rien

    // L'heure suivante, le run précédent tourne toujours : sauté.
    expect(sched.runDue(t0 + 3600_000)).toHaveLength(0);
    expect(ctx.store.listRuns(due)).toHaveLength(1);
    await first[0].done;
  }, 10_000);

  it('un run manuel est refusé si un run est en cours', () => {
    const ctx = setup();
    const t = ctx.store.getTask(ctx.store.createTask(task({ prompt: 'MODE:sleep' })));
    expect(ctx.store.startRun(t.id, 'manual')).not.toBeNull();
    expect(ctx.executor.start(t, 'manual')).toBeNull();
  });

  it('les runs orphelins passent en échec au démarrage', () => {
    const ctx = setup();
    const id = ctx.store.createTask(task());
    const runId = ctx.store.startRun(id, 'schedule');
    expect(ctx.store.recoverOrphanRuns()).toBe(1);
    expect(ctx.store.getRun(runId)).toMatchObject({ status: 'failed' });
  });
});
