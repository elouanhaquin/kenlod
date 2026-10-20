import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer, Client, until } from './helpers.js';

let server;
before(async () => {
  server = await startServer({ EMAIL_VERIFICATION: 'required', APP_URL: 'https://kenlod.test' });
});
after(() => server.stop());

// Mails land in DATA_DIR/outbox when no SMTP server is configured.
function outbox(to) {
  const dir = path.join(server.dataDir, 'outbox');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).sort().map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))).filter((m) => m.to === to);
}
const linkToken = (mail, route) => mail.text.match(new RegExp(`https://kenlod\\.test/${route}/([\\w-]+)`))?.[1];
const lastMail = async (to, subject) => {
  let found;
  await until(() => { found = outbox(to).filter((m) => m.subject.includes(subject)).at(-1); return !!found; });
  return found;
};

test('new accounts must confirm their address before using the app', async () => {
  const anna = await new Client(server).register('anna@example.org', 'Anna Le Gall');
  assert.equal(anna.user.verified, false);

  // Blocked everywhere except the auth routes.
  const blocked = await anna.req('GET', '/api/folder');
  assert.equal(blocked.status, 403);
  assert.equal(blocked.data.reason, 'unverified');
  assert.equal((await anna.req('GET', '/api/auth/me')).data.mustVerify, true);

  const mail = await lastMail('anna@example.org', 'Confirmez');
  const token = linkToken(mail, 'verifier');
  assert.ok(token, mail.text);
  assert.equal((await anna.req('POST', '/api/auth/verify', { token: 'faux' })).status, 400);
  assert.equal((await anna.req('POST', '/api/auth/verify', { token })).status, 200);
  // A link only works once.
  assert.equal((await anna.req('POST', '/api/auth/verify', { token })).status, 400);

  const me = await anna.req('GET', '/api/auth/me');
  assert.equal(me.data.mustVerify, false);
  assert.equal((await anna.req('GET', '/api/folder')).status, 200);
});

test('resending replaces the previous confirmation link', async () => {
  const yann = await new Client(server).register('yann@example.org', 'Yann Kerjean');
  const first = linkToken(await lastMail('yann@example.org', 'Confirmez'), 'verifier');
  assert.equal((await yann.req('POST', '/api/auth/verify/resend')).status, 200);
  await until(() => outbox('yann@example.org').length === 2);
  const second = linkToken(outbox('yann@example.org').at(-1), 'verifier');
  assert.notEqual(first, second);
  assert.equal((await yann.req('POST', '/api/auth/verify', { token: first })).status, 400);
  assert.equal((await yann.req('POST', '/api/auth/verify', { token: second })).status, 200);
});

test('password reset: same answer for unknown addresses, one-time link, sessions revoked', async () => {
  const gwen = await new Client(server).register('gwen@example.org', 'Gwenaël Morvan');
  const anon = new Client(server);

  assert.deepEqual((await anon.req('POST', '/api/auth/forgot', { email: 'personne@example.org' })).data, { ok: true });
  assert.deepEqual((await anon.req('POST', '/api/auth/forgot', { email: 'GWEN@example.org' })).data, { ok: true });
  const token = linkToken(await lastMail('gwen@example.org', 'Réinitialiser'), 'reinitialiser');
  assert.equal(outbox('personne@example.org').length, 0);

  assert.equal((await anon.req('POST', '/api/auth/reset', { token, password: 'court' })).status, 400);
  assert.equal((await anon.req('POST', '/api/auth/reset', { token, password: 'nouveau-mot-de-passe' })).status, 200);
  assert.equal((await anon.req('POST', '/api/auth/reset', { token, password: 'encore-un-autre-mdp' })).status, 400);

  // The old session is gone, the old password no longer works, the new one does, and the address counts as confirmed.
  assert.equal((await gwen.req('GET', '/api/auth/me')).data.user, null);
  assert.equal((await anon.req('POST', '/api/auth/login', { email: 'gwen@example.org', password: 'correct-horse-battery' })).status, 401);
  const login = await anon.req('POST', '/api/auth/login', { email: 'gwen@example.org', password: 'nouveau-mot-de-passe' });
  assert.equal(login.status, 200);
  assert.equal(login.data.mustVerify, false);
});

test('group invitations can be e-mailed', async () => {
  const admin = await new Client(server).register('maiwenn@example.org', 'Maïwenn');
  await admin.req('POST', '/api/auth/verify', { token: linkToken(await lastMail('maiwenn@example.org', 'Confirmez'), 'verifier') });
  const g = await admin.req('POST', '/api/groups', { name: 'Cercle celtique' });
  const id = g.data.group?.id || g.data.id;

  assert.equal((await admin.req('POST', `/api/groups/${id}/invites`, { emails: ['pas-une-adresse'] })).status, 400);
  const res = await admin.req('POST', `/api/groups/${id}/invites`, { role: 'viewer', emails: ['nolwenn@example.org', 'NOLWENN@example.org'] });
  assert.equal(res.status, 201);
  assert.equal(res.data.sent, 1);
  const mail = await lastMail('nolwenn@example.org', 'Cercle celtique');
  assert.equal(linkToken(mail, 'rejoindre'), res.data.invites[0].token);
  assert.match(mail.text, /Maïwenn vous invite/);
});
