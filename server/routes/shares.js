import { Router } from 'express';
import { one, all, run, placeholders } from '../db.js';
import { requireAuth } from './auth.js';
import { requireItem, ancestorIds, spaceInfo, logActivity, groupRole } from '../access.js';
import { HttpError, newId, newToken, now, hashPassword, validEmail } from '../util.js';

const r = Router();
r.use(requireAuth);

const ROLES = ['viewer', 'editor'];

function shareList(item) {
  const ids = ancestorIds(item.id);
  const rows = all(
    `SELECT s.id, s.item_id, s.role, s.user_id, s.group_id, u.name AS user_name, u.email, g.name AS group_name, g.color,
            it.name AS item_name
     FROM shares s
     LEFT JOIN users u ON u.id = s.user_id
     LEFT JOIN workgroups g ON g.id = s.group_id
     JOIN items it ON it.id = s.item_id
     WHERE s.item_id IN (${placeholders(ids)}) ORDER BY s.created_at`,
    ...ids,
  );
  return rows.map((s) => ({
    id: s.id,
    type: s.user_id ? 'user' : 'group',
    userId: s.user_id,
    groupId: s.group_id,
    name: s.user_id ? s.user_name : s.group_name,
    email: s.email,
    color: s.color,
    role: s.role,
    inheritedFrom: s.item_id === item.id ? null : { id: s.item_id, name: s.item_name },
  }));
}

function linkList(item) {
  return all('SELECT id, token, password_hash, expires_at, created_at, views FROM links WHERE item_id = ? ORDER BY created_at', item.id)
    .map((l) => ({
      id: l.id, token: l.token, hasPassword: !!l.password_hash, expiresAt: l.expires_at, createdAt: l.created_at,
      views: l.views, expired: !!l.expires_at && l.expires_at < now(),
    }));
}

function ownerInfo(item, uid) {
  const space = spaceInfo(item.space, uid);
  if (item.space.startsWith('g:')) {
    const members = one('SELECT COUNT(*) AS n FROM group_members WHERE group_id = ?', item.space.slice(2)).n;
    return { type: 'group', name: space?.name, color: space?.color, members };
  }
  const u = one('SELECT name, email FROM users WHERE id = ?', item.space.slice(2));
  return { type: 'user', name: u?.name, email: u?.email };
}

r.get('/items/:id/shares', (req, res) => {
  const { item, role } = requireItem(req.user.id, req.params.id, 'viewer');
  res.json({ owner: ownerInfo(item, req.user.id), shares: shareList(item), links: linkList(item), role });
});

r.post('/items/:id/shares', (req, res) => {
  const uid = req.user.id;
  const { item } = requireItem(uid, req.params.id, 'editor');
  const role = req.body?.role;
  if (!ROLES.includes(role)) throw new HttpError(400, 'Rôle invalide');
  let userId = null;
  let groupId = null;
  let label;
  if (req.body?.groupId) {
    const g = one('SELECT id, name FROM workgroups WHERE id = ?', String(req.body.groupId));
    // Only groups you belong to can be targeted, so group ids can't be probed.
    if (!g || !groupRole(uid, g.id)) throw new HttpError(404, 'Groupe introuvable');
    if (item.space === `g:${g.id}`) throw new HttpError(400, 'Ce groupe a déjà accès à son propre espace');
    groupId = g.id;
    label = g.name;
  } else {
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!validEmail(email)) throw new HttpError(400, 'Adresse e-mail invalide');
    const u = one('SELECT id, name FROM users WHERE email = ?', email);
    if (!u) throw new HttpError(404, "Aucun compte Kenlod avec cette adresse. Invitez la personne à s'inscrire d'abord.");
    if (item.space === `u:${u.id}`) throw new HttpError(400, 'Cette personne est déjà propriétaire');
    userId = u.id;
    label = u.name;
  }
  const existing = one(
    'SELECT id FROM shares WHERE item_id = ? AND (user_id = ? OR group_id = ?)', item.id, userId, groupId,
  );
  if (existing) run('UPDATE shares SET role = ? WHERE id = ?', role, existing.id);
  else {
    run('INSERT INTO shares (id, item_id, user_id, group_id, role, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      newId(), item.id, userId, groupId, role, uid, now());
  }
  logActivity(item, uid, 'share', `${label} (${role === 'editor' ? 'éditeur' : 'lecteur'})`);
  res.status(201).json({ shares: shareList(item) });
});

function shareWithItem(uid, shareId) {
  const s = one('SELECT * FROM shares WHERE id = ?', String(shareId));
  if (!s) throw new HttpError(404, 'Partage introuvable');
  const { item } = requireItem(uid, s.item_id, 'editor');
  return { share: s, item };
}

r.patch('/shares/:id', (req, res) => {
  const { share, item } = shareWithItem(req.user.id, req.params.id);
  if (!ROLES.includes(req.body?.role)) throw new HttpError(400, 'Rôle invalide');
  run('UPDATE shares SET role = ? WHERE id = ?', req.body.role, share.id);
  res.json({ shares: shareList(item) });
});

r.delete('/shares/:id', (req, res) => {
  const { share, item } = shareWithItem(req.user.id, req.params.id);
  run('DELETE FROM shares WHERE id = ?', share.id);
  logActivity(item, req.user.id, 'unshare');
  res.json({ shares: shareList(item) });
});

r.post('/items/:id/links', async (req, res) => {
  const uid = req.user.id;
  const { item } = requireItem(uid, req.params.id, 'editor');
  // Forms are answered through their own link (/f/<token>), never exposed as a read-only page.
  if (item.kind === 'form') throw new HttpError(400, 'Utilisez le lien de réponse du questionnaire');
  const password = req.body?.password ? String(req.body.password) : null;
  if (password && password.length < 4) throw new HttpError(400, 'Mot de passe trop court (4 caractères minimum)');
  const days = Number(req.body?.expiresInDays) || 0;
  if (days < 0 || days > 3650) throw new HttpError(400, 'Durée invalide');
  run(
    'INSERT INTO links (id, token, item_id, password_hash, expires_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    newId(), newToken(18), item.id, password ? await hashPassword(password) : null, days ? now() + days * 86400e3 : null, uid, now(),
  );
  logActivity(item, uid, 'link');
  res.status(201).json({ links: linkList(item) });
});

r.delete('/links/:id', (req, res) => {
  const l = one('SELECT * FROM links WHERE id = ?', String(req.params.id));
  if (!l) throw new HttpError(404, 'Lien introuvable');
  const { item } = requireItem(req.user.id, l.item_id, 'editor');
  run('DELETE FROM links WHERE id = ?', l.id);
  res.json({ links: linkList(item) });
});

// Suggestions for the share box: people you already work with, plus an exact e-mail match.
r.get('/users/suggest', (req, res) => {
  const uid = req.user.id;
  const q = String(req.query.q || '').trim().toLowerCase().slice(0, 80);
  if (q.length < 2) return res.json({ users: [] });
  const like = `%${q.replace(/[\\%_]/g, (c) => '\\' + c)}%`;
  const users = all(
    `SELECT DISTINCT u.id, u.name, u.email FROM users u
     JOIN group_members gm ON gm.user_id = u.id
     WHERE gm.group_id IN (SELECT group_id FROM group_members WHERE user_id = ?) AND u.id <> ?
       AND (lower(u.name) LIKE ? ESCAPE '\\' OR lower(u.email) LIKE ? ESCAPE '\\')
     LIMIT 8`,
    uid, uid, like, like,
  );
  if (validEmail(q) && !users.some((u) => u.email.toLowerCase() === q)) {
    const exact = one('SELECT id, name, email FROM users WHERE email = ? AND id <> ?', q, uid);
    if (exact) users.unshift(exact);
  }
  res.json({ users });
});

export default r;
