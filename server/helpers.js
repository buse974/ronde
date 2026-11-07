import cronstrue from 'cronstrue/i18n.js';
import { nextRuns } from './scheduler.js';

/** Fonctions de formatage exposées aux templates sous `it.h`. */
export function createHelpers(timezone) {
  const dateFmt = new Intl.DateTimeFormat('fr-FR', { timeZone: timezone, dateStyle: 'short', timeStyle: 'medium' });
  const shortFmt = new Intl.DateTimeFormat('fr-FR', { timeZone: timezone, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const num = new Intl.NumberFormat('fr-FR');

  return {
    date: (iso) => (iso ? dateFmt.format(new Date(iso)) : '—'),
    short: (iso) => (iso ? shortFmt.format(new Date(iso)) : '—'),
    duration(ms) {
      if (ms == null) return '—';
      if (ms < 1000) return `${ms} ms`;
      const s = Math.round(ms / 1000);
      return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`;
    },
    cost: (usd) => (usd == null ? '—' : `${Number(usd).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: usd < 1 ? 4 : 2 })} $`),
    tokens: (n) => (n == null ? '—' : num.format(n)),
    tokensIn: (run) =>
      run.input_tokens == null ? null : run.input_tokens + (run.cache_read_tokens ?? 0) + (run.cache_creation_tokens ?? 0),
    cronText(expr) {
      try {
        return cronstrue.toString(expr, { locale: 'fr', use24HourTimeFormat: true });
      } catch {
        return expr;
      }
    },
    nextRun(expr) {
      const [next] = nextRuns(expr, timezone, 1);
      return next ? shortFmt.format(next) : '—';
    },
    statusLabel: (s) => ({ running: 'En cours', ok: 'RAS', alert: 'Alerte', failed: 'Échec' })[s] ?? '—',
    tokenTypeLabel: (t) => ({ oauth: 'Abonnement (quota Claude)', api: 'Clé API (facturée à l’usage)' })[t] ?? 'Inconnu',
  };
}
