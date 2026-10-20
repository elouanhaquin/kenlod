import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import WS from 'ws';
import { WebsocketProvider } from 'y-websocket';
import { startServer, Client, until } from './helpers.js';

let server;
let anna;
let bob;
let carole;
const open = [];

before(async () => {
  server = await startServer({ COLLAB_SAVE_MS: '100', COLLAB_CHECK_MS: '300' });
  anna = await new Client(server).register('anna@test.bzh', 'Anna');
  bob = await new Client(server).register('bob@test.bzh', 'Bob');
  carole = await new Client(server).register('carole@test.bzh', 'Carole');
});

after(async () => {
  for (const p of open) {
    p.destroy();
    p.awareness.destroy(); // its outdated-state timer would keep the test process alive
    p.doc.destroy();
  }
  await server.stop();
});

function connect(client, itemId, { origin } = {}) {
  const headers = { Cookie: client.cookieHeader, Origin: origin ?? server.base };
  const Polyfill = class extends WS {
    constructor(url, protocols) { super(url, protocols, { headers }); }
  };
  const doc = new Y.Doc();
  const provider = new WebsocketProvider(`ws://${server.host}/ws/items`, itemId, doc, { WebSocketPolyfill: Polyfill, disableBc: true });
  open.push(provider);
  const synced = new Promise((resolve) => provider.on('sync', (s) => s && resolve()));
  return { doc, provider, synced };
}

// Raw handshake result, to check refused connections.
function handshake(client, itemId, origin = server.base) {
  return new Promise((resolve) => {
    const ws = new WS(`ws://${server.host}/ws/items/${itemId}`, { headers: { Cookie: client?.cookieHeader || '', Origin: origin } });
    ws.on('open', () => { ws.close(); resolve(101); });
    ws.on('unexpected-response', (_req, res) => resolve(res.statusCode));
    ws.on('error', () => {});
  });
}

const paragraph = (text) => {
  const p = new Y.XmlElement('paragraph');
  p.insert(0, [new Y.XmlText(text)]);
  return p;
};
const textOf = (doc) => doc.getXmlFragment('default').toString();

test('edits reach other editors instantly and are saved as html', async () => {
  const doc = (await anna.req('POST', '/api/items', { kind: 'doc', name: 'CR' })).data.item;
  await anna.req('POST', `/api/items/${doc.id}/shares`, { email: 'bob@test.bzh', role: 'editor' });
  const a = connect(anna, doc.id);
  const b = connect(bob, doc.id);
  await Promise.all([a.synced, b.synced]);

  const t0 = Date.now();
  a.doc.getXmlFragment('default').insert(0, [paragraph('Demat')]);
  await until(() => textOf(b.doc).includes('Demat'));
  assert.ok(Date.now() - t0 < 1000, 'propagation should be near-instant');

  // Concurrent edits merge.
  b.doc.getXmlFragment('default').insert(1, [paragraph('Kenavo')]);
  a.doc.getXmlFragment('default').insert(0, [paragraph('Titre')]);
  await until(() => textOf(a.doc) === textOf(b.doc) && textOf(a.doc).includes('Kenavo') && textOf(a.doc).includes('Titre'));

  await until(async () => (await anna.req('GET', `/api/items/${doc.id}/content`)).data.content.includes('Kenavo'));
  const { content } = (await anna.req('GET', `/api/items/${doc.id}/content`)).data;
  assert.match(content, /<p>Demat<\/p>/);
  a.provider.destroy();
  b.provider.destroy();
});

test('read-only users cannot change the document', async () => {
  const doc = (await anna.req('POST', '/api/items', { kind: 'doc', name: 'Statuts' })).data.item;
  await anna.req('POST', `/api/items/${doc.id}/shares`, { email: 'bob@test.bzh', role: 'viewer' });
  const a = connect(anna, doc.id);
  const b = connect(bob, doc.id);
  await Promise.all([a.synced, b.synced]);
  a.doc.getXmlFragment('default').insert(0, [paragraph('officiel')]);
  await until(() => textOf(b.doc).includes('officiel'));

  b.doc.getXmlFragment('default').insert(0, [paragraph('pirate')]);
  await new Promise((r) => setTimeout(r, 400));
  assert.ok(!textOf(a.doc).includes('pirate'));
  const { content } = (await anna.req('GET', `/api/items/${doc.id}/content`)).data;
  assert.doesNotMatch(content, /pirate/);
  a.provider.destroy();
  b.provider.destroy();
});

test('connections are refused without access, session or same origin', async () => {
  const doc = (await anna.req('POST', '/api/items', { kind: 'doc', name: 'Privé' })).data.item;
  assert.equal(await handshake(anna, doc.id), 101);
  assert.equal(await handshake(carole, doc.id), 404);
  assert.equal(await handshake(null, doc.id), 401);
  assert.equal(await handshake(anna, doc.id, 'https://evil.example'), 403);
});

test('presence: names come from the server, cursors are shared', async () => {
  const doc = (await anna.req('POST', '/api/items', { kind: 'doc', name: 'Présence' })).data.item;
  await anna.req('POST', `/api/items/${doc.id}/shares`, { email: 'bob@test.bzh', role: 'editor' });
  const a = connect(anna, doc.id);
  const b = connect(bob, doc.id);
  await Promise.all([a.synced, b.synced]);
  b.provider.awareness.setLocalStateField('user', { name: 'Le Président', color: '#000' });
  b.provider.awareness.setLocalStateField('cursor', { anchor: 1 });
  const seen = await until(() => [...a.provider.awareness.getStates().values()].find((s) => s.cursor));
  assert.equal(seen.user.name, 'Bob');
  assert.notEqual(seen.user.color, '#000');
  a.provider.destroy();
  b.provider.destroy();
});

test('revoking a share disconnects the live session', async () => {
  const doc = (await anna.req('POST', '/api/items', { kind: 'doc', name: 'Révocation' })).data.item;
  const shares = (await anna.req('POST', `/api/items/${doc.id}/shares`, { email: 'carole@test.bzh', role: 'editor' })).data.shares;
  const c = connect(carole, doc.id);
  await c.synced;
  const closed = new Promise((resolve) => c.provider.on('connection-close', (e) => resolve(e?.code)));
  await anna.req('DELETE', `/api/shares/${shares[0].id}`);
  assert.equal(await closed, 4403);
  c.provider.destroy();
});

test('invalid nodes are dropped from the saved html', async () => {
  const doc = (await anna.req('POST', '/api/items', { kind: 'doc', name: 'XSS' })).data.item;
  const a = connect(anna, doc.id);
  await a.synced;
  const evil = new Y.XmlElement('script');
  evil.insert(0, [new Y.XmlText('alert(1)')]);
  a.doc.getXmlFragment('default').insert(0, [paragraph('<img src=x onerror=alert(1)>'), evil]);
  await until(async () => (await anna.req('GET', `/api/items/${doc.id}/content`)).data.content.includes('img'));
  const { content } = (await anna.req('GET', `/api/items/${doc.id}/content`)).data;
  assert.doesNotMatch(content, /<script|<img/);
  assert.match(content, /&lt;img/);
  a.provider.destroy();
});

test('spreadsheets sync cells and keep a json snapshot', async () => {
  const sheet = (await anna.req('POST', '/api/items', { kind: 'sheet', name: 'Budget' })).data.item;
  const a = connect(anna, sheet.id);
  await a.synced;
  assert.equal(a.doc.getMap('meta').get('rows'), 100);
  a.doc.getMap('cells').set('A1', { v: '42' });
  a.doc.getMap('cells').set('A2', { v: '=A1*2', b: 1 });
  await until(async () => JSON.parse((await anna.req('GET', `/api/items/${sheet.id}/content`)).data.content).cells.A2);
  const data = JSON.parse((await anna.req('GET', `/api/items/${sheet.id}/content`)).data.content);
  assert.deepEqual(data.cells.A2, { v: '=A1*2', b: 1 });
  a.provider.destroy();
});
