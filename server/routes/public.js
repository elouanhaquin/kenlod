import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { one, all, run } from '../db.js';
import { config } from '../config.js';
import { ancestorIds, getItem, ITEM_SELECT, serialize } from '../access.js';
import { sendStoredFile, sendDocImage } from './items.js';
import { HttpError, now, hmac, safeEqual, verifyPassword, parseCookies } from '../util.js';
import { saveRoom } from '../collab.js';

const r = Router();

const unlockLimiter = rateLimit({
  windowMs: 15 * 60e3, limit: 15, standardHeaders: 'draft-7', legacyHeaders: false,
  message: { error: 'Trop de tentatives, réessayez plus tard' },
});

const cookieName = (link) => `kl_l_${link.id}`;
const unlockValue = (link) => hmac(config.secret, `${link.id}:${link.password_hash}`);

function loadLink(token) {
  const link = one('SELECT * FROM links WHERE token = ?', String(token));
  if (!link || (link.expires_at && link.expires_at < now())) throw new HttpError(404, "Ce lien n'existe pas ou a expiré");
  const root = getItem(link.item_id);
  if (!root || root.trashed_at) throw new HttpError(404, "Ce lien n'existe pas ou a expiré");
  return { link, root };
}

function unlocked(req, link) {
  if (!link.password_hash) return true;
  const value = parseCookies(req.headers.cookie)[cookieName(link)];
  return !!value && safeEqual(value, unlockValue(link));
}

// The requested item must be the shared item itself or something inside it.
function resolveInLink(req, root, itemId) {
  if (!itemId || itemId === root.id) return root;
  const item = getItem(itemId);
  if (!item || item.trashed_at || !ancestorIds(item.id).includes(root.id)) throw new HttpError(404, 'Élément introuvable');
  return item;
}

function guard(req) {
  const { link, root } = loadLink(req.params.token);
  if (!unlocked(req, link)) throw new HttpError(401, 'Mot de passe requis');
  return { link, root };
}

const pub = (row) => {
  const s = serialize(row);
  return { id: s.id, kind: s.kind, name: s.name, size: s.size, mime: s.mime, updatedAt: s.updatedAt, ownerName: s.ownerName };
};

r.get('/:token', (req, res) => {
  const { link, root } = loadLink(req.params.token);
  if (!unlocked(req, link)) return res.status(401).json({ needPassword: true });
  const item = resolveInLink(req, root, req.query.item);
  if (item.id === root.id) run('UPDATE links SET views = views + 1 WHERE id = ?', link.id);
  let crumbs = [];
  let children = null;
  if (item.kind === 'folder') {
    children = all(`${ITEM_SELECT} WHERE i.parent_id = ? AND i.trashed_at IS NULL`, item.id).map(pub);
    const ids = ancestorIds(item.id);
    crumbs = ids.slice(0, ids.indexOf(root.id) + 1).reverse().map((id) => {
      const it = getItem(id);
      return { id: it.id, name: it.name };
    });
  }
  res.json({
    root: pub(one(`${ITEM_SELECT} WHERE i.id = ?`, root.id)),
    item: pub(one(`${ITEM_SELECT} WHERE i.id = ?`, item.id)),
    crumbs,
    children,
  });
});

r.post('/:token/unlock', unlockLimiter, async (req, res) => {
  const { link } = loadLink(req.params.token);
  if (!link.password_hash) return res.json({ ok: true });
  if (!(await verifyPassword(String(req.body?.password || ''), link.password_hash))) {
    throw new HttpError(401, 'Mot de passe incorrect');
  }
  res.cookie(cookieName(link), unlockValue(link), {
    httpOnly: true, secure: config.prod, sameSite: 'lax', path: `/api/public/${link.token}`, maxAge: 12 * 3600e3,
  });
  res.json({ ok: true });
});

r.get('/:token/file/:itemId', (req, res) => {
  const { root } = guard(req);
  sendStoredFile(req, res, resolveInLink(req, root, req.params.itemId));
});

r.get('/:token/images/:itemId/:imageId', (req, res) => {
  const { root } = guard(req);
  const item = resolveInLink(req, root, req.params.itemId);
  return sendDocImage(req, res, item.id, req.params.imageId);
});

r.get('/:token/content/:itemId', (req, res) => {
  const { root } = guard(req);
  const item = resolveInLink(req, root, req.params.itemId);
  if (!['doc', 'sheet'].includes(item.kind)) throw new HttpError(400, 'Contenu indisponible');
  saveRoom(item.id); // latest live edits
  const fresh = getItem(item.id);
  // Document images are served through the link's own route.
  const content = item.kind === 'doc'
    ? (fresh.content ?? '').replaceAll(`/api/items/${item.id}/images/`, `/api/public/${req.params.token}/images/${item.id}/`)
    : fresh.content ?? '';
  res.json({ content, kind: item.kind, name: item.name });
});

export default r;
