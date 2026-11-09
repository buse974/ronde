import { z } from 'zod';
import { cronError } from './scheduler.js';

/** Une règle par ligne (ou séparée par des virgules hors parenthèses). */
export function parseToolList(raw) {
  const text = String(raw ?? '');
  const rules = [];
  let depth = 0;
  let current = '';
  for (const ch of text) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if ((ch === '\n' || ch === '\r' || (ch === ',' && depth === 0))) {
      rules.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  rules.push(current);
  return [...new Set(rules.map((r) => r.trim()).filter(Boolean))];
}

const TOOL_RULE = /^[A-Za-z][A-Za-z0-9_]*(\(.{1,200}\))?$/;

export function taskSchema(timezone) {
  return z.object({
    name: z.string().trim().min(1, 'Nom requis.').max(100, '100 caractères maximum.'),
    prompt: z.string().trim().min(1, 'Prompt requis.').max(20_000, '20 000 caractères maximum.'),
    cron: z
      .string()
      .trim()
      .superRefine((value, ctx) => {
        // Vide = tâche manuelle (lancée uniquement à la demande).
        const error = cronError(value, timezone, { allowEmpty: true });
        if (error) ctx.addIssue({ code: 'custom', message: error });
      }),
    allowed_tools: z
      .array(z.string().regex(TOOL_RULE, 'Règle d’outil invalide (ex : Read, Bash(df:*)).'))
      .max(30, '30 règles maximum.'),
    max_turns: z.coerce.number().int().min(1, 'Minimum 1.').max(50, 'Maximum 50.'),
    timeout_sec: z.coerce.number().int().min(30, 'Minimum 30 s.').max(3600, 'Maximum 3600 s.'),
    active: z.boolean(),
    // Passage unique (ISO UTC) : la tâche se désactive après lancement.
    run_at: z.string().nullable().optional().default(null),
    // Alerte par mail si la réponse n'est pas « RAS ».
    notify: z.boolean().optional().default(true),
  });
}

/** « 2026-11-10T08:00 » saisi dans le fuseau `timezone` → ISO UTC (ou null). */
export function localToUtc(local, timezone) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(local ?? '').trim());
  if (!m) return null;
  const [, y, mo, d, h, mi] = m.map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const offset = (t) => {
    const p = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', { timeZone: timezone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
        .formatToParts(new Date(t))
        .map((x) => [x.type, x.value]),
    );
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - t;
  };
  let t = guess - offset(guess);
  t = guess - offset(t); // second passage : changement d'heure
  return new Date(t).toISOString();
}

/** ISO UTC → « 2026-11-10T08:00 » dans le fuseau `timezone`. */
export function utcToLocal(iso, timezone) {
  if (!iso) return '';
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: timezone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      .formatToParts(new Date(iso))
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

/** Déclenchement d'une tâche : cron (planifiée), once (une seule fois) ou oneshot (à la main). */
export const triggerOf = (t) => (t.cron ? 'cron' : t.run_at ? 'once' : 'oneshot');

/** Valide le formulaire de tâche. Retourne { data } ou { errors, values }. */
export function parseTaskForm(body, timezone, now = new Date()) {
  const checked = (v) => v === 'on' || v === '1' || v === 'true';
  const trigger = ['cron', 'oneshot', 'once'].includes(body.trigger) ? body.trigger : String(body.cron ?? '').trim() ? 'cron' : 'oneshot';
  const runAtLocal = String(body.run_at ?? '').trim();
  const values = {
    name: body.name ?? '',
    prompt: body.prompt ?? '',
    cron: trigger === 'cron' ? body.cron ?? '' : '',
    allowed_tools: parseToolList(body.allowed_tools),
    max_turns: body.max_turns ?? '',
    timeout_sec: body.timeout_sec ?? '',
    active: trigger === 'once' ? true : checked(body.active),
    run_at: trigger === 'once' ? localToUtc(runAtLocal, timezone) : null,
    notify: checked(body.notify),
  };
  const errors = {};
  if (trigger === 'cron' && !String(values.cron).trim()) errors.cron = 'Indique une fréquence, ou choisis Oneshot.';
  if (trigger === 'once') {
    if (!values.run_at) errors.run_at = 'Indique la date et l’heure du passage.';
    else if (new Date(values.run_at) <= now) errors.run_at = 'Choisis une date à venir.';
  }
  const parsed = taskSchema(timezone).safeParse(values);
  if (!parsed.success) for (const issue of parsed.error.issues) errors[issue.path[0]] ??= issue.message;
  if (!Object.keys(errors).length) return { data: parsed.data };
  return { errors, values: { ...values, trigger, run_at_local: runAtLocal } };
}

export const setupSchema = z
  .object({
    setup_code: z.string().trim().min(1, 'Code d’installation requis.'),
    username: z
      .string()
      .trim()
      .min(1, 'Identifiant requis.')
      .max(50)
      .regex(/^[A-Za-z0-9._@-]+$/, 'Lettres, chiffres et . _ @ - uniquement.'),
    password: z.string().min(10, '10 caractères minimum.').max(200),
    password_confirm: z.string(),
    alert_email: z.union([z.literal(''), z.string().trim().email('Email invalide.')]),
    claude_token: z.string().trim().optional().default(''),
  })
  .refine((d) => d.password === d.password_confirm, {
    path: ['password_confirm'],
    message: 'Les mots de passe ne correspondent pas.',
  });

export const emailSchema = z.union([z.literal(''), z.string().trim().email('Email invalide.')]);

export function issuesToErrors(error) {
  const errors = {};
  for (const issue of error.issues) errors[issue.path[0] ?? '_'] ??= issue.message;
  return errors;
}
