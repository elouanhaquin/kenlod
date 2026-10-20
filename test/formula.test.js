import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SheetModel, display } from '../public/js/formula.js';

const sheet = (cells) => new SheetModel({ cells: Object.fromEntries(Object.entries(cells).map(([k, v]) => [k, { v }])) });

test('arithmetic, references and ranges', () => {
  const s = sheet({ A1: '10', A2: '2,5', A3: '=A1*A2', A4: '=SOMME(A1:A3)', A5: '=MOYENNE(A1;A2)', B1: '=-2^2', B2: '=(1+2)*3%' });
  assert.equal(s.value('A3'), 25);
  assert.equal(s.value('A4'), 37.5);
  assert.equal(s.value('A5'), 6.25);
  assert.equal(s.value('B1'), 4);
  assert.equal(display(s.value('B2')), '0,09');
});

test('functions, conditions and text', () => {
  const s = sheet({
    A1: 'pomme', A2: 'poire', A3: 'pomme', B1: '3', B2: '4', B3: '5',
    C1: '=NB.SI(A1:A3;"pomme")', C2: '=SOMME.SI(A1:A3;"pomme";B1:B3)', C3: '=SI(B1>2;"oui";"non")',
    C4: '="Total : "&SOMME(B1:B3)', C5: '=NB.SI(B1:B3;">3")', C6: '=ARRONDI(2/3;2)', C7: '=MAJUSCULE(A1)',
  });
  assert.equal(s.value('C1'), 2);
  assert.equal(s.value('C2'), 8);
  assert.equal(s.value('C3'), 'oui');
  assert.equal(s.value('C4'), 'Total : 12');
  assert.equal(s.value('C5'), 2);
  assert.equal(s.value('C6'), 0.67);
  assert.equal(s.value('C7'), 'POMME');
});

test('errors', () => {
  const s = sheet({ A1: '=1/0', A2: '=A3', A3: '=A2', A4: '=FOO(1)', A5: '=1+', A6: '="a"*2', A7: '=A1+1' });
  assert.equal(display(s.value('A1')), '#DIV/0!');
  assert.equal(display(s.value('A2')), '#CYCLE!');
  assert.equal(display(s.value('A4')), '#NOM?');
  assert.equal(display(s.value('A5')), '#ERREUR!');
  assert.equal(display(s.value('A6')), '#VALEUR!');
  assert.equal(display(s.value('A7')), '#DIV/0!');
});
