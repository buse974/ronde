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
      if (!expr) return 'Manuelle';
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
    ago(iso) {
      if (!iso) return '';
      const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
      if (min < 1) return 'à l’instant';
      if (min < 60) return `il y a ${min} min`;
      const hours = Math.round(min / 60);
      if (hours < 24) return `il y a ${hours} h`;
      const days = Math.round(hours / 24);
      return days === 1 ? 'hier' : `il y a ${days} jours`;
    },
    statusLabel: (s) => ({ running: 'En cours', ok: 'RAS', alert: 'Alerte', failed: 'Échec', done: 'Réponse' })[s] ?? '—',
    /** Déclenchement en clair. */
    triggerText(t) {
      if (t.cron) return this.cronText(t.cron);
      if (t.run_at) return `Une fois, le ${shortFmt.format(new Date(t.run_at))}`;
      return 'Oneshot';
    },
    tokenTypeLabel: (t) => ({ oauth: 'Abonnement (quota Claude)', api: 'Clé API (facturée à l’usage)' })[t] ?? 'Inconnu',
  };
}

const SEVERITY = { ok: 1, done: 1, alert: 2, failed: 3 };

/** Heure locale (fraction de jour, 0 à 1) dans le fuseau donné. */
function dayFraction(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  return (get('hour') * 60 + get('minute')) / 1440;
}

/**
 * Géométrie du cadran des 24 heures : la nuit ombrée, l'aiguille « maintenant »,
 * les passages des 24 prochaines heures (traits) et les runs des 24 dernières
 * heures (points colorés selon l'état). 0 h en haut, sens horaire.
 */
export function buildDial({ tasks, recentRuns, timezone, now = new Date(), size = 300, nightFrom = 20, nightTo = 7 }) {
  const c = size / 2;
  const at = (frac, r) => {
    const a = frac * 2 * Math.PI - Math.PI / 2;
    return { x: +(c + r * Math.cos(a)).toFixed(2), y: +(c + r * Math.sin(a)).toFixed(2) };
  };
  const rOuter = c - 14;
  const rBand = c - 34;
  const rInner = c - 58;

  // Arc de nuit (de nightFrom h à nightTo h, en passant par minuit).
  const from = at(nightFrom / 24, rBand);
  const to = at(nightTo / 24, rBand);
  const span = (24 - nightFrom + nightTo) / 24;
  const nightArc = `M ${from.x} ${from.y} A ${rBand} ${rBand} 0 ${span > 0.5 ? 1 : 0} 1 ${to.x} ${to.y}`;

  // Repères aux heures pleines : petits points ; 0, 6, 12, 18 h en chiffres au centre.
  const ticks = Array.from({ length: 24 }, (_, hour) => ({ hour, p: at(hour / 24, rOuter + 1), major: hour % 6 === 0 }));
  const labels = [0, 6, 12, 18].map((hour) => ({ hour, ...at(hour / 24, rInner - 26) }));

  const limit = now.getTime() + 24 * 3600 * 1000;
  const upcoming = [];
  for (const t of tasks) {
    if (t.run_at && t.active && !t.cron) {
      const d = new Date(t.run_at);
      if (d > now && d.getTime() <= limit) {
        const f = dayFraction(d, timezone);
        upcoming.push({ name: t.name, date: d, a: at(f, rInner - 6), b: at(f, rInner + 6) });
      }
    }
    if (!t.cron || !t.active) continue;
    for (const d of nextRuns(t.cron, timezone, 96, now)) {
      if (d.getTime() > limit || upcoming.length >= 400) break;
      const f = dayFraction(d, timezone);
      upcoming.push({ name: t.name, date: d, a: at(f, rInner - 6), b: at(f, rInner + 6) });
    }
  }
  const past = recentRuns.map((r) => ({
    ...r,
    p: at(dayFraction(new Date(r.started_at), timezone), rBand),
  }));
  // Les états graves sont dessinés en dernier pour rester visibles.
  past.sort((x, y) => (SEVERITY[x.status] ?? 0) - (SEVERITY[y.status] ?? 0));

  const nowFrac = dayFraction(now, timezone);
  return { size, c, rOuter, rBand, rInner, nightArc, ticks, labels, upcoming, past, hand: at(nowFrac, rInner - 16) };
}

/**
 * Main courante : les passages « RAS » consécutifs sont regroupés en une ligne
 * (comme dans un registre), pour que les alertes et échecs ressortent.
 */
export function groupRuns(runs, min = 3) {
  const out = [];
  let streak = [];
  const flush = () => {
    if (streak.length >= min) {
      out.push({
        group: true,
        runs: streak,
        count: streak.length,
        newest: streak[0],
        oldest: streak[streak.length - 1],
        cost: streak.reduce((s, r) => s + (r.cost_usd ?? 0), 0),
      });
    } else {
      out.push(...streak);
    }
    streak = [];
  };
  for (const r of runs) {
    if (r.status === 'ok') streak.push(r);
    else {
      flush();
      out.push(r);
    }
  }
  flush();
  return out;
}

/** Bande des N derniers jours : pire état de chaque jour (null = aucun run). */
export function buildStrip(runs, timezone, days = 30, now = new Date()) {
  const key = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  const worst = new Map();
  for (const r of runs) {
    const k = key(new Date(r.started_at));
    if ((SEVERITY[r.status] ?? 0) > (SEVERITY[worst.get(k)] ?? 0)) worst.set(k, r.status);
  }
  const label = new Intl.DateTimeFormat('fr-FR', { timeZone: timezone, weekday: 'short', day: 'numeric', month: 'short' });
  return Array.from({ length: days }, (_, i) => {
    const d = new Date(now.getTime() - (days - 1 - i) * 86400000);
    return { label: label.format(d), status: worst.get(key(d)) ?? null };
  });
}

/** Phrase de tête de la page des rondes. */
export function summarize({ tasks, recentRuns, timezone, now = new Date() }) {
  const count = (s) => recentRuns.filter((r) => r.status === s).length;
  const alerts = count('alert');
  const failed = count('failed');
  const hour = Math.floor(dayFraction(now, timezone) * 24);
  const night = hour >= 20 || hour < 7;
  let title;
  if (!tasks.length) title = 'Aucune ronde pour l’instant.';
  else if (failed) title = failed === 1 ? 'Un échec à regarder.' : `${failed} échecs à regarder.`;
  else if (alerts) title = alerts === 1 ? 'Une alerte à regarder.' : `${alerts} alertes à regarder.`;
  else title = night ? 'Cette nuit, tout est calme.' : 'Aujourd’hui, tout est calme.';

  let next = null;
  for (const t of tasks) {
    if (!t.active) continue;
    const [d] = t.cron ? nextRuns(t.cron, timezone, 1, now) : t.run_at && new Date(t.run_at) > now ? [new Date(t.run_at)] : [];
    if (d && (!next || d < next.date)) next = { date: d, name: t.name };
  }
  const active = tasks.filter((t) => (t.cron || t.run_at) && t.active).length;
  const manual = tasks.filter((t) => !t.cron && !t.run_at).length;
  return { title, alerts, failed, ok: count('ok'), total: recentRuns.length, next, active, manual };
}
