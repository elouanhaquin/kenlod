import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { one, all, run, tx } from '../db.js';
import { config } from '../config.js';
import { requireAuth, isBlocked } from './auth.js';
import { resolveTarget } from './items.js';
import { requireItem, getItem, roleFor, loadSerialized, logActivity, touchRecent, checkQuota } from '../access.js';
import { validateForm, parseForm, validateAnswers, responsesTable, toCsv } from '../forms.js';
import { mails, sendMailLater } from '../mail.js';
import { HttpError, newId, now, cleanName, contentDisposition } from '../util.js';

const MAX_RESPONSES = 10000;

function formRow(itemId) {
  const f = one('SELECT * FROM forms WHERE item_id = ?', itemId);
  if (!f) throw new HttpError(404, 'Questionnaire introuvable');
  return f;
}

const settingsOf = (f) => ({
  accepting: !!f.accepting, closesAt: f.closes_at, requireLogin: !!f.require_login, onePerUser: !!f.one_per_user, notify: !!f.notify,
});
const isOpen = (f) => !!f.accepting && (!f.closes_at || f.closes_at > now());

function requireForm(userId, id, min) {
  const found = requireItem(userId, id, min);
  if (found.item.kind !== 'form') throw new HttpError(400, "Ce n'est pas un questionnaire");
  return { ...found, form: formRow(found.item.id) };
}

function listResponses(itemId) {
  return all(
    `SELECT r.id, r.answers, r.created_at, r.user_id, u.name AS user_name, u.email AS user_email
     FROM form_responses r LEFT JOIN users u ON u.id = r.user_id WHERE r.item_id = ? ORDER BY r.created_at, r.rowid`,
    itemId,
  );
}

// ---- Editors (signed in) ----
export const formRoutes = Router();
formRoutes.use(requireAuth);

formRoutes.get('/items/:id/form', (req, res) => {
  const { item, role, form } = requireForm(req.user.id, req.params.id, 'viewer');
  touchRecent(req.user.id, item.id);
  res.json({
    item: loadSerialized(item.id, { role }),
    definition: parseForm(item.content),
    settings: settingsOf(form),
    token: form.token,
    version: item.version,
    responseCount: one('SELECT COUNT(*) AS n FROM form_responses WHERE item_id = ?', item.id).n,
  });
});

formRoutes.put('/items/:id/form', (req, res) => {
  const { item, form } = requireForm(req.user.id, req.params.id, 'editor');
  const { definition, settings, version } = req.body || {};
  let newVersion = item.version;
  if (definition !== undefined) {
    if (Number(version) !== item.version) {
      throw Object.assign(new HttpError(409, 'Le questionnaire vient d’être modifié par quelqu’un d’autre'), { reason: 'conflict' });
    }
    const content = validateForm(definition);
    const delta = Buffer.byteLength(content) - Buffer.byteLength(item.content || '');
    if (delta > 0) checkQuota(item.space, delta);
    newVersion = item.version + 1;
    run('UPDATE items SET content = ?, size = size + ?, version = ?, updated_at = ?, updated_by = ? WHERE id = ?',
      content, delta, newVersion, now(), req.user.id, item.id);
    const recent = one("SELECT 1 FROM activity WHERE item_id = ? AND user_id = ? AND action = 'edit' AND created_at > ?", item.id, req.user.id, now() - 15 * 60e3);
    if (!recent) logActivity(item, req.user.id, 'edit');
  }
  if (settings && typeof settings === 'object') {
    const s = { ...settingsOf(form), ...settings };
    const closesAt = s.closesAt == null || s.closesAt === '' ? null : Number(s.closesAt);
    if (closesAt !== null && !Number.isFinite(closesAt)) throw new HttpError(400, 'Date de clôture invalide');
    run('UPDATE forms SET accepting = ?, closes_at = ?, require_login = ?, one_per_user = ?, notify = ? WHERE item_id = ?',
      s.accepting ? 1 : 0, closesAt, s.requireLogin || s.onePerUser ? 1 : 0, s.onePerUser ? 1 : 0, s.notify ? 1 : 0, item.id);
  }
  res.json({ version: newVersion, settings: settingsOf(formRow(item.id)) });
});

// Responses can hold personal data: only editors see them.
formRoutes.get('/items/:id/responses', (req, res) => {
  const { item, form } = requireForm(req.user.id, req.params.id, 'editor');
  res.json({
    definition: parseForm(item.content),
    settings: settingsOf(form),
    responses: listResponses(item.id).map((r) => ({
      id: r.id, at: r.created_at, answers: JSON.parse(r.answers),
      user: r.user_id ? { name: r.user_name, email: r.user_email } : null,
    })),
  });
});

formRoutes.delete('/items/:id/responses/:responseId', (req, res) => {
  const { item } = requireForm(req.user.id, req.params.id, 'editor');
  const r = one('SELECT size FROM form_responses WHERE id = ? AND item_id = ?', String(req.params.responseId), item.id);
  if (!r) throw new HttpError(404, 'Réponse introuvable');
  tx(() => {
    run('DELETE FROM form_responses WHERE id = ?', String(req.params.responseId));
    run('UPDATE items SET size = MAX(size - ?, 0) WHERE id = ?', r.size, item.id);
  });
  res.json({ ok: true });
});

formRoutes.delete('/items/:id/responses', (req, res) => {
  const { item } = requireForm(req.user.id, req.params.id, 'editor');
  tx(() => {
    run('DELETE FROM form_responses WHERE item_id = ?', item.id);
    run('UPDATE items SET size = ? WHERE id = ?', Buffer.byteLength(item.content || ''), item.id);
  });
  logActivity(item, req.user.id, 'responses-cleared');
  res.json({ ok: true });
});

formRoutes.get('/items/:id/responses.csv', (req, res) => {
  const { item, form } = requireForm(req.user.id, req.params.id, 'editor');
  const table = responsesTable(parseForm(item.content), listResponses(item.id), { withUser: !!form.require_login });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', contentDisposition('attachment', `${item.name} - réponses.csv`));
  res.send(toCsv(table));
});

const colName = (n) => (n < 26 ? String.fromCharCode(65 + n) : String.fromCharCode(64 + Math.floor(n / 26)) + String.fromCharCode(65 + (n % 26)));

// Copies the current responses into a new Kenlod spreadsheet next to the form.
formRoutes.post('/items/:id/responses/sheet', (req, res) => {
  const uid = req.user.id;
  const { item, form } = requireForm(uid, req.params.id, 'editor');
  const table = responsesTable(parseForm(item.content), listResponses(item.id), { withUser: !!form.require_login });
  const cols = Math.min(table[0].length, 100);
  const cells = {};
  const widths = {};
  table.slice(0, 5000).forEach((row, r) => row.slice(0, cols).forEach((v, c) => {
    if (v === '') return;
    // A leading apostrophe keeps answers like "=1+1" as plain text.
    const value = r > 0 && /^[=+\-@]/.test(v) ? `'${v}` : v;
    cells[`${colName(c)}${r + 1}`] = r === 0 ? { v: value, b: 1, bg: '#e6effc' } : { v: value };
  }));
  for (let c = 0; c < cols; c++) widths[colName(c)] = c === 0 ? 150 : 200;
  const content = JSON.stringify({ rows: Math.max(table.length + 20, 100), cols: Math.max(cols, 26), cells, widths });

  let target;
  try {
    target = resolveTarget(uid, item.parent_id, item.parent_id ? null : item.space.startsWith('g:') ? item.space : 'me');
  } catch {
    target = { parentId: null, space: `u:${uid}` };
  }
  checkQuota(target.space, Buffer.byteLength(content));
  const id = newId();
  const t = now();
  run(
    `INSERT INTO items (id, kind, name, parent_id, space, owner_id, size, content, created_at, updated_at, updated_by)
     VALUES (?, 'sheet', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, cleanName(`${item.name} (réponses)`), target.parentId, target.space, uid, Buffer.byteLength(content), content, t, t, uid,
  );
  const sheet = getItem(id);
  logActivity(sheet, uid, 'create');
  res.status(201).json({ item: loadSerialized(id, { role: roleFor(uid, sheet) }) });
});

// ---- Respondents (no account needed unless the form asks for one) ----
export const publicFormRoutes = Router();

const submitLimiter = rateLimit({
  windowMs: 10 * 60e3, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false,
  message: { error: 'Trop de réponses envoyées, réessayez dans quelques minutes' },
});

function openForm(token) {
  const f = one('SELECT * FROM forms WHERE token = ?', String(token));
  const item = f && getItem(f.item_id);
  if (!item || item.trashed_at) throw new HttpError(404, "Ce questionnaire n'existe pas ou a été supprimé");
  return { f, item };
}

const viewer = (req) => (req.user && !isBlocked(req.user) ? req.user : null);

publicFormRoutes.get('/:token', (req, res) => {
  const { f, item } = openForm(req.params.token);
  const def = parseForm(item.content);
  const user = viewer(req);
  res.json({
    title: def.title || item.name,
    description: def.description,
    questions: def.questions,
    open: isOpen(f),
    requireLogin: !!f.require_login,
    user: user ? { name: user.name, email: user.email } : null,
    alreadyAnswered: !!(f.one_per_user && user && one('SELECT 1 FROM form_responses WHERE item_id = ? AND user_id = ?', item.id, user.id)),
  });
});

const lastNotified = new Map(); // item id → time of the last "new response" mail

publicFormRoutes.post('/:token', submitLimiter, (req, res) => {
  const { f, item } = openForm(req.params.token);
  const def = parseForm(item.content);
  if (!isOpen(f)) throw new HttpError(403, 'Ce questionnaire ne reçoit plus de réponses');
  const user = viewer(req);
  if (f.require_login && !user) throw new HttpError(401, 'Connectez-vous pour répondre à ce questionnaire');
  // Bots fill every field, including this one, which people never see.
  if (req.body?.website) return res.status(201).json({ ok: true, confirmation: def.confirmation });
  const answers = JSON.stringify(validateAnswers(def, req.body?.answers));
  const size = Buffer.byteLength(answers);
  try {
    checkQuota(item.space, size);
  } catch {
    throw new HttpError(403, 'Ce questionnaire ne peut plus recevoir de réponses pour le moment');
  }
  tx(() => {
    if (one('SELECT COUNT(*) AS n FROM form_responses WHERE item_id = ?', item.id).n >= MAX_RESPONSES) {
      throw new HttpError(403, 'Ce questionnaire a atteint le nombre maximal de réponses');
    }
    if (f.one_per_user && one('SELECT 1 FROM form_responses WHERE item_id = ? AND user_id = ?', item.id, user.id)) {
      throw new HttpError(409, 'Vous avez déjà répondu à ce questionnaire');
    }
    // The respondent is only recorded when the form requires an account (they are told so).
    run('INSERT INTO form_responses (id, item_id, user_id, answers, size, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      newId(), item.id, f.require_login ? user.id : null, answers, size, now());
    run('UPDATE items SET size = size + ? WHERE id = ?', size, item.id);
  });
  if (f.notify && item.owner_id && (lastNotified.get(item.id) || 0) < now() - 15 * 60e3) {
    lastNotified.set(item.id, now());
    const owner = one('SELECT email, name FROM users WHERE id = ?', item.owner_id);
    const count = one('SELECT COUNT(*) AS n FROM form_responses WHERE item_id = ?', item.id).n;
    if (owner) sendMailLater(owner.email, ...mails.formResponse(item.name, count, `${config.appUrl}/questionnaire/${item.id}/reponses`));
  }
  res.status(201).json({ ok: true, confirmation: def.confirmation });
});
