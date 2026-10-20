// Pure helpers for the spreadsheet editor: formula reference shifting, number formats, function help.
// No DOM here, so they are unit-tested in test/sheet-tools.test.js.
import { colName, colIndex, formatNumber } from './formula.js';

// ---------- References inside formulas ----------

// Cell references outside string literals, not glued to a function name (LOG10) or a column letter run.
const REF_RE = /("(?:[^"]|"")*")|(?<![A-Za-z0-9_.$])(\$?)([A-Za-z]{1,2})(\$?)(\d+)(?![A-Za-z0-9_(])/g;

function mapRefs(formula, fn) {
  return formula.replace(REF_RE, (m, str, dc, col, dr, row) => {
    if (str) return str;
    const out = fn({ c: colIndex(col.toUpperCase()), r: Number(row) - 1, absC: !!dc, absR: !!dr });
    if (!out) return '#REF!';
    return `${out.absC ? '$' : ''}${colName(out.c)}${out.absR ? '$' : ''}${out.r + 1}`;
  });
}

// Moves the relative references of a formula, as when it is copied dc columns / dr rows away.
export function shiftFormula(raw, dc, dr) {
  if (typeof raw !== 'string' || !raw.startsWith('=')) return raw;
  return `=${mapRefs(raw.slice(1), (ref) => {
    const c = ref.absC ? ref.c : ref.c + dc;
    const r = ref.absR ? ref.r : ref.r + dr;
    return c < 0 || r < 0 ? null : { ...ref, c, r };
  })}`;
}

// Rows (axis 'r') or columns ('c') inserted (count > 0) or deleted (count < 0) at `index`:
// every reference after that point moves, absolute or not; references to deleted cells become #REF!.
export function adjustForInsert(raw, axis, index, count) {
  if (typeof raw !== 'string' || !raw.startsWith('=')) return raw;
  return `=${mapRefs(raw.slice(1), (ref) => {
    const pos = ref[axis];
    if (pos < index) return ref;
    if (count < 0 && pos < index - count) return null;
    return { ...ref, [axis]: pos + count };
  })}`;
}

// References used by a formula, for highlighting while it is typed: [{ text, c1, r1, c2, r2 }].
export function formulaRefs(raw) {
  if (typeof raw !== 'string' || !raw.startsWith('=')) return [];
  const out = [];
  const re = /("(?:[^"]|"")*")|(?<![A-Za-z0-9_.$])\$?([A-Za-z]{1,2})\$?(\d+)(?:\s*:\s*\$?([A-Za-z]{1,2})\$?(\d+))?(?![A-Za-z0-9_(])/g;
  let m;
  while ((m = re.exec(raw))) {
    if (m[1]) continue;
    const c1 = colIndex(m[2].toUpperCase());
    const r1 = Number(m[3]) - 1;
    const c2 = m[4] ? colIndex(m[4].toUpperCase()) : c1;
    const r2 = m[5] ? Number(m[5]) - 1 : r1;
    out.push({ text: m[0].toUpperCase(), c1: Math.min(c1, c2), c2: Math.max(c1, c2), r1: Math.min(r1, r2), r2: Math.max(r1, r2) });
  }
  return out;
}

// ---------- Number formats ----------

export const NUMBER_FORMATS = [
  ['', 'Automatique', '1234,5'],
  ['int', 'Nombre entier', '1 235'],
  ['n2', 'Nombre (2 décimales)', '1 234,50'],
  ['eur', 'Monétaire (€)', '1 234,50 €'],
  ['pct', 'Pourcentage', '12,5 %'],
];

export function formatValue(v, f) {
  if (typeof v !== 'number' || !f || !Number.isFinite(v)) return null;
  if (f === 'int') return v.toLocaleString('fr-FR', { maximumFractionDigits: 0 });
  if (f === 'n2') return v.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (f === 'eur') return v.toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' });
  if (f === 'pct') return v.toLocaleString('fr-FR', { style: 'percent', maximumFractionDigits: 2 });
  return formatNumber(v);
}

// ---------- Function help (French names shown, English ones still accepted) ----------

export const FUNCTIONS = [
  ['SOMME', 'nombre1; [nombre2]; …', 'Additionne des nombres ou une plage'],
  ['MOYENNE', 'nombre1; [nombre2]; …', 'Moyenne des nombres'],
  ['MIN', 'nombre1; [nombre2]; …', 'Plus petite valeur'],
  ['MAX', 'nombre1; [nombre2]; …', 'Plus grande valeur'],
  ['NB', 'valeur1; …', 'Compte les cellules contenant un nombre'],
  ['NBVAL', 'valeur1; …', 'Compte les cellules non vides'],
  ['NB.SI', 'plage; critère', 'Compte les cellules qui remplissent un critère, ex. ">10" ou "oui"'],
  ['SOMME.SI', 'plage; critère; [plage_somme]', 'Additionne les cellules qui remplissent un critère'],
  ['MOYENNE.SI', 'plage; critère; [plage_moyenne]', 'Moyenne des cellules qui remplissent un critère'],
  ['SI', 'test; valeur_si_vrai; [valeur_si_faux]', 'Une valeur ou une autre selon un test'],
  ['ET', 'test1; [test2]; …', 'VRAI si tous les tests sont vrais'],
  ['OU', 'test1; [test2]; …', 'VRAI si au moins un test est vrai'],
  ['NON', 'test', 'Inverse un test'],
  ['ARRONDI', 'nombre; [décimales]', 'Arrondit un nombre'],
  ['ARRONDI.SUP', 'nombre; [décimales]', 'Arrondit vers le haut'],
  ['ARRONDI.INF', 'nombre; [décimales]', 'Arrondit vers le bas'],
  ['ENT', 'nombre', 'Partie entière'],
  ['ABS', 'nombre', 'Valeur absolue'],
  ['RACINE', 'nombre', 'Racine carrée'],
  ['PUISSANCE', 'nombre; puissance', 'Élève à une puissance'],
  ['MOD', 'nombre; diviseur', 'Reste d’une division'],
  ['PRODUIT', 'nombre1; [nombre2]; …', 'Multiplie des nombres'],
  ['CONCATENER', 'texte1; [texte2]; …', 'Assemble des textes'],
  ['NBCAR', 'texte', 'Nombre de caractères'],
  ['MAJUSCULE', 'texte', 'Met en majuscules'],
  ['MINUSCULE', 'texte', 'Met en minuscules'],
  ['SUPPRESPACE', 'texte', 'Supprime les espaces en trop'],
  ['GAUCHE', 'texte; [nombre]', 'Premiers caractères'],
  ['DROITE', 'texte; [nombre]', 'Derniers caractères'],
  ['AUJOURDHUI', '', 'Date du jour'],
  ['MAINTENANT', '', 'Date et heure actuelles'],
];

// The function name being typed just before the caret ("=SO" → "SO"), or null.
export function typedFunctionPrefix(text, caret) {
  const before = text.slice(0, caret);
  if (!before.startsWith('=')) return null;
  const m = /(?:^=|[(;,+\-*/^&=<>:\s])([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ.]*)$/.exec(before);
  if (!m || /\d/.test(m[1])) return null;
  // Inside a string literal: no suggestions.
  if ((before.match(/"/g) || []).length % 2) return null;
  return m[1].toUpperCase();
}

// Innermost function call still open at the caret, with the index of the current argument.
export function openCall(text, caret) {
  const before = text.slice(0, caret);
  if (!before.startsWith('=')) return null;
  const stack = [];
  let inStr = false;
  for (let i = 1; i < before.length; i++) {
    const ch = before[i];
    if (ch === '"') inStr = !inStr;
    if (inStr) continue;
    if (ch === '(') {
      const name = /([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ.]*)\s*$/.exec(before.slice(0, i))?.[1]?.toUpperCase();
      stack.push({ name, arg: 0 });
    } else if (ch === ')') stack.pop();
    else if ((ch === ';' || ch === ',') && stack.length) stack[stack.length - 1].arg += 1;
  }
  const top = stack.at(-1);
  return top?.name ? top : null;
}

// True when a cell reference can be inserted at the caret (after "=", "(", an operator or a separator).
export function canPointAt(text, caret) {
  const before = text.slice(0, caret).trimEnd();
  if (!before.startsWith('=')) return false;
  if ((before.match(/"/g) || []).length % 2) return false;
  return /[=(;,+\-*/^&<>:]$/.test(before);
}
