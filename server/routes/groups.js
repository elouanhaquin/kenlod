import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { one, all, run, tx } from '../db.js';
import { requireAuth } from './auth.js';
import { groupRole, purge, spaceUsage, spaceQuota } from '../access.js';
import { HttpError, newId, newToken, now, validEmail } from '../util.js';
import { config } from '../config.js';
import { mails, sendMailLater } from '../mail.js';

const r = Router();
r.use(requireAuth);

const COLORS = ['#1f4e8c', '#0f766e', '#b45309', '#9d174d', '#4d7c0f', '#6d28d9', '#334155', '#b91c1c'];
const ROLES = ['admin', 'editor', 'viewer'];

function requireMember(uid, groupId, min = 'viewer') {
  const g = one('SELECT * FROM workgroups WHERE id = ?', String(groupId));
  const role = g && groupRole(uid, g.id);
  if (!role) throw new HttpError(404, 'Groupe introuvable');
  const rank = { viewer: 1, editor: 2, admin: 3 };
  if (rank[role] < rank[min]) throw new HttpError(403, 'Réservé aux administrateurs du groupe');
  return { group: g, role };
}

function groupPayload(g, role) {
  const members = all(
    `SELECT u.id, u.name, u.email, gm.role, gm.added_at FROM group_members gm JOIN users u ON u.id = gm.user_id
     WHERE gm.group_id = ? ORDER BY CASE gm.role WHEN 'admin' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END, u.name`,
    g.id,
  );
  const space = `g:${g.id}`;
  return {
    group: { id: g.id, name: g.name, description: g.description, color: g.color, createdAt: g.created_at, role },
    members: members.map((m) => ({ id: m.id, name: m.name, email: m.email, role: m.role, addedAt: m.added_at })),
    storage: { used: spaceUsage(space), quota: spaceQuota(space) },
    invites: role === 'admin'
      ? all('SELECT token, role, expires_at, uses FROM group_invites WHERE group_id = ? AND expires_at > ? ORDER BY created_at DESC', g.id, now())
        .map((i) => ({ token: i.token, role: i.role, expiresAt: i.expires_at, uses: i.uses }))
      : [],
  };
}

function cleanGroupFields(body, current = {}) {
  const name = body.name !== undefined ? String(body.name).trim().slice(0, 80) : current.name;
  if (!name || name.length < 2) throw new HttpError(400, 'Le nom du groupe est trop court');
  const description = body.description !== undefined ? String(body.description).trim().slice(0, 500) : current.description ?? '';
  const color = COLORS.includes(body.color) ? body.color : current.color ?? COLORS[Math.floor(Math.random() * COLORS.length)];
  return { name, description, color };
}

function adminCount(groupId) {
  return one("SELECT COUNT(*) AS n FROM group_members WHERE group_id = ? AND role = 'admin'", groupId).n;
}

r.get('/groups', (req, res) => {
  const rows = all(
    `SELECT g.id, g.name, g.description, g.color, gm.role,
            (SELECT COUNT(*) FROM group_members x WHERE x.group_id = g.id) AS members
     FROM workgroups g JOIN group_members gm ON gm.group_id = g.id AND gm.user_id = ? ORDER BY g.name`,
    req.user.id,
  );
  res.json({ groups: rows.map((g) => ({ ...g })), colors: COLORS });
});

r.post('/groups', (req, res) => {
  const fields = cleanGroupFields(req.body || {});
  const id = newId();
  tx(() => {
    run('INSERT INTO workgroups (id, name, description, color, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      id, fields.name, fields.description, fields.color, req.user.id, now());
    run("INSERT INTO group_members (group_id, user_id, role, added_at) VALUES (?, ?, 'admin', ?)", id, req.user.id, now());
  });
  res.status(201).json(groupPayload(one('SELECT * FROM workgroups WHERE id = ?', id), 'admin'));
});

r.get('/groups/:id', (req, res) => {
  const { group, role } = requireMember(req.user.id, req.params.id);
  res.json(groupPayload(group, role));
});

r.patch('/groups/:id', (req, res) => {
  const { group, role } = requireMember(req.user.id, req.params.id, 'admin');
  const f = cleanGroupFields(req.body || {}, group);
  run('UPDATE workgroups SET name = ?, description = ?, color = ? WHERE id = ?', f.name, f.description, f.color, group.id);
  res.json(groupPayload(one('SELECT * FROM workgroups WHERE id = ?', group.id), role));
});

r.delete('/groups/:id', (req, res) => {
  const { group } = requireMember(req.user.id, req.params.id, 'admin');
  if (String(req.body?.confirm || '') !== group.name) throw new HttpError(400, 'Tapez le nom exact du groupe pour confirmer');
  for (const row of all('SELECT id FROM items WHERE space = ? AND parent_id IS NULL', `g:${group.id}`)) purge(row.id);
  run('DELETE FROM workgroups WHERE id = ?', group.id);
  res.json({ ok: true });
});

r.post('/groups/:id/members', (req, res) => {
  const { group, role } = requireMember(req.user.id, req.params.id, 'admin');
  const email = String(req.body?.email || '').trim().toLowerCase();
  const memberRole = ROLES.includes(req.body?.role) ? req.body.role : 'editor';
  if (!validEmail(email)) throw new HttpError(400, 'Adresse e-mail invalide');
  const u = one('SELECT id FROM users WHERE email = ?', email);
  if (!u) throw new HttpError(404, "Aucun compte avec cette adresse : envoyez plutôt un lien d'invitation");
  if (groupRole(u.id, group.id)) throw new HttpError(409, 'Cette personne fait déjà partie du groupe');
  run('INSERT INTO group_members (group_id, user_id, role, added_at) VALUES (?, ?, ?, ?)', group.id, u.id, memberRole, now());
  sendMailLater(email, ...mails.addedToGroup(req.user.name, group.name, `${config.appUrl}/groupe/${group.id}`));
  res.status(201).json(groupPayload(group, role));
});

r.patch('/groups/:id/members/:userId', (req, res) => {
  const { group, role } = requireMember(req.user.id, req.params.id, 'admin');
  const target = String(req.params.userId);
  const current = groupRole(target, group.id);
  if (!current) throw new HttpError(404, 'Membre introuvable');
  if (!ROLES.includes(req.body?.role)) throw new HttpError(400, 'Rôle invalide');
  if (current === 'admin' && req.body.role !== 'admin' && adminCount(group.id) <= 1) {
    throw new HttpError(400, 'Le groupe doit garder au moins un administrateur');
  }
  run('UPDATE group_members SET role = ? WHERE group_id = ? AND user_id = ?', req.body.role, group.id, target);
  res.json(groupPayload(group, target === req.user.id ? req.body.role : role));
});

r.delete('/groups/:id/members/:userId', (req, res) => {
  const target = String(req.params.userId);
  const self = target === req.user.id;
  const { group, role } = requireMember(req.user.id, req.params.id, self ? 'viewer' : 'admin');
  const current = groupRole(target, group.id);
  if (!current) throw new HttpError(404, 'Membre introuvable');
  if (current === 'admin' && adminCount(group.id) <= 1) {
    throw new HttpError(400, 'Nommez un autre administrateur avant de quitter le groupe');
  }
  run('DELETE FROM group_members WHERE group_id = ? AND user_id = ?', group.id, target);
  res.json(self ? { left: true } : groupPayload(group, role));
});

const inviteLimiter = rateLimit({
  windowMs: 15 * 60e3, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false,
  keyGenerator: (req) => req.user.id,
  message: { error: "Trop d'invitations envoyées, réessayez dans quelques minutes" },
});

r.post('/groups/:id/invites', inviteLimiter, (req, res) => {
  const { group, role } = requireMember(req.user.id, req.params.id, 'admin');
  const inviteRole = req.body?.role === 'viewer' ? 'viewer' : 'editor';
  // Optional: the link is also e-mailed to these addresses (at most 20 at once).
  const emails = [...new Set((Array.isArray(req.body?.emails) ? req.body.emails : [])
    .map((e) => String(e).trim().toLowerCase()).filter(Boolean))];
  if (emails.length > 20) throw new HttpError(400, 'Vingt adresses au maximum à la fois');
  const invalid = emails.find((e) => !validEmail(e));
  if (invalid) throw new HttpError(400, `Adresse e-mail invalide : ${invalid}`);
  const token = newToken(18);
  run('INSERT INTO group_invites (token, group_id, role, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
    token, group.id, inviteRole, req.user.id, now(), now() + 14 * 86400e3);
  for (const email of emails) {
    sendMailLater(email, ...mails.invite(req.user.name, group.name, `${config.appUrl}/rejoindre/${token}`));
  }
  res.status(201).json({ ...groupPayload(group, role), sent: emails.length });
});

r.delete('/groups/:id/invites/:token', (req, res) => {
  const { group, role } = requireMember(req.user.id, req.params.id, 'admin');
  run('DELETE FROM group_invites WHERE group_id = ? AND token = ?', group.id, String(req.params.token));
  res.json(groupPayload(group, role));
});

r.get('/groups/:id/activity', (req, res) => {
  const { group } = requireMember(req.user.id, req.params.id);
  const rows = all(
    `SELECT a.action, a.detail, a.created_at, a.item_id, u.name AS user_name, i.name AS item_name, i.kind, i.trashed_at
     FROM activity a LEFT JOIN users u ON u.id = a.user_id LEFT JOIN items i ON i.id = a.item_id
     WHERE a.space = ? ORDER BY a.created_at DESC LIMIT 80`,
    `g:${group.id}`,
  );
  res.json({
    activity: rows.map((a) => ({
      action: a.action, detail: a.detail, at: a.created_at, userName: a.user_name,
      item: a.item_id ? { id: a.item_id, name: a.item_name, kind: a.kind, trashed: !!a.trashed_at } : null,
    })),
  });
});

// Invitation links work for people who don't have an account yet: they sign up, then accept.
r.get('/invites/:token', (req, res) => {
  const inv = one(
    `SELECT gi.*, g.name, g.color, g.description FROM group_invites gi JOIN workgroups g ON g.id = gi.group_id
     WHERE gi.token = ? AND gi.expires_at > ?`,
    String(req.params.token), now(),
  );
  if (!inv) throw new HttpError(404, "Cette invitation n'est plus valable");
  res.json({
    group: { id: inv.group_id, name: inv.name, color: inv.color, description: inv.description },
    role: inv.role,
    alreadyMember: !!groupRole(req.user.id, inv.group_id),
  });
});

r.post('/invites/:token/accept', (req, res) => {
  const inv = one('SELECT * FROM group_invites WHERE token = ? AND expires_at > ?', String(req.params.token), now());
  if (!inv) throw new HttpError(404, "Cette invitation n'est plus valable");
  if (!groupRole(req.user.id, inv.group_id)) {
    run('INSERT INTO group_members (group_id, user_id, role, added_at) VALUES (?, ?, ?, ?)', inv.group_id, req.user.id, inv.role, now());
    run('UPDATE group_invites SET uses = uses + 1 WHERE token = ?', inv.token);
  }
  res.json({ groupId: inv.group_id });
});

export default r;
