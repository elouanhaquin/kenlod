import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, Client } from './helpers.js';

let server;
let owner;
before(async () => {
  server = await startServer();
  owner = await new Client(server).register('anna@example.org', 'Anna Le Gall');
});
after(() => server.stop());

const DEFINITION = {
  title: 'Inscription au fest-noz',
  description: 'Samedi 26 avril',
  confirmation: 'Trugarez !',
  questions: [
    { id: 'nom', type: 'short', label: 'Nom', required: true },
    { id: 'repas', type: 'single', label: 'Repas', options: ['Crêpes', 'Galettes', 'Les deux'], required: true },
    { id: 'aide', type: 'multiple', label: 'Je peux aider', options: ['Montage', 'Buvette', 'Rangement'] },
    { id: 'note', type: 'scale', label: 'Envie', min: 1, max: 5 },
    { id: 'nb', type: 'number', label: 'Nombre de personnes' },
    { id: 'mail', type: 'email', label: 'E-mail' },
    { id: 's1', type: 'section', label: 'Merci', help: 'À bientôt' },
  ],
};

async function newForm(client = owner) {
  const { data } = await client.req('POST', '/api/items', { kind: 'form', name: 'Fest-noz' });
  const form = await client.req('GET', `/api/items/${data.item.id}/form`);
  const saved = await client.req('PUT', `/api/items/${data.item.id}/form`, { definition: DEFINITION, version: form.data.version });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  return { id: data.item.id, token: form.data.token, version: saved.data.version };
}

test('create, edit and reject a stale edit', async () => {
  const { id, version } = await newForm();
  const form = (await owner.req('GET', `/api/items/${id}/form`)).data;
  assert.equal(form.item.kind, 'form');
  assert.equal(form.definition.questions.length, 7);
  assert.equal(form.definition.questions[3].max, 5);

  const stale = await owner.req('PUT', `/api/items/${id}/form`, { definition: DEFINITION, version: version - 1 });
  assert.equal(stale.status, 409);
  assert.equal(stale.data.reason, 'conflict');

  const bad = await owner.req('PUT', `/api/items/${id}/form`, { definition: { questions: [{ id: 'x', type: 'bogus' }] }, version });
  assert.equal(bad.status, 400);
  const dup = await owner.req('PUT', `/api/items/${id}/form`, { definition: { questions: [{ id: 'x', type: 'short' }, { id: 'x', type: 'long' }] }, version });
  assert.equal(dup.status, 400);
});

test('anyone with the link can answer; answers are validated', async () => {
  const { id, token } = await newForm();
  const anon = new Client(server);
  const pub = await anon.req('GET', `/api/f/${token}`);
  assert.equal(pub.status, 200);
  assert.equal(pub.data.title, 'Inscription au fest-noz');
  assert.equal(pub.data.open, true);
  // The public view never exposes editor data.
  assert.equal(pub.data.token, undefined);
  assert.equal(pub.data.responses, undefined);

  const send = (answers, extra = {}) => anon.req('POST', `/api/f/${token}`, { answers, ...extra });
  assert.equal((await send({ repas: 'Crêpes' })).status, 400, 'missing required');
  assert.equal((await send({ nom: 'Yann', repas: 'Pizza' })).status, 400, 'unknown option');
  assert.equal((await send({ nom: 'Yann', repas: 'Crêpes', note: 9 })).status, 400, 'out of scale');
  assert.equal((await send({ nom: 'Yann', repas: 'Crêpes', mail: 'pas-un-mail' })).status, 400);
  assert.equal((await send({ nom: 'Yann', repas: 'Crêpes', nb: 'beaucoup' })).status, 400);

  const ok = await send({ nom: 'Yann', repas: 'Crêpes', aide: ['Buvette', 'Montage', 'Hack'], note: 5, nb: '3', extra: 'ignored' });
  assert.equal(ok.status, 400, 'unknown checkbox value is refused');
  const ok2 = await send({ nom: 'Yann', repas: 'Crêpes', aide: ['Buvette', 'Montage'], note: 5, nb: '3', extra: 'ignored' });
  assert.equal(ok2.status, 201);
  assert.equal(ok2.data.confirmation, 'Trugarez !');
  assert.equal((await send({ nom: '=HYPERLINK("x")', repas: 'Les deux', nb: '2,5' })).status, 201);
  // Honeypot: looks accepted, but nothing is stored.
  assert.equal((await send({ nom: 'Bot', repas: 'Crêpes' }, { website: 'http://spam' })).status, 201);

  const res = await owner.req('GET', `/api/items/${id}/responses`);
  assert.equal(res.data.responses.length, 2);
  const first = res.data.responses[0];
  assert.deepEqual(first.answers, { nom: 'Yann', repas: 'Crêpes', aide: ['Montage', 'Buvette'], note: 5, nb: 3 });
  assert.equal(first.user, null, 'anonymous by default');
  assert.equal(res.data.responses[1].answers.nb, 2.5);

  // CSV export neutralises formulas.
  const csv = await owner.req('GET', `/api/items/${id}/responses.csv`, undefined, { raw: true });
  assert.equal(csv.status, 200);
  assert.match(csv.data, /Nom;Repas;Je peux aider/);
  assert.match(csv.data, /"'=HYPERLINK\(""x""\)"/);
  assert.match(csv.data, /Montage; Buvette/);

  // Responses → spreadsheet.
  const sheet = await owner.req('POST', `/api/items/${id}/responses/sheet`);
  assert.equal(sheet.status, 201);
  const content = JSON.parse((await owner.req('GET', `/api/items/${sheet.data.item.id}/content`)).data.content);
  assert.equal(content.cells.B1.v, 'Nom');
  assert.equal(content.cells.B2.v, 'Yann');
  assert.equal(content.cells.B3.v, "'=HYPERLINK(\"x\")");
});

test('only editors see responses; viewers and strangers do not', async () => {
  const { id, token } = await newForm();
  const viewer = await new Client(server).register('yann@example.org', 'Yann');
  const stranger = await new Client(server).register('gwen@example.org', 'Gwen');
  await owner.req('POST', `/api/items/${id}/shares`, { email: 'yann@example.org', role: 'viewer' });
  assert.equal((await viewer.req('GET', `/api/items/${id}/form`)).status, 200);
  assert.equal((await viewer.req('GET', `/api/items/${id}/responses`)).status, 403);
  assert.equal((await viewer.req('PUT', `/api/items/${id}/form`, { settings: { accepting: false } })).status, 403);
  assert.equal((await stranger.req('GET', `/api/items/${id}/responses`)).status, 404);
  assert.equal((await stranger.req('GET', `/api/items/${id}/responses.csv`, undefined, { raw: true })).status, 404);
  // No public read-only link for forms: answering goes through /f/<token>.
  assert.equal((await owner.req('POST', `/api/items/${id}/links`, {})).status, 400);
  assert.equal((await stranger.req('GET', `/api/f/${token}`)).status, 200);
});

test('settings: closing, sign-in required, one answer per person', async () => {
  const { id, token } = await newForm();
  const anon = new Client(server);
  const answer = { nom: 'A', repas: 'Crêpes' };

  await owner.req('PUT', `/api/items/${id}/form`, { settings: { accepting: false } });
  assert.equal((await anon.req('GET', `/api/f/${token}`)).data.open, false);
  assert.equal((await anon.req('POST', `/api/f/${token}`, { answers: answer })).status, 403);

  await owner.req('PUT', `/api/items/${id}/form`, { settings: { accepting: true, closesAt: Date.now() - 1000 } });
  assert.equal((await anon.req('POST', `/api/f/${token}`, { answers: answer })).status, 403, 'closed by date');

  const s = await owner.req('PUT', `/api/items/${id}/form`, { settings: { closesAt: null, onePerUser: true } });
  assert.equal(s.data.settings.requireLogin, true, 'one answer per person implies an account');
  assert.equal((await anon.req('POST', `/api/f/${token}`, { answers: answer })).status, 401);

  const voter = await new Client(server).register('nolwenn@example.org', 'Nolwenn');
  assert.equal((await voter.req('POST', `/api/f/${token}`, { answers: answer })).status, 201);
  assert.equal((await voter.req('POST', `/api/f/${token}`, { answers: answer })).status, 409);
  assert.equal((await voter.req('GET', `/api/f/${token}`)).data.alreadyAnswered, true);
  const res = await owner.req('GET', `/api/items/${id}/responses`);
  assert.deepEqual(res.data.responses[0].user, { name: 'Nolwenn', email: 'nolwenn@example.org' });

  // Deleting responses, and a trashed form stops answering.
  assert.equal((await owner.req('DELETE', `/api/items/${id}/responses/${res.data.responses[0].id}`)).status, 200);
  assert.equal((await owner.req('GET', `/api/items/${id}/responses`)).data.responses.length, 0);
  await owner.req('POST', `/api/items/${id}/trash`);
  assert.equal((await anon.req('GET', `/api/f/${token}`)).status, 404);
});

test('copying a form keeps the questions, not the responses', async () => {
  const { id, token } = await newForm();
  await new Client(server).req('POST', `/api/f/${token}`, { answers: { nom: 'A', repas: 'Crêpes' } });
  const copy = await owner.req('POST', `/api/items/${id}/copy`);
  assert.equal(copy.status, 201);
  const form = (await owner.req('GET', `/api/items/${copy.data.item.id}/form`)).data;
  assert.equal(form.definition.title, 'Inscription au fest-noz');
  assert.equal(form.responseCount, 0);
  assert.notEqual(form.token, token);
});
