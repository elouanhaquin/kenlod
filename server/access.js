import { one, all, run, placeholders } from './db.js';
import { storage } from './storage.js';
import { closeRoom } from './collab.js';
import { config } from './config.js';
import { HttpError, now } from './util.js';

// Effective roles, weakest to strongest. 'manager' is a group admin inside the group's space.
export const RANK = { viewer: 1, editor: 2, manager: 3, owner: 4 };
export const atLeast = (role, min) => !!role && RANK[role] >= RANK[min];
const max = (a, b) => (!a ? b : !b ? a : RANK[a] >= RANK[b] ? a : b);

export function groupRole(userId, groupId) {
  return one('SELECT role FROM group_members WHERE group_id = ? AND user_id = ?', groupId, userId)?.role ?? null;
}

export function spaceRole(userId, space) {
  if (space === `u:${userId}`) return 'owner';
  if (space.startsWith('g:')) {
    const r = groupRole(userId, space.slice(2));
    return r === 'admin' ? 'manager' : r;
  }
  return null;
}

export function ancestorIds(itemId) {
  return all(
    `WITH RECURSIVE anc(id, parent_id, depth) AS (
       SELECT id, parent_id, 0 FROM items WHERE id = ?
       UNION ALL SELECT i.id, i.parent_id, anc.depth + 1 FROM items i JOIN anc ON i.id = anc.parent_id
     ) SELECT id FROM anc ORDER BY depth`,
    itemId,
  ).map((r) => r.id);
}

// Shares (direct or through one of the user's groups) on any of the given item ids.
export function sharesFor(userId, ids) {
  if (!ids.length) return [];
  return all(
    `SELECT item_id, role FROM shares WHERE item_id IN (${placeholders(ids)})
       AND (user_id = ? OR group_id IN (SELECT group_id FROM group_members WHERE user_id = ?))`,
    ...ids, userId, userId,
  );
}

export function roleFor(userId, item) {
  const base = spaceRole(userId, item.space);
  if (base === 'owner') return base;
  let best = base;
  for (const s of sharesFor(userId, ancestorIds(item.id))) best = max(best, s.role);
  return best;
}

// Role on a child when the parent's role is already known: only direct shares on the child can add to it.
export function childRole(userId, parentRole, childId) {
  let best = parentRole;
  if (best === 'owner') return best;
  for (const s of sharesFor(userId, [childId])) best = max(best, s.role);
  return best;
}

export function canDelete(userId, item, role) {
  if (atLeast(role, 'manager')) return true;
  return role === 'editor' && (item.space.startsWith('g:') || item.owner_id === userId);
}

export function getItem(id) {
  return one('SELECT * FROM items WHERE id = ?', String(id));
}

// Loads an item and checks the user has at least `min` on it. Hidden items look like missing ones.
export function requireItem(userId, id, min = 'viewer', { allowTrashed = false } = {}) {
  const item = getItem(id);
  if (!item || (item.trashed_at && !allowTrashed)) throw new HttpError(404, 'Élément introuvable');
  const role = roleFor(userId, item);
  if (!role) throw new HttpError(404, 'Élément introuvable');
  if (!atLeast(role, min)) throw new HttpError(403, "Vous n'avez pas les droits nécessaires");
  return { item, role };
}

export function spaceUsage(space) {
  return one(
    `SELECT (SELECT COALESCE(SUM(size), 0) FROM items WHERE space = ?)
          + (SELECT COALESCE(SUM(d.size), 0) FROM doc_images d JOIN items i ON i.id = d.item_id WHERE i.space = ?) AS used`,
    space, space,
  ).used;
}

export function spaceQuota(space) {
  if (space.startsWith('g:')) return config.groupQuota;
  const u = one('SELECT quota_bytes FROM users WHERE id = ?', space.slice(2));
  return u?.quota_bytes ?? config.userQuota;
}

export function checkQuota(space, extra) {
  if (spaceUsage(space) + extra > spaceQuota(space)) {
    throw new HttpError(413, "L'espace de stockage est plein");
  }
}


export function descendantIds(itemId) {
  return all(
    `WITH RECURSIVE d(id) AS (SELECT id FROM items WHERE id = ? UNION ALL SELECT i.id FROM items i JOIN d ON i.parent_id = d.id)
     SELECT id FROM d`,
    itemId,
  ).map((r) => r.id);
}

// Permanently removes an item, its descendants and their stored files (including document images).
export function purge(itemId) {
  const ids = descendantIds(itemId);
  const keys = [
    ...all(`SELECT storage_key FROM items WHERE id IN (${placeholders(ids)}) AND storage_key IS NOT NULL`, ...ids),
    ...all(`SELECT storage_key FROM doc_images WHERE item_id IN (${placeholders(ids)})`, ...ids),
  ].map((r) => r.storage_key);
  for (const id of ids) closeRoom(id);
  run('DELETE FROM items WHERE id = ?', itemId);
  for (const key of keys) storage.remove(key).catch((err) => console.error('could not delete stored file', key, err.message));
}

export function logActivity(item, userId, action, detail = null) {
  run(
    'INSERT INTO activity (item_id, space, user_id, action, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    item.id, item.space, userId, action, detail, now(),
  );
}

export function touchRecent(userId, itemId) {
  run(
    `INSERT INTO recent (user_id, item_id, opened_at) VALUES (?, ?, ?)
     ON CONFLICT (user_id, item_id) DO UPDATE SET opened_at = excluded.opened_at`,
    userId, itemId, now(),
  );
}

export const ITEM_SELECT = `
  SELECT i.id, i.kind, i.name, i.parent_id, i.space, i.size, i.mime, i.version, i.created_at, i.updated_at,
         i.trashed_at, i.owner_id, u.name AS owner_name, ub.name AS updated_by_name,
         (EXISTS (SELECT 1 FROM shares s WHERE s.item_id = i.id) OR EXISTS (SELECT 1 FROM links l WHERE l.item_id = i.id)) AS shared
  FROM items i LEFT JOIN users u ON u.id = i.owner_id LEFT JOIN users ub ON ub.id = i.updated_by`;

export function serialize(row, extra = {}) {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    parentId: row.parent_id,
    space: row.space,
    size: row.size,
    mime: row.mime,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    trashedAt: row.trashed_at,
    ownerId: row.owner_id,
    ownerName: row.owner_name,
    updatedByName: row.updated_by_name,
    shared: !!row.shared,
    ...extra,
  };
}

export function loadSerialized(id, extra) {
  const row = one(`${ITEM_SELECT} WHERE i.id = ?`, id);
  return row ? serialize(row, extra) : null;
}

export function spaceInfo(space, userId) {
  if (space === `u:${userId}`) return { id: 'me', name: 'Mon espace', kind: 'user' };
  if (space.startsWith('g:')) {
    const g = one('SELECT id, name, color FROM workgroups WHERE id = ?', space.slice(2));
    return g ? { id: space, name: g.name, color: g.color, kind: 'group', groupId: g.id } : null;
  }
  const u = one('SELECT name FROM users WHERE id = ?', space.slice(2));
  return { id: space, name: u ? `Espace de ${u.name}` : 'Espace personnel', kind: 'user' };
}
