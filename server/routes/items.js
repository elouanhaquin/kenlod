import fs from 'node:fs';
import { Router } from 'express';
import multer from 'multer';
import { one, all, run, tx, placeholders } from '../db.js';
import { config } from '../config.js';
import { requireAuth } from './auth.js';
import {
  atLeast, roleFor, childRole, spaceRole, requireItem, getItem, canDelete, checkQuota,
  ancestorIds, sharesFor, descendantIds, purge, logActivity, touchRecent, ITEM_SELECT, serialize,
  loadSerialized, spaceInfo,
} from '../access.js';
import { EMPTY_SHEET } from '../content.js';
import { EMPTY_FORM, createFormRow } from '../forms.js';
import { storage } from '../storage.js';
import { closeRoom, saveRoom } from '../collab.js';
import { HttpError, newId, now, cleanName, mimeFromName, canInline, contentDisposition } from '../util.js';

const r = Router();
r.use(requireAuth);

const upload = multer({ dest: config.tmpDir, limits: { fileSize: config.maxUpload, files: 1, fields: 5 } });

// 'me' | 'g:<groupId>' coming from the client → stored space id.
function parseSpace(userId, raw) {
  if (!raw || raw === 'me') return `u:${userId}`;
  if (/^g:[\w-]+$/.test(raw)) return raw;
  throw new HttpError(400, 'Espace invalide');
}

// Where a new item goes: inside a folder (editor on it) or at the root of a space (editor on the space).
export function resolveTarget(userId, parentId, rawSpace) {
  if (parentId) {
    const { item } = requireItem(userId, parentId, 'editor');
    if (item.kind !== 'folder') throw new HttpError(400, 'La destination doit être un dossier');
    return { parentId: item.id, space: item.space };
  }
  const space = parseSpace(userId, rawSpace);
  if (!atLeast(spaceRole(userId, space), 'editor')) throw new HttpError(403, "Vous ne pouvez pas ajouter d'éléments ici");
  return { parentId: null, space };
}

function stars(userId) {
  return new Set(all('SELECT item_id FROM stars WHERE user_id = ?', userId).map((r) => r.item_id));
}

function withMeta(rows, userId, roleOf) {
  const starred = stars(userId);
  return rows.map((row) => serialize(row, { role: roleOf(row), starred: starred.has(row.id) }));
}

// Breadcrumbs only go up as far as the user can see.
function breadcrumbs(userId, folder) {
  const ids = ancestorIds(folder.id); // self first
  const rows = all(`SELECT id, name, space FROM items WHERE id IN (${placeholders(ids)})`, ...ids);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const chain = ids.map((id) => byId.get(id)).reverse();
  if (spaceRole(userId, folder.space)) {
    return { root: spaceInfo(folder.space, userId), crumbs: chain.map(({ id, name }) => ({ id, name })) };
  }
  const sharedIds = new Set(sharesFor(userId, ids).map((s) => s.item_id));
  const top = chain.findIndex((c) => sharedIds.has(c.id));
  return { root: { id: 'shared', name: 'Partagés avec moi', kind: 'shared' }, crumbs: chain.slice(Math.max(top, 0)).map(({ id, name }) => ({ id, name })) };
}

// ---- Listing ----------------------------------------------------------------

r.get('/folder', (req, res) => {
  const uid = req.user.id;
  if (req.query.id) {
    const { item, role } = requireItem(uid, req.query.id, 'viewer');
    if (item.kind !== 'folder') throw new HttpError(400, "Ce n'est pas un dossier");
    const rows = all(`${ITEM_SELECT} WHERE i.parent_id = ? AND i.trashed_at IS NULL`, item.id);
    touchRecent(uid, item.id);
    return res.json({
      folder: loadSerialized(item.id, { role }),
      ...breadcrumbs(uid, item),
      role,
      items: withMeta(rows, uid, (row) => childRole(uid, role, row.id)),
    });
  }
  const space = parseSpace(uid, req.query.space);
  const role = spaceRole(uid, space);
  if (!role) throw new HttpError(404, 'Espace introuvable');
  const rows = all(`${ITEM_SELECT} WHERE i.space = ? AND i.parent_id IS NULL AND i.trashed_at IS NULL`, space);
  res.json({
    folder: null,
    root: spaceInfo(space, uid),
    crumbs: [],
    role,
    items: withMeta(rows, uid, (row) => childRole(uid, role, row.id)),
  });
});

r.get('/shared', (req, res) => {
  const uid = req.user.id;
  const rows = all(
    `${ITEM_SELECT} WHERE i.id IN (
       SELECT item_id FROM shares WHERE user_id = ? OR group_id IN (SELECT group_id FROM group_members WHERE user_id = ?)
     ) AND i.trashed_at IS NULL AND i.space <> ?
       AND i.space NOT IN (SELECT 'g:' || group_id FROM group_members WHERE user_id = ?)
     ORDER BY i.updated_at DESC`,
    uid, uid, `u:${uid}`, uid,
  );
  res.json({ items: withMeta(rows, uid, (row) => roleFor(uid, row)) });
});

function accessibleFilter(rows, uid) {
  const out = [];
  for (const row of rows) {
    const role = roleFor(uid, row);
    if (role) out.push([row, role]);
  }
  return out;
}

function listResponse(res, uid, pairs) {
  const starred = stars(uid);
  res.json({ items: pairs.map(([row, role]) => serialize(row, { role, starred: starred.has(row.id) })) });
}

r.get('/recent', (req, res) => {
  const uid = req.user.id;
  const rows = all(
    `${ITEM_SELECT} JOIN recent rc ON rc.item_id = i.id AND rc.user_id = ?
     WHERE i.trashed_at IS NULL AND i.kind <> 'folder' ORDER BY rc.opened_at DESC LIMIT 60`,
    uid,
  );
  listResponse(res, uid, accessibleFilter(rows, uid));
});

r.get('/starred', (req, res) => {
  const uid = req.user.id;
  const rows = all(`${ITEM_SELECT} JOIN stars st ON st.item_id = i.id AND st.user_id = ? WHERE i.trashed_at IS NULL ORDER BY i.name`, uid);
  listResponse(res, uid, accessibleFilter(rows, uid));
});

r.get('/trash', (req, res) => {
  const uid = req.user.id;
  const rows = all(
    `${ITEM_SELECT} WHERE i.trashed_root = 1 AND i.trashed_at IS NOT NULL AND (
       i.space = ? OR i.space IN (SELECT 'g:' || group_id FROM group_members WHERE user_id = ? AND role IN ('admin', 'editor'))
     ) ORDER BY i.trashed_at DESC`,
    `u:${uid}`, uid,
  );
  const pairs = [];
  for (const row of rows) {
    const role = roleFor(uid, row);
    if (canDelete(uid, row, role)) pairs.push([row, role]);
  }
  res.json({ items: pairs.map(([row, role]) => serialize(row, { role })), trashDays: config.trashDays });
});

r.get('/search', (req, res) => {
  const uid = req.user.id;
  const q = String(req.query.q || '').trim().slice(0, 100);
  if (!q) return res.json({ items: [] });
  const like = `%${q.replace(/[\\%_]/g, (c) => '\\' + c)}%`;
  const rows = all(
    `WITH RECURSIVE acc(id) AS (
       SELECT item_id FROM shares WHERE user_id = ? OR group_id IN (SELECT group_id FROM group_members WHERE user_id = ?)
       UNION SELECT i.id FROM items i JOIN acc ON i.parent_id = acc.id
     )
     ${ITEM_SELECT}
     WHERE i.trashed_at IS NULL
       AND (i.name LIKE ? ESCAPE '\\' OR (i.kind = 'doc' AND i.content LIKE ? ESCAPE '\\'))
       AND (i.space = ? OR i.space IN (SELECT 'g:' || group_id FROM group_members WHERE user_id = ?) OR i.id IN acc)
     ORDER BY i.updated_at DESC LIMIT 100`,
    uid, uid, like, like, `u:${uid}`, uid,
  );
  listResponse(res, uid, accessibleFilter(rows, uid));
});

// ---- Single item ------------------------------------------------------------

r.get('/items/:id', (req, res) => {
  const uid = req.user.id;
  const { item, role } = requireItem(uid, req.params.id, 'viewer', { allowTrashed: true });
  const starred = !!one('SELECT 1 FROM stars WHERE user_id = ? AND item_id = ?', uid, item.id);
  const location = item.parent_id ? getItem(item.parent_id) : null;
  res.json({
    item: loadSerialized(item.id, { role, starred, canDelete: canDelete(uid, item, role) }),
    space: spaceRole(uid, item.space) ? spaceInfo(item.space, uid) : null,
    location: location && roleFor(uid, location) ? { id: location.id, name: location.name } : null,
  });
});

r.get('/items/:id/activity', (req, res) => {
  const { item } = requireItem(req.user.id, req.params.id, 'viewer', { allowTrashed: true });
  const rows = all(
    `SELECT a.action, a.detail, a.created_at, u.name AS user_name FROM activity a LEFT JOIN users u ON u.id = a.user_id
     WHERE a.item_id = ? ORDER BY a.created_at DESC LIMIT 40`,
    item.id,
  );
  res.json({ activity: rows.map((a) => ({ action: a.action, detail: a.detail, at: a.created_at, userName: a.user_name })) });
});

// Create a folder, document, spreadsheet or form.
r.post('/items', (req, res) => {
  const uid = req.user.id;
  const kind = req.body?.kind;
  if (!['folder', 'doc', 'sheet', 'form'].includes(kind)) throw new HttpError(400, 'Type invalide');
  const fallback = { folder: 'Nouveau dossier', doc: 'Document sans titre', sheet: 'Tableur sans titre', form: 'Questionnaire sans titre' }[kind];
  const name = cleanName(req.body?.name, fallback);
  const { parentId, space } = resolveTarget(uid, req.body?.parentId, req.body?.space);
  const content = { doc: '', sheet: EMPTY_SHEET, form: EMPTY_FORM }[kind] ?? null;
  const id = newId();
  const t = now();
  run(
    `INSERT INTO items (id, kind, name, parent_id, space, owner_id, size, content, created_at, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, kind, name, parentId, space, uid, content ? Buffer.byteLength(content) : 0, content, t, t, uid,
  );
  if (kind === 'form') createFormRow(id);
  const item = getItem(id);
  logActivity(item, uid, 'create');
  if (kind !== 'folder') touchRecent(uid, id);
  res.status(201).json({ item: loadSerialized(id, { role: roleFor(uid, item) }) });
});

r.post('/upload', upload.single('file'), async (req, res) => {
  const uid = req.user.id;
  if (!req.file) throw new HttpError(400, 'Aucun fichier reçu');
  try {
    const name = cleanName(req.query.name || Buffer.from(req.file.originalname, 'latin1').toString('utf8'), 'fichier');
    const { parentId, space } = resolveTarget(uid, req.query.parentId, req.query.space);
    checkQuota(space, req.file.size);
    const id = newId();
    await storage.put(id, req.file.path, mimeFromName(name));
    try {
      // Permissions or quota may have changed during a long upload.
      resolveTarget(uid, parentId, parentId ? null : space.startsWith('g:') ? space : 'me');
      checkQuota(space, req.file.size);
    } catch (err) {
      await storage.remove(id).catch(() => {});
      throw err;
    }
    const t = now();
    run(
      `INSERT INTO items (id, kind, name, parent_id, space, owner_id, size, mime, storage_key, created_at, updated_at, updated_by)
       VALUES (?, 'file', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, name, parentId, space, uid, req.file.size, mimeFromName(name), id, t, t, uid,
    );
    const item = getItem(id);
    logActivity(item, uid, 'upload');
    res.status(201).json({ item: loadSerialized(id, { role: roleFor(uid, item) }) });
  } finally {
    fs.rm(req.file.path, { force: true }, () => {});
  }
});

export function sendStoredFile(req, res, item) {
  if (item.kind !== 'file') throw new HttpError(400, "Ce n'est pas un fichier");
  const mime = mimeFromName(item.name);
  const inline = req.query.inline === '1' && canInline(mime);
  res.setHeader('Content-Type', mime.startsWith('text/') || mime === 'application/json' ? `${inline ? 'text/plain' : mime}; charset=utf-8` : mime);
  res.setHeader('Content-Disposition', contentDisposition(inline ? 'inline' : 'attachment', item.name));
  res.setHeader('Cache-Control', 'private, no-cache');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  return storage.send(req, res, item.storage_key);
}

r.get('/items/:id/download', (req, res) => {
  const { item } = requireItem(req.user.id, req.params.id, 'viewer');
  touchRecent(req.user.id, item.id);
  sendStoredFile(req, res, item);
});

r.get('/items/:id/content', (req, res) => {
  const { item, role } = requireItem(req.user.id, req.params.id, 'viewer');
  if (!['doc', 'sheet'].includes(item.kind)) throw new HttpError(400, "Cet élément n'est pas éditable");
  touchRecent(req.user.id, item.id);
  res.json({ item: loadSerialized(item.id, { role }), content: item.content ?? '', version: item.version });
});

// ---- Images inside documents ----
// Saved and edited content goes through the realtime channel (server/collab.js).

const imageUpload = multer({ dest: config.tmpDir, limits: { fileSize: 15 * 1024 * 1024, files: 1, fields: 2 } });

// Trust the bytes, not the browser-supplied type.
async function sniffImage(file) {
  const fh = await fs.promises.open(file, 'r');
  const { buffer } = await fh.read(Buffer.alloc(12), 0, 12, 0);
  await fh.close();
  if (buffer[0] === 0x89 && buffer.toString('ascii', 1, 4) === 'PNG') return 'image/png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.toString('ascii', 0, 4) === 'GIF8') return 'image/gif';
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

r.post('/items/:id/images', imageUpload.single('file'), async (req, res) => {
  const uid = req.user.id;
  if (!req.file) throw new HttpError(400, 'Aucune image reçue');
  try {
    const { item } = requireItem(uid, req.params.id, 'editor');
    if (item.kind !== 'doc') throw new HttpError(400, 'Les images ne peuvent être ajoutées qu’aux documents');
    const mime = await sniffImage(req.file.path);
    if (!mime) throw new HttpError(415, 'Format non pris en charge (PNG, JPEG, GIF ou WebP)');
    checkQuota(item.space, req.file.size);
    const id = newId();
    await storage.put(`img-${id}`, req.file.path, mime);
    run('INSERT INTO doc_images (id, item_id, storage_key, mime, size, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      id, item.id, `img-${id}`, mime, req.file.size, uid, now());
    res.status(201).json({ src: `/api/items/${item.id}/images/${id}` });
  } finally {
    fs.rm(req.file.path, { force: true }, () => {});
  }
});

export function sendDocImage(req, res, docId, imageId) {
  const img = one('SELECT * FROM doc_images WHERE id = ? AND item_id = ?', String(imageId), docId);
  if (!img) throw new HttpError(404, 'Image introuvable');
  res.setHeader('Content-Type', img.mime);
  res.setHeader('Content-Disposition', 'inline');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, max-age=86400, immutable');
  return storage.send(req, res, img.storage_key);
}

r.get('/items/:id/images/:imageId', (req, res) => {
  const { item } = requireItem(req.user.id, req.params.id, 'viewer');
  return sendDocImage(req, res, item.id, req.params.imageId);
});

// Rename and/or move.
r.patch('/items/:id', (req, res) => {
  const uid = req.user.id;
  const { item, role } = requireItem(uid, req.params.id, 'editor');
  const body = req.body || {};
  if (body.name !== undefined) {
    const name = cleanName(body.name, item.name);
    if (name !== item.name) {
      run('UPDATE items SET name = ?, updated_at = ?, updated_by = ? WHERE id = ?', name, now(), uid, item.id);
      logActivity(item, uid, 'rename', `${item.name} → ${name}`);
    }
  }
  if (body.parentId !== undefined && body.parentId !== item.parent_id) {
    let targetName;
    if (body.parentId === null) {
      if (!atLeast(spaceRole(uid, item.space), 'editor')) throw new HttpError(403, "Vous ne pouvez pas déplacer d'éléments à la racine de cet espace");
      targetName = spaceInfo(item.space, uid)?.name;
    } else {
      const { item: target } = requireItem(uid, body.parentId, 'editor');
      if (target.kind !== 'folder') throw new HttpError(400, 'La destination doit être un dossier');
      if (target.space !== item.space) throw new HttpError(400, "Le déplacement entre espaces n'est pas encore possible : utilisez « Copier »");
      if (ancestorIds(target.id).includes(item.id)) throw new HttpError(400, 'Impossible de déplacer un dossier dans lui-même');
      targetName = target.name;
    }
    run('UPDATE items SET parent_id = ?, updated_at = ? WHERE id = ?', body.parentId, now(), item.id);
    logActivity(item, uid, 'move', targetName);
  }
  res.json({ item: loadSerialized(item.id, { role }) });
});

r.post('/items/:id/copy', async (req, res) => {
  const uid = req.user.id;
  const { item } = requireItem(uid, req.params.id, 'viewer');
  if (item.kind === 'folder') throw new HttpError(400, 'La copie de dossiers arrive bientôt');
  let target;
  try {
    target = resolveTarget(uid, item.parent_id, item.parent_id ? null : item.space.startsWith('g:') ? item.space : 'me');
  } catch {
    target = { parentId: null, space: `u:${uid}` };
  }
  checkQuota(target.space, item.size);
  const id = newId();
  const t = now();
  let content = item.content;
  const images = [];
  if (item.kind === 'file') await storage.copy(item.storage_key, id);
  else if (item.kind === 'form') {
    content = item.content; // the copy starts without responses
  } else {
    saveRoom(item.id); // include edits not yet persisted
    content = getItem(item.id).content;
    // The copy gets its own images, so it stays readable whoever can access it.
    for (const img of all('SELECT * FROM doc_images WHERE item_id = ?', item.id)) {
      const imgId = newId();
      await storage.copy(img.storage_key, `img-${imgId}`);
      images.push({ ...img, id: imgId, storage_key: `img-${imgId}` });
      content = content.replaceAll(`/api/items/${item.id}/images/${img.id}`, `/api/items/${id}/images/${imgId}`);
    }
  }
  run(
    `INSERT INTO items (id, kind, name, parent_id, space, owner_id, size, mime, storage_key, content, created_at, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, item.kind, cleanName(`Copie de ${item.name}`), target.parentId, target.space, uid,
    item.kind === 'form' ? Buffer.byteLength(content || '') : item.size, item.mime,
    item.kind === 'file' ? id : null, content, t, t, uid,
  );
  if (item.kind === 'form') createFormRow(id, one('SELECT * FROM forms WHERE item_id = ?', item.id));
  for (const img of images) {
    run('INSERT INTO doc_images (id, item_id, storage_key, mime, size, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      img.id, id, img.storage_key, img.mime, img.size, uid, t);
  }
  const copy = getItem(id);
  logActivity(copy, uid, 'copy', item.name);
  res.status(201).json({ item: loadSerialized(id, { role: roleFor(uid, copy) }) });
});

r.put('/items/:id/star', (req, res) => {
  const { item } = requireItem(req.user.id, req.params.id, 'viewer');
  run('INSERT OR IGNORE INTO stars (user_id, item_id) VALUES (?, ?)', req.user.id, item.id);
  res.json({ starred: true });
});

r.delete('/items/:id/star', (req, res) => {
  run('DELETE FROM stars WHERE user_id = ? AND item_id = ?', req.user.id, String(req.params.id));
  res.json({ starred: false });
});

// ---- Trash ------------------------------------------------------------------

r.post('/items/:id/trash', (req, res) => {
  const uid = req.user.id;
  const { item, role } = requireItem(uid, req.params.id, 'editor');
  if (!canDelete(uid, item, role)) throw new HttpError(403, 'Seul le propriétaire peut supprimer cet élément');
  const t = now();
  const ids = descendantIds(item.id);
  tx(() => {
    run(`UPDATE items SET trashed_at = ? WHERE id IN (${placeholders(ids)}) AND trashed_at IS NULL`, t, ...ids);
    run('UPDATE items SET trashed_root = 1 WHERE id = ?', item.id);
  });
  for (const id of ids) closeRoom(id);
  logActivity(item, uid, 'trash');
  res.json({ ok: true });
});

r.post('/items/:id/restore', (req, res) => {
  const uid = req.user.id;
  const { item, role } = requireItem(uid, req.params.id, 'editor', { allowTrashed: true });
  if (!item.trashed_root) throw new HttpError(400, "Cet élément n'est pas dans la corbeille");
  if (!canDelete(uid, item, role)) throw new HttpError(403, 'Droits insuffisants');
  const ids = descendantIds(item.id);
  const parent = item.parent_id ? getItem(item.parent_id) : null;
  tx(() => {
    run(`UPDATE items SET trashed_at = NULL WHERE id IN (${placeholders(ids)}) AND trashed_at = ?`, ...ids, item.trashed_at);
    run('UPDATE items SET trashed_root = 0 WHERE id = ?', item.id);
    // If the original folder is gone or still in the trash, restore to the space root.
    if (parent && parent.trashed_at) run('UPDATE items SET parent_id = NULL WHERE id = ?', item.id);
  });
  logActivity(item, uid, 'restore');
  res.json({ item: loadSerialized(item.id, { role }) });
});

r.delete('/items/:id', (req, res) => {
  const uid = req.user.id;
  const { item, role } = requireItem(uid, req.params.id, 'editor', { allowTrashed: true });
  if (!item.trashed_at) throw new HttpError(400, "Mettez d'abord l'élément à la corbeille");
  if (!canDelete(uid, item, role)) throw new HttpError(403, 'Droits insuffisants');
  purge(item.id);
  res.json({ ok: true });
});

r.post('/trash/empty', (req, res) => {
  const uid = req.user.id;
  const rows = all('SELECT id FROM items WHERE space = ? AND trashed_root = 1 AND trashed_at IS NOT NULL', `u:${uid}`);
  for (const row of rows) purge(row.id);
  res.json({ ok: true, deleted: rows.length });
});

export function purgeOldTrash() {
  const limit = now() - config.trashDays * 86400e3;
  for (const row of all('SELECT id FROM items WHERE trashed_root = 1 AND trashed_at < ?', limit)) purge(row.id);
}

export default r;
