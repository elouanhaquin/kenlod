// Realtime collaboration for documents and spreadsheets: Yjs over WebSocket (y-websocket protocol).
// The server is authoritative: it checks permissions, ignores edits from read-only users,
// stamps every presence state with the real user name, and persists snapshots to SQLite.
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { WebSocketServer } from 'ws';
import { one, run } from './db.js';
import { getItem, roleFor, atLeast, logActivity } from './access.js';
import { sessionFromCookie, isBlocked } from './routes/auth.js';
import { sanitizeDoc, validateSheet } from './content.js';
import { htmlIntoYDoc, yDocToHtml } from './docconvert.js';
import { now } from './util.js';

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;
const SAVE_DELAY = Number(process.env.COLLAB_SAVE_MS || 1500);
const SAVE_MAX_WAIT = 10000;
const COLORS = ['#e8590c', '#2f9e44', '#1971c2', '#c2255c', '#6741d9', '#0c8599', '#f08c00', '#d6336c', '#5c940d', '#364fc7'];

const rooms = new Map();

export function colorForUser(id) {
  let n = 0;
  for (const ch of id) n = (n * 31 + ch.charCodeAt(0)) >>> 0;
  return COLORS[n % COLORS.length];
}

function send(ws, message) {
  if (ws.readyState === ws.OPEN) ws.send(message, (err) => err && ws.terminate());
}

export function sheetToYDoc(content, ydoc) {
  let data = {};
  try { data = JSON.parse(content || '{}'); } catch { /* empty sheet */ }
  ydoc.transact(() => {
    const cells = ydoc.getMap('cells');
    for (const [key, cell] of Object.entries(data.cells || {})) cells.set(key, cell);
    const meta = ydoc.getMap('meta');
    meta.set('rows', data.rows || 100);
    meta.set('cols', data.cols || 26);
    if (data.freeze) meta.set('freeze', 1);
    const widths = ydoc.getMap('widths');
    for (const [key, w] of Object.entries(data.widths || {})) widths.set(key, w);
  });
}

export function yDocToSheet(ydoc) {
  const meta = ydoc.getMap('meta');
  return validateSheet(JSON.stringify({
    rows: meta.get('rows') || 100,
    cols: meta.get('cols') || 26,
    freeze: meta.get('freeze') || 0,
    cells: ydoc.getMap('cells').toJSON(),
    widths: ydoc.getMap('widths').toJSON(),
  }));
}

class Room {
  constructor(item) {
    this.id = item.id;
    this.kind = item.kind;
    this.doc = new Y.Doc();
    this.conns = new Map(); // ws → { userId, name, color, canEdit, ids }
    this.editors = new Set();
    this.lastEditor = null;
    let fresh = false;
    if (item.ydoc) Y.applyUpdate(this.doc, item.ydoc);
    else {
      // First collaborative opening: build the shared state from the stored snapshot.
      if (this.kind === 'doc') htmlIntoYDoc(item.content || '', this.doc);
      else sheetToYDoc(item.content, this.doc);
      fresh = true;
    }
    this.awareness = new awarenessProtocol.Awareness(this.doc);
    this.awareness.setLocalState(null);

    this.doc.on('update', (update, origin) => {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_SYNC);
      syncProtocol.writeUpdate(enc, update);
      const msg = encoding.toUint8Array(enc);
      for (const ws of this.conns.keys()) send(ws, msg);
      if (origin?.userId) {
        this.editors.add(origin.userId);
        this.lastEditor = origin.userId;
      }
      this.scheduleSave();
    });

    this.awareness.on('update', ({ added, updated, removed }, origin) => {
      const conn = this.conns.get(origin);
      if (conn) {
        added.forEach((id) => conn.ids.add(id));
        removed.forEach((id) => conn.ids.delete(id));
      }
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_AWARENESS);
      encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(this.awareness, added.concat(updated, removed)));
      const msg = encoding.toUint8Array(enc);
      for (const ws of this.conns.keys()) send(ws, msg);
    });

    if (fresh) this.save(false);
  }

  scheduleSave() {
    clearTimeout(this.saveTimer);
    this.firstPending ??= Date.now();
    const wait = Math.max(0, Math.min(SAVE_DELAY, this.firstPending + SAVE_MAX_WAIT - Date.now()));
    this.saveTimer = setTimeout(() => this.save(), wait);
  }

  save(bumpVersion = true) {
    clearTimeout(this.saveTimer);
    this.firstPending = null;
    try {
      const item = getItem(this.id);
      if (!item) return;
      const content = this.kind === 'doc' ? sanitizeDoc(yDocToHtml(this.doc)) : yDocToSheet(this.doc);
      const state = Y.encodeStateAsUpdate(this.doc);
      run(
        `UPDATE items SET ydoc = ?, content = ?, size = ?, version = version + ?, updated_at = ?, updated_by = COALESCE(?, updated_by)
         WHERE id = ?`,
        state, content, Buffer.byteLength(content), bumpVersion ? 1 : 0, bumpVersion ? now() : item.updated_at,
        bumpVersion ? this.lastEditor : null, this.id,
      );
      for (const userId of this.editors) {
        const recent = one(
          "SELECT 1 FROM activity WHERE item_id = ? AND user_id = ? AND action = 'edit' AND created_at > ?",
          this.id, userId, now() - 15 * 60e3,
        );
        if (!recent) logActivity(item, userId, 'edit');
      }
      this.editors.clear();
    } catch (err) {
      console.error(`collab: could not save ${this.id}`, err);
    }
  }

  // Rewrites a client's awareness update: drops entries for clients owned by another connection
  // and replaces the user identity with the authenticated one.
  sanitizeAwareness(update, conn, ws) {
    const dec = decoding.createDecoder(update);
    const count = decoding.readVarUint(dec);
    const kept = [];
    for (let i = 0; i < count; i++) {
      const clientId = decoding.readVarUint(dec);
      const clock = decoding.readVarUint(dec);
      const raw = decoding.readVarString(dec);
      const owner = [...this.conns].find(([, c]) => c.ids.has(clientId));
      if (owner && owner[0] !== ws) continue;
      if (raw.length > 4096) continue;
      let state = JSON.parse(raw);
      if (state !== null) {
        state = { ...state, user: { id: conn.userId, name: conn.name, color: conn.color, canEdit: conn.canEdit } };
      }
      kept.push([clientId, clock, JSON.stringify(state)]);
    }
    if (!kept.length) return null;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, kept.length);
    for (const [id, clock, json] of kept) {
      encoding.writeVarUint(enc, id);
      encoding.writeVarUint(enc, clock);
      encoding.writeVarString(enc, json);
    }
    return encoding.toUint8Array(enc);
  }

  onMessage(ws, conn, message) {
    const dec = decoding.createDecoder(message);
    const type = decoding.readVarUint(dec);
    if (type === MSG_SYNC) {
      // Read-only users may ask for the document, never change it.
      if (decoding.peekVarUint(dec) !== syncProtocol.messageYjsSyncStep1 && !conn.canEdit) return;
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_SYNC);
      syncProtocol.readSyncMessage(dec, enc, this.doc, conn);
      if (encoding.length(enc) > 1) send(ws, encoding.toUint8Array(enc));
    } else if (type === MSG_AWARENESS) {
      const clean = this.sanitizeAwareness(decoding.readVarUint8Array(dec), conn, ws);
      if (clean) awarenessProtocol.applyAwarenessUpdate(this.awareness, clean, ws);
    }
  }

  join(ws, conn) {
    this.conns.set(ws, conn);
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeSyncStep1(enc, this.doc);
    send(ws, encoding.toUint8Array(enc));
    const states = [...this.awareness.getStates().keys()];
    if (states.length) {
      const a = encoding.createEncoder();
      encoding.writeVarUint(a, MSG_AWARENESS);
      encoding.writeVarUint8Array(a, awarenessProtocol.encodeAwarenessUpdate(this.awareness, states));
      send(ws, encoding.toUint8Array(a));
    }
  }

  leave(ws) {
    const conn = this.conns.get(ws);
    if (!conn) return;
    this.conns.delete(ws);
    awarenessProtocol.removeAwarenessStates(this.awareness, [...conn.ids], null);
    if (!this.conns.size) {
      this.save();
      this.doc.destroy();
      rooms.delete(this.id);
    }
  }
}

function getRoom(item) {
  let room = rooms.get(item.id);
  if (!room) {
    room = new Room(item);
    rooms.set(item.id, room);
  }
  return room;
}

// Saves and closes the live room of an item (used before deleting it).
export function closeRoom(itemId, code = 4404) {
  const room = rooms.get(itemId);
  if (!room) return;
  for (const ws of [...room.conns.keys()]) ws.close(code, 'closed');
}

export function saveRoom(itemId) {
  rooms.get(itemId)?.save();
}

export function flushAll() {
  for (const room of rooms.values()) room.save();
}

function reject(socket, status, text) {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

export function attachCollab(server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });

  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    const m = /^\/ws\/items\/([\w-]+)$/.exec(pathname);
    if (!m) return reject(socket, 404, 'Not Found');
    // Cross-site WebSocket hijacking protection: the page must come from this host.
    let originHost = null;
    try { originHost = new URL(req.headers.origin).host; } catch { /* missing */ }
    if (originHost !== req.headers.host) return reject(socket, 403, 'Forbidden');
    const auth = sessionFromCookie(req.headers.cookie);
    if (!auth || isBlocked(auth.user)) return reject(socket, 401, 'Unauthorized');
    const item = getItem(m[1]);
    const role = item && !item.trashed_at && ['doc', 'sheet'].includes(item.kind) ? roleFor(auth.user.id, item) : null;
    if (!role) return reject(socket, 404, 'Not Found');

    wss.handleUpgrade(req, socket, head, (ws) => {
      const room = getRoom(item);
      const conn = {
        userId: auth.user.id, name: auth.user.name, color: colorForUser(auth.user.id),
        canEdit: atLeast(role, 'editor'), ids: new Set(), tokenHash: auth.session.tokenHash, alive: true,
      };
      ws.on('message', (data) => {
        try {
          room.onMessage(ws, conn, new Uint8Array(data));
        } catch (err) {
          console.error('collab: bad message', err.message);
          ws.close(1003, 'bad message');
        }
      });
      ws.on('pong', () => { conn.alive = true; });
      ws.on('close', () => room.leave(ws));
      ws.on('error', () => ws.terminate());
      room.join(ws, conn);
    });
  });

  // Keep-alive, and re-check permissions: revoked shares and logouts take effect within seconds.
  setInterval(() => {
    for (const room of rooms.values()) {
      const item = getItem(room.id);
      for (const [ws, conn] of room.conns) {
        if (!conn.alive) { ws.terminate(); continue; }
        conn.alive = false;
        ws.ping();
        const session = one('SELECT 1 FROM sessions WHERE token_hash = ? AND expires_at > ?', conn.tokenHash, now());
        const role = session && item && !item.trashed_at ? roleFor(conn.userId, item) : null;
        if (!role) { ws.close(4403, 'access revoked'); continue; }
        conn.canEdit = atLeast(role, 'editor');
      }
    }
  }, Number(process.env.COLLAB_CHECK_MS || 15000)).unref();

  return wss;
}
