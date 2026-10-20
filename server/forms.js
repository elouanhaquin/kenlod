import { run } from './db.js';
import { HttpError, validEmail, newToken } from './util.js';

// A form is stored in items.content as JSON:
// { title, description, confirmation, questions: [{ id, type, label, help, required, options?, min?, max?, minLabel?, maxLabel? }] }
export const QUESTION_TYPES = ['short', 'long', 'single', 'multiple', 'dropdown', 'scale', 'number', 'date', 'email', 'section'];
const CHOICE_TYPES = ['single', 'multiple', 'dropdown'];
const MAX_QUESTIONS = 200;

const str = (v, max) => (typeof v === 'string' ? v : v == null ? '' : String(v)).replace(/\r\n?/g, '\n').slice(0, max);

export const EMPTY_FORM = JSON.stringify({
  title: '',
  description: '',
  confirmation: 'Merci, votre réponse a bien été enregistrée !',
  questions: [{ id: 'q1', type: 'short', label: 'Nom et prénom', help: '', required: true }],
});

export function validateForm(def) {
  if (!def || typeof def !== 'object' || !Array.isArray(def.questions)) throw new HttpError(400, 'Questionnaire invalide');
  if (def.questions.length > MAX_QUESTIONS) throw new HttpError(400, `${MAX_QUESTIONS} questions au maximum`);
  const seen = new Set();
  const questions = def.questions.map((q) => {
    if (!q || typeof q !== 'object' || !QUESTION_TYPES.includes(q.type)) throw new HttpError(400, 'Type de question invalide');
    const id = str(q.id, 24);
    if (!/^[\w-]{1,24}$/.test(id) || seen.has(id)) throw new HttpError(400, 'Identifiant de question invalide');
    seen.add(id);
    const out = { id, type: q.type, label: str(q.label, 500), help: str(q.help, 1000) };
    if (q.type !== 'section') out.required = !!q.required;
    if (CHOICE_TYPES.includes(q.type)) {
      const options = (Array.isArray(q.options) ? q.options : []).map((o) => str(o, 200).trim()).filter(Boolean);
      out.options = [...new Set(options)].slice(0, 100);
      if (!out.options.length) out.options = ['Option 1'];
    }
    if (q.type === 'scale') {
      out.min = Number(q.min) === 0 ? 0 : 1;
      out.max = Math.min(Math.max(Math.round(Number(q.max)) || 5, 2), 10);
      out.minLabel = str(q.minLabel, 60);
      out.maxLabel = str(q.maxLabel, 60);
    }
    return out;
  });
  const result = {
    title: str(def.title, 200),
    description: str(def.description, 5000),
    confirmation: str(def.confirmation, 1000),
    questions,
  };
  return JSON.stringify(result);
}

export const parseForm = (content) => {
  try {
    return JSON.parse(content || EMPTY_FORM);
  } catch {
    return JSON.parse(EMPTY_FORM);
  }
};

// Checks submitted answers against the form. Returns { questionId: value } with only known, non-empty answers.
export function validateAnswers(form, raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  for (const q of form.questions) {
    if (q.type === 'section') continue;
    let v = input[q.id];
    const label = q.label || 'Question sans titre';
    if (q.type === 'multiple') {
      v = (Array.isArray(v) ? v : []).map((x) => String(x));
      if (v.some((x) => !q.options.includes(x))) throw new HttpError(400, `Réponse invalide : « ${label} »`);
      v = q.options.filter((o) => v.includes(o)); // keep the form's order, drop duplicates
      if (!v.length) v = undefined;
    } else if (v === undefined || v === null || (typeof v === 'string' && !v.trim())) {
      v = undefined;
    } else if (q.type === 'scale') {
      v = Number(v);
      if (!Number.isInteger(v) || v < q.min || v > q.max) throw new HttpError(400, `Réponse invalide : « ${label} »`);
    } else if (q.type === 'number') {
      v = Number(String(v).replace(',', '.').replace(/\s/g, ''));
      if (!Number.isFinite(v)) throw new HttpError(400, `Indiquez un nombre : « ${label} »`);
    } else {
      v = str(v, q.type === 'long' ? 10000 : 1000).trim();
      if (CHOICE_TYPES.includes(q.type) && !q.options.includes(v)) throw new HttpError(400, `Réponse invalide : « ${label} »`);
      if (q.type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new HttpError(400, `Date invalide : « ${label} »`);
      if (q.type === 'email' && !validEmail(v)) throw new HttpError(400, `Adresse e-mail invalide : « ${label} »`);
    }
    if (v === undefined) {
      if (q.required) throw new HttpError(400, `Réponse obligatoire : « ${label} »`);
      continue;
    }
    out[q.id] = v;
  }
  return out;
}

// Responses as a table: header row + one row per response (oldest first), values as text.
export function responsesTable(form, responses, { withUser }) {
  const questions = form.questions.filter((q) => q.type !== 'section');
  const header = ['Horodatage', ...(withUser ? ['Répondant·e'] : []), ...questions.map((q) => q.label || 'Question sans titre')];
  const fmt = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'medium', timeZone: 'Europe/Paris' });
  const rows = responses.map((r) => {
    const a = JSON.parse(r.answers);
    return [
      fmt.format(new Date(r.created_at)),
      ...(withUser ? [r.user_name ? `${r.user_name} <${r.user_email}>` : ''] : []),
      ...questions.map((q) => {
        const v = a[q.id];
        if (v === undefined) return '';
        return Array.isArray(v) ? v.join('; ') : String(v);
      }),
    ];
  });
  return [header, ...rows];
}

// Spreadsheet programs run cells starting with these characters as formulas.
const csvCell = (v) => {
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",;\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const toCsv = (table) => `﻿${table.map((row) => row.map(csvCell).join(';')).join('\r\n')}\r\n`;

// Settings and the public answer link live in their own row (copied from `from` when duplicating a form).
export function createFormRow(itemId, from = null) {
  run('INSERT INTO forms (item_id, token, accepting, closes_at, require_login, one_per_user, notify) VALUES (?, ?, ?, ?, ?, ?, ?)',
    itemId, newToken(12), from ? from.accepting : 1, from?.closes_at ?? null, from?.require_login ?? 0, from?.one_per_user ?? 0, from?.notify ?? 0);
}
