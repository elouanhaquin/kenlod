import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  shiftFormula, adjustForInsert, formulaRefs, formatValue, typedFunctionPrefix, openCall, canPointAt,
} from '../public/js/sheet-tools.js';
import { SheetModel, display } from '../public/js/formula.js';

test('copying formulas (Ctrl+D, sort) shifts relative references only', () => {
  assert.equal(shiftFormula('=A1*2', 0, 1), '=A2*2');
  assert.equal(shiftFormula('=SOMME(A1:B1)*$C$1', 0, 1), '=SOMME(A2:B2)*$C$1');
  assert.equal(shiftFormula('=A1+$B1+B$1', 1, 0), '=B1+$B1+C$1');
  assert.equal(shiftFormula('=A1', 0, -1), '=#REF!');
  assert.equal(shiftFormula('="A1"&B1', 0, 1), '="A1"&B2', 'strings untouched');
  assert.equal(shiftFormula('=LOG10(A1)', 0, 1), '=LOG10(A2)', 'function names untouched');
  assert.equal(shiftFormula('texte', 0, 1), 'texte');
});

test('inserting and deleting rows or columns updates references', () => {
  assert.equal(adjustForInsert('=SOMME(A1:A10)', 'r', 4, 2), '=SOMME(A1:A12)');
  assert.equal(adjustForInsert('=$B$7*2', 'r', 4, 1), '=$B$8*2', 'absolute refs move too');
  assert.equal(adjustForInsert('=A3', 'r', 4, 1), '=A3');
  assert.equal(adjustForInsert('=C1+A1', 'c', 1, -1), '=B1+A1');
  assert.equal(adjustForInsert('=B1', 'c', 1, -1), '=#REF!');
});

test('formula helpers', () => {
  assert.deepEqual(formulaRefs('=SOMME(A1:B3)+c5').map((r) => r.text), ['A1:B3', 'C5']);
  assert.deepEqual(formulaRefs('=A1:B3')[0], { text: 'A1:B3', c1: 0, c2: 1, r1: 0, r2: 2 });
  assert.equal(typedFunctionPrefix('=so', 3), 'SO');
  assert.equal(typedFunctionPrefix('=A1+moy', 7), 'MOY');
  assert.equal(typedFunctionPrefix('=A1', 3), null);
  assert.equal(typedFunctionPrefix('="so', 4), null);
  assert.deepEqual(openCall('=SI(A1>2;', 9), { name: 'SI', arg: 1 });
  assert.equal(openCall('=SOMME(A1)', 10), null);
  assert.equal(canPointAt('=SOMME(', 7), true);
  assert.equal(canPointAt('=A1+', 4), true);
  assert.equal(canPointAt('=A1', 3), false);
  assert.equal(canPointAt('bonjour', 7), false);
});

test('number formats and forced text', () => {
  assert.equal(formatValue(1234.5, 'eur').replace(/\s/g, ' '), '1 234,50 €');
  assert.equal(formatValue(0.125, 'pct').replace(/\s/g, ' '), '12,5 %');
  assert.equal(formatValue(1234.567, 'n2').replace(/\s/g, ' '), '1 234,57');
  assert.equal(formatValue('texte', 'eur'), null);
  const m = new SheetModel({ cells: { A1: { v: "'=1+1" }, A2: { v: "'007" } } });
  assert.equal(display(m.value('A1')), '=1+1');
  assert.equal(display(m.value('A2')), '007');
});
