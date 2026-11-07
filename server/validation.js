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
  });
}

/** Valide le formulaire de tâche. Retourne { data } ou { errors, values }. */
export function parseTaskForm(body, timezone) {
  const values = {
    name: body.name ?? '',
    prompt: body.prompt ?? '',
    cron: body.cron ?? '',
    allowed_tools: parseToolList(body.allowed_tools),
    max_turns: body.max_turns ?? '',
    timeout_sec: body.timeout_sec ?? '',
    active: body.active === 'on' || body.active === '1' || body.active === 'true',
  };
  const parsed = taskSchema(timezone).safeParse(values);
  if (parsed.success) return { data: parsed.data };
  const errors = {};
  for (const issue of parsed.error.issues) {
    const key = issue.path[0];
    errors[key] ??= issue.message;
  }
  return { errors, values };
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
