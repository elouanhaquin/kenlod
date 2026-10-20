import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, Client } from './helpers.js';

let server;
let anna;
let bob;
let carole;

before(async () => {
  server = await startServer();
  anna = await new Client(server).register('anna@test.bzh', 'Anna');
  bob = await new Client(server).register('bob@test.bzh', 'Bob');
  carole = await new Client(server).register('carole@test.bzh', 'Carole');
});

after(() => server.stop());

test('requests without the CSRF token are refused', async () => {
  const r = await anna.req('POST', '/api/items', { kind: 'folder', name: 'x' }, { headers: { 'X-CSRF': 'nope' } });
  assert.equal(r.status, 403);
  const r2 = await anna.req('POST', '/api/items', { kind: 'folder', name: 'x' }, { headers: { 'X-Kenlod': '' } });
  assert.equal(r2.status, 403);
});

test('private files stay private, sharing grants exactly the given role', async () => {
  const folder = (await anna.req('POST', '/api/items', { kind: 'folder', name: 'Compta 2026' })).data.item;
  const file = (await anna.upload('bilan é.txt', 'secret', `&parentId=${folder.id}`)).data.item;
  assert.equal(file.name, 'bilan é.txt');

  assert.equal((await bob.req('GET', `/api/items/${file.id}`)).status, 404);
  assert.equal((await bob.req('GET', `/api/items/${file.id}/download`, null, { raw: true })).status, 404);

  const share = await anna.req('POST', `/api/items/${folder.id}/shares`, { email: 'bob@test.bzh', role: 'viewer' });
  assert.equal(share.status, 201);

  const dl = await bob.req('GET', `/api/items/${file.id}/download`, null, { raw: true });
  assert.equal(dl.status, 200);
  assert.equal(dl.data, 'secret');
  assert.match(dl.headers.get('content-disposition'), /attachment/);
  // Partial content, needed for video seeking.
  const part = await bob.req('GET', `/api/items/${file.id}/download`, null, { raw: true, headers: { Range: 'bytes=0-2' } });
  assert.equal(part.status, 206);
  assert.equal(part.data, 'sec');

  // Viewer can't write, rename or share.
  assert.equal((await bob.upload('evil.txt', 'x', `&parentId=${folder.id}`)).status, 403);
  assert.equal((await bob.req('PATCH', `/api/items/${file.id}`, { name: 'pwned' })).status, 403);
  assert.equal((await bob.req('POST', `/api/items/${folder.id}/shares`, { email: 'carole@test.bzh', role: 'editor' })).status, 403);
  assert.equal((await carole.req('GET', `/api/folder?id=${folder.id}`)).status, 404);

  const shared = await bob.req('GET', '/api/shared');
  assert.deepEqual(shared.data.items.map((i) => i.id), [folder.id]);

  // Upgrade to editor: Bob can upload, but can't delete Anna's file.
  await anna.req('POST', `/api/items/${folder.id}/shares`, { email: 'bob@test.bzh', role: 'editor' });
  const bobFile = await bob.upload('notes.txt', 'hello', `&parentId=${folder.id}`);
  assert.equal(bobFile.status, 201);
  assert.equal((await bob.req('POST', `/api/items/${file.id}/trash`)).status, 403);
  assert.equal((await bob.req('POST', `/api/items/${bobFile.data.item.id}/trash`)).status, 200);

  // Revoking removes access.
  const list = await anna.req('GET', `/api/items/${folder.id}/shares`);
  await anna.req('DELETE', `/api/shares/${list.data.shares[0].id}`);
  assert.equal((await bob.req('GET', `/api/items/${file.id}`)).status, 404);
});

test('group spaces follow member roles', async () => {
  const g = (await anna.req('POST', '/api/groups', { name: 'Fest-noz Kemper' })).data.group;
  const space = `g:${g.id}`;
  await anna.req('POST', `/api/groups/${g.id}/members`, { email: 'bob@test.bzh', role: 'viewer' });

  const doc = (await anna.req('POST', '/api/items', { kind: 'doc', name: 'Programme', space })).data.item;
  assert.equal((await bob.req('GET', `/api/items/${doc.id}/content`)).status, 200);
  assert.equal((await bob.req('PATCH', `/api/items/${doc.id}`, { name: 'x' })).status, 403);
  assert.equal((await carole.req('GET', `/api/items/${doc.id}/content`)).status, 404);
  assert.equal((await carole.req('GET', `/api/groups/${g.id}`)).status, 404);

  await anna.req('PATCH', `/api/groups/${g.id}/members/${bob.user.id}`, { role: 'editor' });
  assert.equal((await bob.req('PATCH', `/api/items/${doc.id}`, { name: 'Programme 2026' })).status, 200);

  // Invite link adds Carole.
  const inv = (await anna.req('POST', `/api/groups/${g.id}/invites`, { role: 'viewer' })).data.invites[0];
  assert.equal((await carole.req('POST', `/api/invites/${inv.token}/accept`)).status, 200);
  assert.equal((await carole.req('GET', `/api/items/${doc.id}/content`)).status, 200);

  // Last admin can't leave.
  assert.equal((await anna.req('DELETE', `/api/groups/${g.id}/members/${anna.user.id}`)).status, 400);
});

test('public links: password, scope and expiry', async () => {
  const folder = (await anna.req('POST', '/api/items', { kind: 'folder', name: 'Affiches' })).data.item;
  const inside = (await anna.upload('affiche.txt', 'gouel', `&parentId=${folder.id}`)).data.item;
  const outside = (await anna.upload('prive.txt', 'secret')).data.item;
  const links = (await anna.req('POST', `/api/items/${folder.id}/links`, { password: 'kenavo' })).data.links;
  const token = links[0].token;

  const visitor = new Client(server);
  assert.equal((await visitor.req('GET', `/api/public/${token}`)).status, 401);
  assert.equal((await visitor.req('GET', `/api/public/${token}/file/${inside.id}`, null, { raw: true })).status, 401);
  assert.equal((await visitor.req('POST', `/api/public/${token}/unlock`, { password: 'faux' })).status, 401);
  assert.equal((await visitor.req('POST', `/api/public/${token}/unlock`, { password: 'kenavo' })).status, 200);

  const view = await visitor.req('GET', `/api/public/${token}`);
  assert.deepEqual(view.data.children.map((c) => c.name), ['affiche.txt']);
  const dl = await visitor.req('GET', `/api/public/${token}/file/${inside.id}`, null, { raw: true });
  assert.equal(dl.data, 'gouel');
  // Items outside the shared folder are unreachable through the link.
  assert.equal((await visitor.req('GET', `/api/public/${token}/file/${outside.id}`, null, { raw: true })).status, 404);

  await anna.req('DELETE', `/api/links/${links[0].id}`);
  assert.equal((await visitor.req('GET', `/api/public/${token}`)).status, 404);
});

test('document images: real images only, same access as the document, reachable from public links', async () => {
  const doc = (await anna.req('POST', '/api/items', { kind: 'doc', name: 'Affiche' })).data.item;
  const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
  const fd = new FormData();
  fd.append('file', new Blob([png]), 'a.png');
  const up = await anna.req('POST', `/api/items/${doc.id}/images`, fd);
  assert.equal(up.status, 201, JSON.stringify(up.data));
  const { src } = up.data;
  assert.match(src, new RegExp(`^/api/items/${doc.id}/images/`));

  const fake = new FormData();
  fake.append('file', new Blob(['<svg onload="alert(1)"/>']), 'a.png');
  assert.equal((await anna.req('POST', `/api/items/${doc.id}/images`, fake)).status, 415);

  const own = await anna.req('GET', src, null, { raw: true });
  assert.equal(own.status, 200);
  assert.equal(own.headers.get('content-type'), 'image/png');
  assert.equal((await carole.req('GET', src, null, { raw: true })).status, 404);

  const link = (await anna.req('POST', `/api/items/${doc.id}/links`, {})).data.links[0];
  const visitor = new Client(server);
  const imageId = src.split('/').pop();
  assert.equal((await visitor.req('GET', `/api/public/${link.token}/images/${doc.id}/${imageId}`, null, { raw: true })).status, 200);
});

test('html and svg uploads are never rendered inline', async () => {
  const f = (await anna.upload('page.html', '<script>alert(1)</script>')).data.item;
  const r = await anna.req('GET', `/api/items/${f.id}/download?inline=1`, null, { raw: true });
  assert.match(r.headers.get('content-disposition'), /^attachment/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
});

test('trash and restore', async () => {
  const folder = (await anna.req('POST', '/api/items', { kind: 'folder', name: 'Archives' })).data.item;
  const child = (await anna.upload('a.txt', 'a', `&parentId=${folder.id}`)).data.item;
  await anna.req('POST', `/api/items/${folder.id}/trash`);
  assert.equal((await anna.req('GET', `/api/items/${child.id}/download`, null, { raw: true })).status, 404);
  const trash = await anna.req('GET', '/api/trash');
  assert.ok(trash.data.items.some((i) => i.id === folder.id));
  assert.ok(!trash.data.items.some((i) => i.id === child.id));
  await anna.req('POST', `/api/items/${folder.id}/restore`);
  assert.equal((await anna.req('GET', `/api/items/${child.id}/download`, null, { raw: true })).status, 200);
});

test('search only returns accessible items', async () => {
  await anna.upload('budget-secret-xyz.txt', '1');
  assert.equal((await anna.req('GET', '/api/search?q=secret-xyz')).data.items.length, 1);
  assert.equal((await bob.req('GET', '/api/search?q=secret-xyz')).data.items.length, 0);
});
