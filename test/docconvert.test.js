import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { htmlIntoYDoc, yDocToHtml } from '../server/docconvert.js';

test('html → yjs → html keeps formatting, tables, images and fonts', () => {
  const doc = new Y.Doc();
  htmlIntoYDoc(
    '<h1>Gouel</h1><p style="text-align:center">Kenavo <b>bras</b> <span style="font-family: Georgia, serif; color: #b91c1c">ruz</span></p>'
    + '<table><tbody><tr><th>Nom</th><th>Rôle</th></tr><tr><td>Anna</td><td>Présidente</td></tr></tbody></table>'
    + '<img src="/api/items/abc/images/def"><ul><li><p>un</p></li></ul>',
    doc,
  );
  const html = yDocToHtml(doc);
  assert.match(html, /<h1>Gouel<\/h1>/);
  assert.match(html, /text-align: center/);
  assert.match(html, /<strong>bras<\/strong>/);
  assert.match(html, /font-family: Georgia, serif/);
  assert.match(html, /color: #b91c1c/);
  assert.match(html, /<table[^>]*>.*<th[^>]*>.*Nom.*<td[^>]*>.*Présidente/s);
  assert.match(html, /<img src="\/api\/items\/abc\/images\/def"/);
  assert.match(html, /<li><p>un<\/p><\/li>/);
});

test('legacy html from the old editor is converted, scripts dropped', () => {
  const doc = new Y.Doc();
  htmlIntoYDoc('<div>ligne</div><font color="#ff0000">rouge</font><script>alert(1)</script><p onclick="x()">ok</p>', doc);
  const html = yDocToHtml(doc);
  assert.doesNotMatch(html, /script|onclick/);
  assert.match(html, /ligne/);
  assert.match(html, /ok/);
});
