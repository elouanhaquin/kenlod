// Spreadsheet model + formula engine. Accepts French and English function names, ";" or "," separators.

export const colName = (i) => {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};
export const colIndex = (s) => [...s].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
export const refName = (c, r) => `${colName(c)}${r + 1}`;
export function parseRef(ref) {
  const m = /^\$?([A-Z]{1,2})\$?(\d+)$/.exec(ref.toUpperCase());
  return m ? { c: colIndex(m[1]), r: Number(m[2]) - 1 } : null;
}

export class FErr {
  constructor(code) { this.code = code; }
  toString() { return this.code; }
}
const E = {
  div0: () => new FErr('#DIV/0!'), value: () => new FErr('#VALEUR!'), ref: () => new FErr('#REF!'),
  name: () => new FErr('#NOM?'), cycle: () => new FErr('#CYCLE!'), parse: () => new FErr('#ERREUR!'), na: () => new FErr('#N/A'),
};

// ---------- Tokenizer & parser ----------

function tokenize(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const rest = src.slice(i);
    let m;
    if ((m = /^\s+/.exec(rest))) { i += m[0].length; continue; }
    if ((m = /^(\d+(\.\d+)?|\.\d+)([eE][+-]?\d+)?/.exec(rest))) out.push({ t: 'num', v: Number(m[0]) });
    else if ((m = /^"((?:[^"]|"")*)"/.exec(rest))) out.push({ t: 'str', v: m[1].replace(/""/g, '"') });
    else if ((m = /^\$?[A-Za-z]{1,2}\$?\d+(?![A-Za-z0-9_(])/.exec(rest))) out.push({ t: 'ref', v: m[0].replace(/\$/g, '').toUpperCase() });
    else if ((m = /^[A-Za-zÀ-ÿ_][A-Za-zÀ-ÿ0-9_.]*/.exec(rest))) out.push({ t: 'id', v: m[0].toUpperCase() });
    else if ((m = /^(<=|>=|<>|[-+*/^&=<>%(),;:])/.exec(rest))) out.push({ t: m[0] === ';' ? ',' : m[0] });
    else throw E.parse();
    i += m[0].length;
  }
  return out;
}

export function parse(src) {
  const tokens = tokenize(src);
  let p = 0;
  const peek = () => tokens[p]?.t;
  const next = () => tokens[p++];
  const expect = (t) => { if (peek() !== t) throw E.parse(); return next(); };

  const binary = (sub, ops) => () => {
    let left = sub();
    while (ops.includes(peek())) left = { op: next().t, a: left, b: sub() };
    return left;
  };
  function primary() {
    const tok = next();
    if (!tok) throw E.parse();
    if (tok.t === 'num') return { num: tok.v };
    if (tok.t === 'str') return { str: tok.v };
    if (tok.t === 'ref') {
      if (peek() === ':') {
        next();
        const end = expect('ref');
        return { range: [tok.v, end.v] };
      }
      return { ref: tok.v };
    }
    if (tok.t === 'id') {
      if (peek() === '(') {
        next();
        const args = [];
        if (peek() !== ')') {
          do { args.push(peek() === ',' || peek() === ')' ? { empty: true } : expr()); } while (peek() === ',' && next());
        }
        expect(')');
        return { fn: tok.v, args };
      }
      if (['TRUE', 'VRAI'].includes(tok.v)) return { bool: true };
      if (['FALSE', 'FAUX'].includes(tok.v)) return { bool: false };
      return { name: tok.v };
    }
    if (tok.t === '(') {
      const e = expr();
      expect(')');
      return e;
    }
    if (tok.t === '-' || tok.t === '+') return { op: tok.t === '-' ? 'neg' : 'pos', a: postfix() };
    throw E.parse();
  }
  function postfix() {
    let e = primary();
    while (peek() === '%') { next(); e = { op: '%', a: e }; }
    return e;
  }
  const power = binary(postfix, ['^']);
  const term = binary(power, ['*', '/']);
  const additive = binary(term, ['+', '-']);
  const concat = binary(additive, ['&']);
  const comparison = binary(concat, ['=', '<>', '<', '>', '<=', '>=']);
  const expr = comparison;
  const ast = expr();
  if (p < tokens.length) throw E.parse();
  return ast;
}

// ---------- Values ----------

export function literal(raw) {
  if (raw === undefined || raw === null || raw === '') return '';
  // A leading apostrophe forces text, as in Excel ('=1+1, '007): it is not displayed.
  if (typeof raw === 'string' && raw.startsWith("'")) return raw.slice(1);
  const s = String(raw).trim();
  if (/^-?\d+([.,]\d+)?$/.test(s)) return Number(s.replace(',', '.'));
  if (/^-?\d+([.,]\d+)?\s*%$/.test(s)) return Number(s.replace('%', '').replace(',', '.')) / 100;
  return String(raw);
}

function toNum(v) {
  if (v instanceof FErr) throw v;
  if (v === '' || v === null || v === undefined) return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  const n = literal(v);
  if (typeof n === 'number') return n;
  throw E.value();
}
const toStr = (v) => {
  if (v instanceof FErr) throw v;
  if (typeof v === 'boolean') return v ? 'VRAI' : 'FAUX';
  if (typeof v === 'number') return formatNumber(v);
  return String(v ?? '');
};
const toBool = (v) => {
  if (v instanceof FErr) throw v;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    if (/^(vrai|true)$/i.test(v)) return true;
    if (/^(faux|false)$/i.test(v) || v === '') return false;
  }
  return toNum(v) !== 0;
};

export function formatNumber(n) {
  if (!Number.isFinite(n)) return '#NUM!';
  const rounded = Number(n.toPrecision(12));
  return rounded.toLocaleString('fr-FR', { maximumFractionDigits: 10, useGrouping: Math.abs(rounded) >= 10000 });
}

export function display(v) {
  if (v instanceof FErr) return v.code;
  if (typeof v === 'number') return formatNumber(v);
  if (typeof v === 'boolean') return v ? 'VRAI' : 'FAUX';
  return v ?? '';
}

function flatten(values) {
  const out = [];
  for (const v of values) Array.isArray(v) ? out.push(...flatten(v)) : out.push(v);
  return out;
}
// Numbers from ranges (text ignored), direct args coerced.
function numbers(args) {
  const out = [];
  for (const a of args) {
    if (Array.isArray(a)) {
      for (const v of flatten(a)) {
        if (v instanceof FErr) throw v;
        if (typeof v === 'number') out.push(v);
      }
    } else out.push(toNum(a));
  }
  return out;
}

function matcher(criterion) {
  if (typeof criterion === 'number') return (v) => v === criterion || literal(v) === criterion;
  const m = /^(<=|>=|<>|<|>|=)?(.*)$/.exec(String(criterion));
  const op = m[1] || '=';
  const target = literal(m[2]);
  return (v) => {
    const val = typeof v === 'string' ? literal(v) : v;
    if (typeof target === 'number' && typeof val === 'number') {
      return { '=': val === target, '<>': val !== target, '<': val < target, '>': val > target, '<=': val <= target, '>=': val >= target }[op];
    }
    const a = String(val ?? '').toLowerCase();
    const b = String(target).toLowerCase();
    if (op === '=') return new RegExp(`^${b.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`).test(a);
    if (op === '<>') return a !== b;
    return false;
  };
}

const FN = {
  SUM: (a) => numbers(a).reduce((s, n) => s + n, 0),
  AVERAGE: (a) => { const n = numbers(a); if (!n.length) throw E.div0(); return n.reduce((s, x) => s + x, 0) / n.length; },
  MIN: (a) => { const n = numbers(a); return n.length ? Math.min(...n) : 0; },
  MAX: (a) => { const n = numbers(a); return n.length ? Math.max(...n) : 0; },
  COUNT: (a) => flatten(a).filter((v) => typeof v === 'number').length,
  COUNTA: (a) => flatten(a).filter((v) => v !== '' && v !== null && v !== undefined).length,
  PRODUCT: (a) => numbers(a).reduce((s, n) => s * n, 1),
  ROUND: ([x, d = 0]) => { const f = 10 ** toNum(d); return Math.round(toNum(x) * f) / f; },
  ROUNDUP: ([x, d = 0]) => { const f = 10 ** toNum(d); return Math.ceil(toNum(x) * f) / f; },
  ROUNDDOWN: ([x, d = 0]) => { const f = 10 ** toNum(d); return Math.floor(toNum(x) * f) / f; },
  INT: ([x]) => Math.floor(toNum(x)),
  ABS: ([x]) => Math.abs(toNum(x)),
  SQRT: ([x]) => { const n = toNum(x); if (n < 0) throw new FErr('#NUM!'); return Math.sqrt(n); },
  POWER: ([x, y]) => toNum(x) ** toNum(y),
  MOD: ([x, y]) => { const d = toNum(y); if (!d) throw E.div0(); const n = toNum(x); return n - d * Math.floor(n / d); },
  AND: (a) => flatten(a).every(toBool),
  OR: (a) => flatten(a).some(toBool),
  NOT: ([x]) => !toBool(x),
  CONCAT: (a) => flatten(a).map(toStr).join(''),
  LEN: ([x]) => toStr(x).length,
  UPPER: ([x]) => toStr(x).toUpperCase(),
  LOWER: ([x]) => toStr(x).toLowerCase(),
  TRIM: ([x]) => toStr(x).trim().replace(/\s+/g, ' '),
  LEFT: ([x, n = 1]) => toStr(x).slice(0, toNum(n)),
  RIGHT: ([x, n = 1]) => { const s = toStr(x); return s.slice(Math.max(0, s.length - toNum(n))); },
  TODAY: () => new Date().toLocaleDateString('fr-FR'),
  NOW: () => new Date().toLocaleString('fr-FR'),
  COUNTIF: ([range, crit]) => flatten([range]).filter(matcher(crit)).length,
  SUMIF: ([range, crit, sumRange]) => {
    const r = flatten([range]);
    const s = sumRange ? flatten([sumRange]) : r;
    const ok = matcher(crit);
    return r.reduce((acc, v, i) => (ok(v) && typeof literal(s[i]) === 'number' ? acc + literal(s[i]) : acc), 0);
  },
  AVERAGEIF: ([range, crit, avgRange]) => {
    const r = flatten([range]);
    const s = avgRange ? flatten([avgRange]) : r;
    const ok = matcher(crit);
    const vals = r.map((v, i) => (ok(v) ? literal(s[i]) : null)).filter((v) => typeof v === 'number');
    if (!vals.length) throw E.div0();
    return vals.reduce((a, b) => a + b, 0) / vals.length;
  },
};
const ALIASES = {
  SOMME: 'SUM', MOYENNE: 'AVERAGE', NB: 'COUNT', NBVAL: 'COUNTA', PRODUIT: 'PRODUCT', ARRONDI: 'ROUND',
  'ARRONDI.SUP': 'ROUNDUP', 'ARRONDI.INF': 'ROUNDDOWN', ENT: 'INT', RACINE: 'SQRT', PUISSANCE: 'POWER',
  ET: 'AND', OU: 'OR', NON: 'NOT', CONCATENER: 'CONCAT', CONCATENATE: 'CONCAT', NBCAR: 'LEN', MAJUSCULE: 'UPPER',
  MINUSCULE: 'LOWER', SUPPRESPACE: 'TRIM', GAUCHE: 'LEFT', DROITE: 'RIGHT', AUJOURDHUI: 'TODAY', MAINTENANT: 'NOW',
  'NB.SI': 'COUNTIF', 'SOMME.SI': 'SUMIF', 'MOYENNE.SI': 'AVERAGEIF', SI: 'IF',
};
export const FUNCTION_NAMES = [...Object.keys(ALIASES), ...Object.keys(FN), 'IF'];

// ---------- Model ----------

export class SheetModel {
  constructor(data) {
    this.data = data;
    this.cache = new Map();
    this.asts = new Map();
    this.stack = new Set();
  }

  raw(key) { return this.data.cells[key]?.v ?? ''; }

  invalidate() { this.cache.clear(); }

  value(key) {
    if (this.cache.has(key)) return this.cache.get(key);
    if (this.stack.has(key)) return E.cycle();
    const raw = this.raw(key);
    let v;
    if (typeof raw === 'string' && raw.startsWith('=') && raw.length > 1) {
      this.stack.add(key);
      try {
        let ast = this.asts.get(raw);
        if (!ast) { ast = parse(raw.slice(1)); this.asts.set(raw, ast); }
        v = this.eval(ast);
        if (Array.isArray(v)) v = flatten(v)[0] ?? '';
        if (typeof v === 'number' && !Number.isFinite(v)) v = new FErr('#NUM!');
      } catch (err) {
        v = err instanceof FErr ? err : E.parse();
      } finally {
        this.stack.delete(key);
      }
    } else v = literal(raw);
    this.cache.set(key, v);
    return v;
  }

  range(a, b) {
    const s = parseRef(a);
    const e = parseRef(b);
    if (!s || !e) throw E.ref();
    const out = [];
    for (let r = Math.min(s.r, e.r); r <= Math.max(s.r, e.r); r++) {
      for (let c = Math.min(s.c, e.c); c <= Math.max(s.c, e.c); c++) {
        const v = this.value(refName(c, r));
        out.push(v);
      }
    }
    return out;
  }

  eval(n) {
    if ('num' in n) return n.num;
    if ('str' in n) return n.str;
    if ('bool' in n) return n.bool;
    if (n.empty) return '';
    if (n.ref) {
      const v = this.value(n.ref);
      if (v instanceof FErr) throw v;
      return v;
    }
    if (n.range) return this.range(...n.range);
    if (n.name) throw E.name();
    if (n.fn) {
      const name = ALIASES[n.fn] || n.fn;
      if (name === 'IF') {
        const [cond, a, b] = n.args;
        if (!cond) throw E.value();
        return toBool(this.eval(cond)) ? (a ? this.eval(a) : true) : (b ? this.eval(b) : false);
      }
      const fn = FN[name];
      if (!fn) throw E.name();
      return fn(n.args.map((arg) => this.eval(arg)));
    }
    switch (n.op) {
      case 'neg': return -toNum(this.eval(n.a));
      case 'pos': return toNum(this.eval(n.a));
      case '%': return toNum(this.eval(n.a)) / 100;
      case '+': return toNum(this.eval(n.a)) + toNum(this.eval(n.b));
      case '-': return toNum(this.eval(n.a)) - toNum(this.eval(n.b));
      case '*': return toNum(this.eval(n.a)) * toNum(this.eval(n.b));
      case '/': { const d = toNum(this.eval(n.b)); if (d === 0) throw E.div0(); return toNum(this.eval(n.a)) / d; }
      case '^': return toNum(this.eval(n.a)) ** toNum(this.eval(n.b));
      case '&': return toStr(this.eval(n.a)) + toStr(this.eval(n.b));
      default: {
        let a = this.eval(n.a);
        let b = this.eval(n.b);
        if (Array.isArray(a) || Array.isArray(b)) throw E.value();
        if (typeof a === 'string' && typeof b === 'string') { a = a.toLowerCase(); b = b.toLowerCase(); } else if (typeof a !== typeof b) {
          if (typeof a === 'number' || typeof b === 'number') { try { a = toNum(a); b = toNum(b); } catch { a = String(a); b = String(b); } }
        }
        return { '=': a === b, '<>': a !== b, '<': a < b, '>': a > b, '<=': a <= b, '>=': a >= b }[n.op];
      }
    }
  }
}
