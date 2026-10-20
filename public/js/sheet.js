import { h, clear, icon, toast, showMenu } from './ui.js';
import { setCleanup } from './state.js';
import { loadEditable, editorTop, connectRoom } from './editor-common.js';
import { SheetModel, FErr, colName, colIndex, refName, display } from './formula.js';
import {
  shiftFormula, adjustForInsert, formulaRefs, formatValue, NUMBER_FORMATS, FUNCTIONS,
  typedFunctionPrefix, openCall, canPointAt,
} from './sheet-tools.js';

const MAX_ROWS = 2000;
const MAX_COLS = 52;
const DEFAULT_WIDTH = 104;
const REF_COLORS = ['#1f5fbf', '#c2410c', '#7c3aed', '#157f3b', '#b91c1c', '#0e7490'];

const keyPos = (key) => {
  const m = /^([A-Z]+)(\d+)$/.exec(key);
  return { c: colIndex(m[1]), r: Number(m[2]) - 1 };
};

function parseSheet(content) {
  try {
    const d = JSON.parse(content || '{}');
    return { rows: d.rows || 100, cols: d.cols || 26, freeze: d.freeze || 0, cells: d.cells || {}, widths: d.widths || {} };
  } catch {
    return { rows: 100, cols: 26, freeze: 0, cells: {}, widths: {} };
  }
}

// Read-only table, used by public links.
export function renderSheetTable(content) {
  const data = parseSheet(content);
  const model = new SheetModel(data);
  let maxR = 0;
  let maxC = 0;
  for (const key of Object.keys(data.cells)) {
    const { c, r } = keyPos(key);
    maxR = Math.max(maxR, r + 1);
    maxC = Math.max(maxC, c + 1);
  }
  maxR = Math.max(maxR, 10);
  maxC = Math.max(maxC, 6);
  const table = h('table', { class: `sheet${data.freeze ? ' freeze' : ''}` },
    h('thead', {}, h('tr', {}, h('th', { class: 'corner' }), Array.from({ length: maxC }, (_, c) =>
      h('th', { class: 'colh', style: { width: `${data.widths[colName(c)] || DEFAULT_WIDTH}px` } }, colName(c))))),
    h('tbody', {}, Array.from({ length: maxR }, (_, r) => h('tr', {}, h('th', { class: 'rowh' }, r + 1),
      Array.from({ length: maxC }, (_, c) => {
        const td = h('td');
        paintCell(td, model, refName(c, r));
        return td;
      })))));
  return h('div', { class: 'sheet-wrap', style: 'max-height:78vh' }, table);
}

function paintCell(td, model, key) {
  const cell = model.data.cells[key];
  const v = model.value(key);
  td.textContent = formatValue(v, cell?.f) ?? display(v);
  td.className = [
    typeof v === 'number' ? 'num' : '', v instanceof FErr ? 'err' : '',
    cell?.a ? `a-${cell.a}` : '', cell?.b ? 'b' : '', cell?.i ? 'i' : '',
  ].filter(Boolean).join(' ');
  td.style.background = cell?.bg || '';
  td.style.color = cell?.fg || (cell?.bg ? '#1d2433' : '');
}

const fmtStat = (n) => n.toLocaleString('fr-FR', { maximumFractionDigits: 2 });

export async function renderSheet(app, id) {
  const loaded = await loadEditable(app, id);
  if (!loaded) return;
  const item = loaded.item;
  let data = parseSheet(loaded.content);
  let model = new SheetModel(data);

  const usedBounds = () => {
    let maxR = 0;
    let maxC = 0;
    for (const key of Object.keys(data.cells)) {
      if (data.cells[key].v === undefined) continue;
      const { c, r } = keyPos(key);
      maxR = Math.max(maxR, r + 1);
      maxC = Math.max(maxC, c + 1);
    }
    return { maxR, maxC };
  };

  const exportCsv = () => {
    const { maxR, maxC } = usedBounds();
    const lines = [];
    for (let r = 0; r < maxR; r++) {
      const row = [];
      for (let c = 0; c < maxC; c++) {
        const s = String(display(model.value(refName(c, r))));
        row.push(/[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
      }
      lines.push(row.join(';'));
    }
    const a = h('a', { href: URL.createObjectURL(new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' })), download: `${item.name}.csv` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  const { bar, status, presence, canEdit } = editorTop(item, {
    extra: [h('button', { class: 'icon-btn', title: 'Exporter en CSV (Excel, LibreOffice)', onclick: exportCsv }, icon('download'))],
  });
  const loadingWrap = h('div', { class: 'sheet-wrap' }, h('p', { class: 'muted', style: 'padding:20px' }, 'Connexion…'));
  clear(app, h('div', { class: 'editor-shell' }, bar, loadingWrap));

  // ---------- Shared state (Yjs) ----------
  let room;
  try {
    room = await connectRoom(item, { statusEl: status, presenceEl: presence });
  } catch (err) {
    clear(loadingWrap, h('p', { class: 'err', style: 'padding:20px' }, err.message));
    return;
  }
  const { C, ydoc, provider } = room;
  const ycells = ydoc.getMap('cells');
  const ymeta = ydoc.getMap('meta');
  const ywidths = ydoc.getMap('widths');
  // Undo only touches this person's own changes, not other people's.
  const undoManager = new C.Y.UndoManager([ycells, ymeta, ywidths]);
  let cleaned = false;
  setCleanup(() => { cleaned = true; teardown(); });
  let teardown = () => room.destroy();
  await room.synced;
  if (cleaned) return;
  const pull = () => {
    data = {
      rows: ymeta.get('rows') || 100, cols: ymeta.get('cols') || 26, freeze: ymeta.get('freeze') || 0,
      cells: ycells.toJSON(), widths: ywidths.toJSON(),
    };
    model = new SheetModel(data);
  };
  pull();

  // ---------- Grid ----------
  const wrap = h('div', { class: 'sheet-wrap', tabindex: '0' });
  const refBox = h('div', { class: 'ref' }, 'A1');
  const fx = h('input', { 'aria-label': 'Contenu de la cellule', readOnly: !canEdit, spellcheck: false });
  const statusBar = h('div', { class: 'sheet-status', 'aria-live': 'polite' });
  let tds = [];
  let cols = [];
  let colHeads = [];
  let rowHeads = [];
  let table;
  // Overlays drawn above the grid.
  const selBox = h('div', { class: 'sel-box' });
  const refsLayer = h('div', { class: 'refs-layer' });
  const fnBox = h('div', { class: 'fn-box', role: 'listbox' });
  let peersLayer = h('div');

  const tableWidth = () => 46 + cols.reduce((s, col) => s + parseInt(col.style.width, 10), 0);

  function build() {
    tds = [];
    cols = [];
    const colgroup = h('colgroup', {}, h('col', { style: { width: '46px' } }));
    colHeads = [];
    const headRow = h('tr', {}, h('th', { class: 'corner', title: 'Tout sélectionner', onmousedown: () => selectAll() }));
    for (let c = 0; c < data.cols; c++) {
      const name = colName(c);
      const col = h('col', { style: { width: `${data.widths[name] || DEFAULT_WIDTH}px` } });
      cols.push(col);
      colgroup.append(col);
      const th = h('th', { class: 'colh' }, name, canEdit ? h('span', {
        class: 'rz', title: 'Glisser pour redimensionner, double-clic pour ajuster', onmousedown: (e) => startResize(e, c), ondblclick: () => autoFit(c),
      }) : null);
      th.addEventListener('mousedown', (e) => { if (e.button === 0 && !e.target.classList.contains('rz')) selectWhole('col', c, e.shiftKey); });
      th.dataset.c = c;
      colHeads.push(th);
      headRow.append(th);
    }
    rowHeads = [];
    const tbody = h('tbody');
    for (let r = 0; r < data.rows; r++) {
      const th = h('th', { class: 'rowh', onmousedown: (e) => { if (e.button === 0) selectWhole('row', r, e.shiftKey); } }, r + 1);
      th.dataset.r = r;
      rowHeads.push(th);
      const tr = h('tr', {}, th);
      const row = [];
      for (let c = 0; c < data.cols; c++) {
        const td = h('td');
        td.dataset.c = c;
        td.dataset.r = r;
        row.push(td);
        tr.append(td);
      }
      tds.push(row);
      tbody.append(tr);
    }
    table = h('table', { class: `sheet${data.freeze ? ' freeze' : ''}`, style: { width: `${tableWidth()}px` } },
      colgroup, h('thead', {}, headRow), tbody);
    const foot = canEdit && data.rows < MAX_ROWS
      ? h('div', { class: 'sheet-foot' }, h('button', { class: 'btn small', onclick: () => grow(100, 0) }, icon('rowPlus'), 'Ajouter 100 lignes'))
      : null;
    peersLayer = h('div', { class: 'peers' });
    clear(wrap, table, foot, peersLayer, selBox, refsLayer);
    painted = new Set();
    paintAll();
    showSelection();
    renderPeers();
  }

  // Position of a block of cells inside the grid.
  function rectOf({ c1, c2, r1, r2 }) {
    const a = tds[r1]?.[c1];
    const b = tds[Math.min(r2, data.rows - 1)]?.[Math.min(c2, data.cols - 1)];
    if (!a || !b) return null;
    return { left: a.offsetLeft, top: a.offsetTop, width: b.offsetLeft + b.offsetWidth - a.offsetLeft, height: b.offsetTop + b.offsetHeight - a.offsetTop };
  }
  const place = (el, rect) => {
    if (!rect) { el.hidden = true; return; }
    el.hidden = false;
    Object.assign(el.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
  };

  // Other people's selections, drawn over the grid in their colour.
  function renderPeers() {
    const boxes = [];
    for (const [clientId, s] of provider.awareness.getStates()) {
      if (clientId === ydoc.clientID || !s.user || !s.sel) continue;
      const rect = rectOf(s.sel);
      if (!rect) continue;
      const box = h('div', { class: 'peer', style: { borderColor: s.user.color, background: `${s.user.color}14` } }, h('span', { style: { background: s.user.color } }, s.user.name));
      place(box, rect);
      boxes.push(box);
    }
    clear(peersLayer, boxes);
  }
  provider.awareness.on('change', renderPeers);
  const publishSelection = () => provider.awareness.setLocalStateField('sel', bounds());

  let painted = new Set();
  function paintAll() {
    model.invalidate();
    const keys = new Set([...painted, ...Object.keys(data.cells)]);
    painted = new Set();
    for (const key of keys) {
      const { c, r } = keyPos(key);
      const td = tds[r]?.[c];
      if (!td) continue;
      paintCell(td, model, key);
      if (td.textContent || data.cells[key]) painted.add(key);
    }
    paintFound();
  }

  // ---------- Selection ----------
  let sel = { c: 0, r: 0 };
  let anchor = { c: 0, r: 0 };
  let marked = [];
  const bounds = () => ({
    c1: Math.min(sel.c, anchor.c), c2: Math.max(sel.c, anchor.c), r1: Math.min(sel.r, anchor.r), r2: Math.max(sel.r, anchor.r),
  });

  function showSelection() {
    for (const el of marked) el.classList.remove('active', 'hl');
    marked = [];
    const b = bounds();
    const multi = b.c1 !== b.c2 || b.r1 !== b.r2;
    for (let r = b.r1; r <= b.r2; r++) if (rowHeads[r]) { rowHeads[r].classList.add('hl'); marked.push(rowHeads[r]); }
    for (let c = b.c1; c <= b.c2; c++) if (colHeads[c]) { colHeads[c].classList.add('hl'); marked.push(colHeads[c]); }
    const active = tds[sel.r]?.[sel.c];
    if (active) { active.classList.add('active'); marked.push(active); }
    const rect = rectOf(b);
    place(selBox, rect);
    selBox.classList.toggle('multi', multi);
    refBox.textContent = multi ? `${refName(b.c1, b.r1)}:${refName(b.c2, b.r2)}` : refName(sel.c, sel.r);
    if (document.activeElement !== fx) fx.value = model.raw(refName(sel.c, sel.r));
    renderStats(b, multi);
    publishSelection();
  }

  // Sum / average / count of the selection, like the status bar of other spreadsheets.
  function renderStats(b, multi) {
    if (!multi) { clear(statusBar); return; }
    let count = 0;
    const nums = [];
    const cells = (b.r2 - b.r1 + 1) * (b.c2 - b.c1 + 1);
    if (cells > 20000) { clear(statusBar, h('span', {}, `${cells.toLocaleString('fr-FR')} cellules`)); return; }
    for (let r = b.r1; r <= b.r2; r++) {
      for (let c = b.c1; c <= b.c2; c++) {
        const v = model.value(refName(c, r));
        if (v === '' || v === null || v === undefined) continue;
        count++;
        if (typeof v === 'number') nums.push(v);
      }
    }
    const parts = [];
    if (nums.length) {
      const sum = nums.reduce((a, x) => a + x, 0);
      parts.push(['Somme', fmtStat(sum)], ['Moyenne', fmtStat(sum / nums.length)], ['Min', fmtStat(Math.min(...nums))], ['Max', fmtStat(Math.max(...nums))]);
    }
    parts.push(['Nombre', String(count)]);
    clear(statusBar, parts.map(([l, v]) => h('span', {}, `${l} : `, h('b', {}, v))));
  }

  function moveTo(c, r, extend = false) {
    sel = { c: Math.max(0, Math.min(data.cols - 1, c)), r: Math.max(0, Math.min(data.rows - 1, r)) };
    if (!extend) anchor = { ...sel };
    showSelection();
    tds[sel.r][sel.c].scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  function selectWhole(kind, i, extend) {
    commitEdit();
    if (kind === 'col') {
      if (!extend) anchor = { c: i, r: 0 };
      sel = { c: i, r: data.rows - 1 };
    } else {
      if (!extend) anchor = { c: 0, r: i };
      sel = { c: data.cols - 1, r: i };
    }
    showSelection();
    wrap.focus({ preventScroll: true });
  }
  function selectAll() {
    commitEdit();
    anchor = { c: 0, r: 0 };
    sel = { c: data.cols - 1, r: data.rows - 1 };
    showSelection();
    wrap.focus({ preventScroll: true });
  }

  // Ctrl+arrow: jump to the edge of the current block of data, or to the next filled cell.
  function jump(dc, dr) {
    const filled = (c, r) => model.raw(refName(c, r)) !== '';
    let { c, r } = sel;
    const inside = (x, y) => x >= 0 && y >= 0 && x < data.cols && y < data.rows;
    if (!inside(c + dc, r + dr)) return { c, r };
    if (filled(c, r) && filled(c + dc, r + dr)) {
      while (inside(c + dc, r + dr) && filled(c + dc, r + dr)) { c += dc; r += dr; }
    } else {
      c += dc; r += dr;
      while (inside(c + dc, r + dr) && !filled(c, r)) { c += dc; r += dr; }
    }
    return { c, r };
  }

  // Mouse: select, drag a range, or point at cells while typing a formula.
  let dragging = false;
  let pointing = null; // { start, end, anchor: {c, r} } in the editor's text
  wrap.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    const td = e.target.closest('td');
    if (!td || e.target === editor) return;
    const c = Number(td.dataset.c);
    const r = Number(td.dataset.r);
    if (editing && (pointing || canPointAt(editor.value, editor.selectionStart))) {
      e.preventDefault();
      pointAt(c, r, e.shiftKey);
      return;
    }
    commitEdit();
    e.preventDefault();
    wrap.focus({ preventScroll: true });
    moveTo(c, r, e.shiftKey);
    dragging = true;
  });
  wrap.addEventListener('mouseover', (e) => {
    const td = e.target.closest('td');
    if (!td) return;
    const c = Number(td.dataset.c);
    const r = Number(td.dataset.r);
    if (pointing?.dragging) return pointAt(c, r, true);
    if (dragging) { sel = { c, r }; showSelection(); }
  });
  const stopDrag = () => {
    dragging = false;
    if (pointing) pointing.dragging = false;
  };
  document.addEventListener('mouseup', stopDrag);
  wrap.addEventListener('dblclick', (e) => { if (e.target.closest('td')) startEdit(); });

  // ---------- Editing ----------
  const editor = h('input', { class: 'cell-editor', spellcheck: false, autocomplete: 'off' });
  let editing = null; // { c, r, original }

  function startEdit(initial) {
    if (!canEdit) return;
    const td = tds[sel.r][sel.c];
    const key = refName(sel.c, sel.r);
    editing = { c: sel.c, r: sel.r, original: model.raw(key) };
    editor.value = initial ?? editing.original;
    Object.assign(editor.style, {
      left: `${td.offsetLeft}px`, top: `${td.offsetTop}px`, minWidth: `${td.offsetWidth}px`, height: `${td.offsetHeight}px`, width: `${td.offsetWidth}px`,
    });
    wrap.append(editor, fnBox);
    editor.focus();
    if (initial === undefined) editor.setSelectionRange(editor.value.length, editor.value.length);
    fx.value = editor.value;
    pointing = null;
    onEditorChange();
  }

  function stopEditUi() {
    editing = null;
    pointing = null;
    editor.remove();
    fnBox.remove();
    clear(refsLayer);
  }

  function commitEdit(value = editor.value) {
    if (!editing) return;
    const { c, r, original } = editing;
    stopEditUi();
    if (value !== original) setCells([[refName(c, r), { ...(data.cells[refName(c, r)] || {}), v: value }]]);
    wrap.focus({ preventScroll: true });
  }

  function cancelEdit() {
    if (!editing) return;
    stopEditUi();
    fx.value = model.raw(refName(sel.c, sel.r));
    wrap.focus({ preventScroll: true });
  }

  // Values already in the column, for completion while typing text.
  function completionFor(text) {
    if (!text || text.startsWith('=') || /^[-\d.,\s%€]+$/.test(text)) return null;
    const low = text.toLowerCase();
    const found = new Map();
    for (const [key, cell] of Object.entries(data.cells)) {
      const { c, r } = keyPos(key);
      if (c !== editing.c || r === editing.r || typeof cell.v !== 'string' || cell.v.startsWith('=')) continue;
      if (cell.v.length > text.length && cell.v.toLowerCase().startsWith(low)) found.set(cell.v.toLowerCase(), cell.v);
    }
    return found.size === 1 ? [...found.values()][0] : null;
  }

  // Function list and argument hint while typing a formula, coloured references.
  let fnChoices = [];
  let fnIndex = 0;
  function onEditorChange() {
    fx.value = editor.value;
    editor.style.width = `${Math.max(editor.scrollWidth + 8, parseInt(editor.style.minWidth, 10))}px`;
    renderRefs(editor.value);
    const caret = editor.selectionStart;
    const prefix = typedFunctionPrefix(editor.value, caret);
    fnChoices = prefix ? FUNCTIONS.filter(([name]) => name.startsWith(prefix) && name !== prefix).slice(0, 8) : [];
    fnIndex = 0;
    const call = !fnChoices.length && openCall(editor.value, caret);
    const fn = call && FUNCTIONS.find(([name]) => name === call.name);
    if (fnChoices.length) renderFnChoices();
    else if (fn) {
      const args = fn[1].split(';').map((a) => a.trim());
      clear(fnBox, h('div', { class: 'fn-hint' }, h('b', {}, fn[0]), '(',
        args.map((a, i) => [i ? '; ' : '', i === Math.min(call.arg, args.length - 1) ? h('u', {}, a) : a]), ')',
        h('div', { class: 'muted' }, fn[2])));
      showFnBox();
    } else fnBox.hidden = true;
  }
  function renderFnChoices() {
    clear(fnBox, fnChoices.map(([name, args, help], i) => h('div', {
      class: `fn-opt${i === fnIndex ? ' on' : ''}`, role: 'option',
      onmousedown: (e) => { e.preventDefault(); fnIndex = i; insertFunction(); },
    }, h('b', {}, name), h('span', { class: 'muted' }, `(${args})`), h('div', { class: 'muted small-text' }, help))),
    h('div', { class: 'fn-foot muted' }, 'Tab ou Entrée pour insérer'));
    showFnBox();
  }
  function showFnBox() {
    fnBox.hidden = false;
    Object.assign(fnBox.style, { left: editor.style.left, top: `${parseInt(editor.style.top, 10) + parseInt(editor.style.height, 10) + 2}px` });
  }
  function insertFunction() {
    const [name] = fnChoices[fnIndex];
    const caret = editor.selectionStart;
    const prefix = typedFunctionPrefix(editor.value, caret);
    const start = caret - prefix.length;
    editor.value = `${editor.value.slice(0, start)}${name}(${editor.value.slice(caret)}`;
    const pos = start + name.length + 1;
    editor.setSelectionRange(pos, pos);
    onEditorChange();
  }

  function renderRefs(text) {
    const refs = formulaRefs(text);
    const seen = new Map();
    clear(refsLayer, refs.map((ref) => {
      if (!seen.has(ref.text)) seen.set(ref.text, REF_COLORS[seen.size % REF_COLORS.length]);
      const color = seen.get(ref.text);
      const box = h('div', { class: 'ref-box', style: { borderColor: color, background: `${color}12` } });
      place(box, rectOf(ref));
      return box;
    }));
  }

  // Clicking a cell while typing "=SOMME(" inserts its reference; dragging makes a range.
  function pointAt(c, r, extend) {
    const caret = editor.selectionStart;
    if (!pointing) pointing = { start: caret, end: caret, anchor: { c, r } };
    if (!extend || !pointing.dragging) pointing.anchor = pointing.dragging || extend ? pointing.anchor : { c, r };
    const a = pointing.anchor;
    const text = a.c === c && a.r === r ? refName(c, r)
      : `${refName(Math.min(a.c, c), Math.min(a.r, r))}:${refName(Math.max(a.c, c), Math.max(a.r, r))}`;
    editor.value = editor.value.slice(0, pointing.start) + text + editor.value.slice(pointing.end);
    pointing.end = pointing.start + text.length;
    pointing.dragging = true;
    editor.setSelectionRange(pointing.end, pointing.end);
    editor.focus();
    const keepPointing = pointing;
    onEditorChange();
    pointing = keepPointing;
  }

  editor.addEventListener('input', (e) => {
    pointing = null;
    if (e.inputType?.startsWith('insert') && editor.selectionStart === editor.value.length) {
      const typed = editor.value;
      const full = completionFor(typed);
      if (full) {
        editor.value = typed + full.slice(typed.length);
        editor.setSelectionRange(typed.length, editor.value.length);
      }
    }
    onEditorChange();
  });
  editor.addEventListener('click', () => { pointing = null; onEditorChange(); });
  editor.addEventListener('keydown', (e) => {
    if (!fnBox.hidden && fnChoices.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        fnIndex = (fnIndex + (e.key === 'ArrowDown' ? 1 : fnChoices.length - 1)) % fnChoices.length;
        renderFnChoices();
        return;
      }
      if (e.key === 'Tab' || e.key === 'Enter') { e.preventDefault(); insertFunction(); return; }
      if (e.key === 'Escape') { e.preventDefault(); fnBox.hidden = true; fnChoices = []; return; }
    }
    if (e.key === 'Enter') { e.preventDefault(); commitEdit(); moveTo(sel.c, sel.r + (e.shiftKey ? -1 : 1)); }
    else if (e.key === 'Tab') { e.preventDefault(); commitEdit(); moveTo(sel.c + (e.shiftKey ? -1 : 1), sel.r); }
    else if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') {
      pointing = null;
      requestAnimationFrame(onEditorChange);
    }
  });
  editor.addEventListener('blur', () => { if (editing) commitEdit(); });

  fx.addEventListener('focus', () => { if (editing) cancelEdit(); });
  fx.addEventListener('input', () => renderRefs(fx.value));
  fx.addEventListener('blur', () => clear(refsLayer));
  fx.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const key = refName(sel.c, sel.r);
      if (fx.value !== model.raw(key)) setCells([[key, { ...(data.cells[key] || {}), v: fx.value }]]);
      wrap.focus();
      moveTo(sel.c, sel.r + 1);
    } else if (e.key === 'Escape') { fx.value = model.raw(refName(sel.c, sel.r)); wrap.focus(); }
  });

  // ---------- Changes & undo (shared state) ----------
  // changes: [[key, cell | null]]
  function setCells(changes) {
    ydoc.transact(() => {
      for (const [key, cell] of changes) {
        const clean = cell && Object.fromEntries(Object.entries(cell).filter(([, v]) => v !== undefined && v !== '' && v !== null && v !== 0));
        if (clean && Object.keys(clean).length) ycells.set(key, clean);
        else if (ycells.has(key)) ycells.delete(key);
      }
    });
  }
  const doUndo = () => undoManager.undo();
  const doRedo = () => undoManager.redo();

  // Local and remote changes both land here.
  let refreshQueued = false;
  const onDocUpdate = () => {
    if (refreshQueued) return;
    refreshQueued = true;
    requestAnimationFrame(() => {
      refreshQueued = false;
      pull();
      if (data.rows !== tds.length || data.cols !== cols.length || !!data.freeze !== table.classList.contains('freeze')) return build();
      for (const [i, col] of cols.entries()) col.style.width = `${data.widths[colName(i)] || DEFAULT_WIDTH}px`;
      table.style.width = `${tableWidth()}px`;
      paintAll();
      showSelection();
      renderPeers();
      if (freezeBtn) freezeBtn.classList.toggle('on', !!data.freeze);
    });
  };
  ydoc.on('update', onDocUpdate);

  function eachInRange(fn) {
    const { c1, c2, r1, r2 } = bounds();
    const out = [];
    for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) out.push(fn(refName(c, r), c, r));
    return out;
  }
  const clearRange = () => setCells(eachInRange((key) => [key, data.cells[key] ? { ...data.cells[key], v: undefined } : null]));
  const clearFormats = () => setCells(eachInRange((key) => [key, data.cells[key]?.v ? { v: data.cells[key].v } : null]));
  function toggleFormat(prop) {
    const all = eachInRange((key) => data.cells[key]?.[prop]).every(Boolean);
    setCells(eachInRange((key) => [key, { ...(data.cells[key] || {}), [prop]: all ? undefined : 1 }]));
  }
  const setFormat = (prop, value) => setCells(eachInRange((key) => [key, { ...(data.cells[key] || {}), [prop]: value }]));

  // Ctrl+D / Ctrl+R: copy the first row (column) of the selection into the rest.
  function fillFromFirst(axis) {
    const b = bounds();
    const changes = [];
    if (axis === 'r') {
      if (b.r1 === b.r2) { if (b.r1 === 0) return; b.r1 -= 1; }
      for (let c = b.c1; c <= b.c2; c++) {
        const src = data.cells[refName(c, b.r1)];
        for (let r = b.r1 + 1; r <= b.r2; r++) changes.push([refName(c, r), src ? { ...src, v: shiftFormula(src.v, 0, r - b.r1) } : null]);
      }
    } else {
      if (b.c1 === b.c2) { if (b.c1 === 0) return; b.c1 -= 1; }
      for (let r = b.r1; r <= b.r2; r++) {
        const src = data.cells[refName(b.c1, r)];
        for (let c = b.c1 + 1; c <= b.c2; c++) changes.push([refName(c, r), src ? { ...src, v: shiftFormula(src.v, c - b.c1, 0) } : null]);
      }
    }
    setCells(changes);
  }

  function grow(rows, colsToAdd) {
    ydoc.transact(() => {
      ymeta.set('rows', Math.min(MAX_ROWS, data.rows + rows));
      ymeta.set('cols', Math.min(MAX_COLS, data.cols + colsToAdd));
    });
  }

  // Insert (count > 0) or delete (count < 0) rows ('r') or columns ('c') at `index`, keeping formulas right.
  function insertAt(axis, index, count) {
    const max = axis === 'r' ? MAX_ROWS : MAX_COLS;
    const size = axis === 'r' ? data.rows : data.cols;
    if (count > 0 && size + count > max) { toast(`${max} ${axis === 'r' ? 'lignes' : 'colonnes'} au maximum`, { error: true }); return; }
    const next = new Map();
    for (const [key, cell] of Object.entries(data.cells)) {
      const p = keyPos(key);
      const pos = p[axis];
      if (count < 0 && pos >= index && pos < index - count) continue;
      const moved = { ...p, [axis]: pos >= index ? pos + count : pos };
      next.set(refName(moved.c, moved.r), { ...cell, ...(cell.v !== undefined ? { v: adjustForInsert(cell.v, axis, index, count) } : {}) });
    }
    ydoc.transact(() => {
      for (const key of Object.keys(data.cells)) if (!next.has(key)) ycells.delete(key);
      for (const [key, cell] of next) if (JSON.stringify(data.cells[key]) !== JSON.stringify(cell)) ycells.set(key, cell);
      if (axis === 'c') {
        const widths = {};
        for (const [name, w] of Object.entries(data.widths)) {
          const c = colIndex(name);
          if (count < 0 && c >= index && c < index - count) continue;
          widths[colName(c >= index ? c + count : c)] = w;
        }
        for (const name of Object.keys(data.widths)) if (!(name in widths)) ywidths.delete(name);
        for (const [name, w] of Object.entries(widths)) if (data.widths[name] !== w) ywidths.set(name, w);
      }
      if (count > 0) ymeta.set(axis === 'r' ? 'rows' : 'cols', size + count);
    });
  }

  // Sort rows by the active column. A single cell or whole columns sort the whole table, keeping a header row.
  function sortBy(desc) {
    const b = bounds();
    const { maxR, maxC } = usedBounds();
    let region = b;
    if (b.r1 === b.r2 || (b.r1 === 0 && b.r2 === data.rows - 1)) {
      region = { c1: 0, c2: Math.max(maxC - 1, 0), r1: 0, r2: Math.max(maxR - 1, 0) };
      const head = model.value(refName(sel.c, 0));
      const below = model.value(refName(sel.c, 1));
      // Same rule as most spreadsheets: a bold first row, or text above numbers, is a header.
      const looksLikeHeader = typeof head === 'string' && head !== ''
        && (data.cells[refName(sel.c, 0)]?.b || typeof below === 'number');
      if (looksLikeHeader) region.r1 = 1;
    }
    if (region.r2 <= region.r1) return;
    const rows = [];
    for (let r = region.r1; r <= region.r2; r++) rows.push(r);
    const collator = new Intl.Collator('fr', { numeric: true, sensitivity: 'base' });
    const val = (r) => model.value(refName(sel.c, r));
    rows.sort((x, y) => {
      const a = val(x);
      const bv = val(y);
      const ea = a === '' || a === undefined;
      const eb = bv === '' || bv === undefined;
      if (ea || eb) return ea - eb; // empty cells stay last
      let d;
      if (typeof a === 'number' && typeof bv === 'number') d = a - bv;
      else if (typeof a === 'number') d = -1;
      else if (typeof bv === 'number') d = 1;
      else d = collator.compare(String(a), String(bv));
      return (desc ? -d : d) || x - y;
    });
    const changes = [];
    rows.forEach((src, i) => {
      const dest = region.r1 + i;
      for (let c = region.c1; c <= region.c2; c++) {
        const cell = data.cells[refName(c, src)];
        changes.push([refName(c, dest), cell ? { ...cell, v: shiftFormula(cell.v, 0, dest - src) } : null]);
      }
    });
    setCells(changes);
    toast(`Trié par la colonne ${colName(sel.c)}${region.r1 === 1 && b.r1 === b.r2 ? ' (ligne d’en-tête conservée)' : ''}`);
  }

  function startResize(e, c) {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const name = colName(c);
    const start = data.widths[name] || DEFAULT_WIDTH;
    const onMove = (ev) => {
      const w = Math.max(30, Math.min(800, start + ev.clientX - startX));
      cols[c].style.width = `${w}px`;
      data.widths[name] = w;
      table.style.width = `${tableWidth()}px`;
      showSelection();
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      ywidths.set(name, data.widths[name]);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  // Double-click on a column border: width of the longest content.
  const measure = document.createElement('canvas').getContext('2d');
  function autoFit(c) {
    const style = getComputedStyle(tds[0][c]);
    let w = 0;
    for (let r = 0; r < data.rows; r++) {
      const td = tds[r][c];
      if (!td.textContent) continue;
      measure.font = `${td.classList.contains('b') ? '700' : style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      w = Math.max(w, measure.measureText(td.textContent).width);
    }
    ywidths.set(colName(c), Math.round(Math.max(40, Math.min(600, w + 16))));
  }

  // ---------- Find (Ctrl+F) ----------
  let found = [];
  let foundIndex = 0;
  const findInput = h('input', { class: 'input', placeholder: 'Rechercher dans le tableur', 'aria-label': 'Rechercher' });
  const findCount = h('span', { class: 'muted small-text' });
  const findBar = h('div', { class: 'find-bar', hidden: true },
    icon('search'), findInput, findCount,
    h('button', { class: 'icon-btn small', title: 'Précédent (Maj+Entrée)', onclick: () => stepFind(-1) }, icon('arrowUp')),
    h('button', { class: 'icon-btn small', title: 'Suivant (Entrée)', onclick: () => stepFind(1) }, icon('arrowDown')),
    h('button', { class: 'icon-btn small', title: 'Fermer (Échap)', onclick: () => closeFind() }, icon('close')));
  function runFind() {
    const q = findInput.value.trim().toLowerCase();
    found = [];
    if (q) {
      for (const key of Object.keys(data.cells)) {
        const text = String(display(model.value(key))).toLowerCase();
        if (text.includes(q) || String(data.cells[key].v ?? '').toLowerCase().includes(q)) found.push(keyPos(key));
      }
      found.sort((a, b) => a.r - b.r || a.c - b.c);
    }
    foundIndex = 0;
    paintFound();
    findCount.textContent = q ? (found.length ? `${foundIndex + 1} / ${found.length}` : 'Aucun résultat') : '';
    if (found.length) moveTo(found[0].c, found[0].r);
  }
  function stepFind(d) {
    if (!found.length) return;
    foundIndex = (foundIndex + d + found.length) % found.length;
    findCount.textContent = `${foundIndex + 1} / ${found.length}`;
    moveTo(found[foundIndex].c, found[foundIndex].r);
  }
  let foundMarked = [];
  function paintFound() {
    for (const td of foundMarked) td.classList.remove('found');
    foundMarked = findBar.hidden ? [] : found.map(({ c, r }) => tds[r]?.[c]).filter(Boolean);
    for (const td of foundMarked) td.classList.add('found');
  }
  function openFind() {
    findBar.hidden = false;
    findInput.focus();
    findInput.select();
    if (findInput.value) runFind();
  }
  function closeFind() {
    findBar.hidden = true;
    paintFound();
    wrap.focus({ preventScroll: true });
  }
  findInput.addEventListener('input', runFind);
  findInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); stepFind(e.shiftKey ? -1 : 1); }
    if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
  });

  // ---------- Keyboard & clipboard ----------
  const onDocKey = (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f' && !e.shiftKey) { e.preventDefault(); openFind(); }
  };
  document.addEventListener('keydown', onDocKey);

  wrap.addEventListener('keydown', (e) => {
    if (editing || e.target !== wrap) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key;
    const moves = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
    if (moves[k]) {
      e.preventDefault();
      const [dc, dr] = moves[k];
      const target = mod ? jump(dc, dr) : { c: sel.c + dc, r: sel.r + dr };
      moveTo(target.c, target.r, e.shiftKey);
    } else if (k === 'Enter') { e.preventDefault(); if (e.shiftKey) moveTo(sel.c, sel.r - 1); else startEdit(); }
    else if (k === 'Tab') { e.preventDefault(); moveTo(sel.c + (e.shiftKey ? -1 : 1), sel.r); }
    else if (k === 'Home') { e.preventDefault(); moveTo(0, mod ? 0 : sel.r, e.shiftKey); }
    else if (k === 'End' && mod) { e.preventDefault(); const { maxR, maxC } = usedBounds(); moveTo(Math.max(maxC - 1, 0), Math.max(maxR - 1, 0), e.shiftKey); }
    else if (k === 'PageDown' || k === 'PageUp') {
      e.preventDefault();
      const page = Math.max(5, Math.floor(wrap.clientHeight / 25) - 2);
      moveTo(sel.c, sel.r + (k === 'PageDown' ? page : -page), e.shiftKey);
    } else if (k === 'F2') { e.preventDefault(); startEdit(); }
    else if ((k === 'Delete' || k === 'Backspace') && canEdit) { e.preventDefault(); clearRange(); }
    else if (mod && k.toLowerCase() === 'z') { e.preventDefault(); if (canEdit) (e.shiftKey ? doRedo : doUndo)(); }
    else if (mod && k.toLowerCase() === 'y') { e.preventDefault(); if (canEdit) doRedo(); }
    else if (mod && k.toLowerCase() === 'b') { e.preventDefault(); if (canEdit) toggleFormat('b'); }
    else if (mod && k.toLowerCase() === 'i') { e.preventDefault(); if (canEdit) toggleFormat('i'); }
    else if (mod && k.toLowerCase() === 'd') { e.preventDefault(); if (canEdit) fillFromFirst('r'); }
    else if (mod && k.toLowerCase() === 'r') { e.preventDefault(); if (canEdit) fillFromFirst('c'); }
    else if (mod && k === ';') { e.preventDefault(); if (canEdit) setCells([[refName(sel.c, sel.r), { ...(data.cells[refName(sel.c, sel.r)] || {}), v: new Date().toLocaleDateString('fr-FR') }]]); }
    else if (mod && k.toLowerCase() === 's') { e.preventDefault(); }
    else if (mod && k.toLowerCase() === 'a') { e.preventDefault(); selectAll(); }
    else if (k.length === 1 && !mod && !e.altKey && canEdit) { e.preventDefault(); startEdit(k); }
  });

  const rangeText = () => {
    const { c1, c2, r1, r2 } = bounds();
    const rows = [];
    for (let r = r1; r <= r2; r++) {
      const row = [];
      for (let c = c1; c <= c2; c++) row.push(String(display(model.value(refName(c, r)))));
      rows.push(row.join('\t'));
    }
    return rows.join('\n');
  };
  function pasteText(text) {
    const rows = text.replace(/\r/g, '').replace(/\n$/, '').split('\n').map((line) => line.split('\t'));
    const { c1, r1 } = bounds();
    const width = Math.max(...rows.map((r) => r.length));
    const needRows = r1 + rows.length - data.rows;
    const needCols = c1 + width - data.cols;
    if (needRows > 0 || needCols > 0) {
      grow(Math.max(0, needRows), Math.max(0, needCols));
      pull(); // the grid is rebuilt on the next frame, the data must be bigger now
    }
    const changes = [];
    rows.forEach((row, dr) => row.forEach((v, dc) => {
      if (r1 + dr >= data.rows || c1 + dc >= data.cols) return;
      const key = refName(c1 + dc, r1 + dr);
      changes.push([key, { ...(data.cells[key] || {}), v }]);
    }));
    setCells(changes);
    anchor = { c: c1, r: r1 };
    sel = { c: Math.min(data.cols - 1, c1 + width - 1), r: Math.min(data.rows - 1, r1 + rows.length - 1) };
    showSelection();
  }
  const onCopy = (e) => {
    if (editing || document.activeElement !== wrap) return;
    e.preventDefault();
    e.clipboardData.setData('text/plain', rangeText());
  };
  const onCut = (e) => {
    if (editing || document.activeElement !== wrap || !canEdit) return;
    onCopy(e);
    clearRange();
  };
  const onPaste = (e) => {
    if (editing || document.activeElement !== wrap || !canEdit) return;
    e.preventDefault();
    pasteText(e.clipboardData.getData('text/plain'));
  };
  document.addEventListener('copy', onCopy);
  document.addEventListener('cut', onCut);
  document.addEventListener('paste', onPaste);

  // ---------- Right-click menu ----------
  wrap.addEventListener('contextmenu', (e) => {
    const cell = e.target.closest('td, th.rowh, th.colh');
    if (!cell) return;
    e.preventDefault();
    commitEdit();
    const b = bounds();
    const c = cell.dataset.c !== undefined ? Number(cell.dataset.c) : null;
    const r = cell.dataset.r !== undefined ? Number(cell.dataset.r) : null;
    // Right-clicking outside the selection selects what was clicked.
    const inside = (c === null || (c >= b.c1 && c <= b.c2)) && (r === null || (r >= b.r1 && r <= b.r2));
    if (!inside) {
      if (cell.matches('th.colh')) selectWhole('col', c, false);
      else if (cell.matches('th.rowh')) selectWhole('row', r, false);
      else moveTo(c, r);
    }
    const s = bounds();
    const nr = s.r2 - s.r1 + 1;
    const nc = s.c2 - s.c1 + 1;
    const plural = (n, one, many) => (n > 1 ? `${n} ${many}` : one);
    const clip = async (fn) => { try { await fn(); } catch { toast('Utilisez Ctrl+C, Ctrl+X et Ctrl+V : le navigateur bloque ce menu', { error: true }); } };
    const entries = [
      { label: 'Couper', icon: 'move', hint: 'Ctrl+X', run: () => clip(async () => { await navigator.clipboard.writeText(rangeText()); clearRange(); }) },
      { label: 'Copier', icon: 'copy', hint: 'Ctrl+C', run: () => clip(() => navigator.clipboard.writeText(rangeText())) },
      { label: 'Coller', icon: 'download', hint: 'Ctrl+V', run: () => clip(async () => pasteText(await navigator.clipboard.readText())) },
      'sep',
      { label: `Insérer ${plural(nr, '1 ligne', 'lignes')} au-dessus`, icon: 'rowPlus', run: () => insertAt('r', s.r1, nr) },
      { label: `Insérer ${plural(nr, '1 ligne', 'lignes')} en dessous`, icon: 'rowPlus', run: () => insertAt('r', s.r2 + 1, nr) },
      { label: `Insérer ${plural(nc, '1 colonne', 'colonnes')} à gauche`, icon: 'colPlus', run: () => insertAt('c', s.c1, nc) },
      { label: `Insérer ${plural(nc, '1 colonne', 'colonnes')} à droite`, icon: 'colPlus', run: () => insertAt('c', s.c2 + 1, nc) },
      { label: `Supprimer ${nr > 1 ? `les ${nr} lignes` : 'la ligne'}`, icon: 'trash', danger: true, run: () => insertAt('r', s.r1, -nr) },
      { label: `Supprimer ${nc > 1 ? `les ${nc} colonnes` : 'la colonne'}`, icon: 'trash', danger: true, run: () => insertAt('c', s.c1, -nc) },
      'sep',
      { label: `Trier A → Z (colonne ${colName(sel.c)})`, icon: 'arrowDown', run: () => sortBy(false) },
      { label: `Trier Z → A (colonne ${colName(sel.c)})`, icon: 'arrowUp', run: () => sortBy(true) },
      'sep',
      { label: 'Effacer le contenu', icon: 'eraser', hint: 'Suppr', run: clearRange },
      { label: 'Effacer la mise en forme', icon: 'eraser', run: clearFormats },
      ...(cell.matches('th.colh') ? [{ label: 'Ajuster la largeur', icon: 'colPlus', run: () => { for (let x = s.c1; x <= s.c2; x++) autoFit(x); } }] : []),
    ];
    showMenu(canEdit ? entries : entries.slice(1, 2), { x: e.clientX, y: e.clientY });
  });

  // ---------- Toolbar ----------
  const tb = (ic, title, run) => h('button', { class: 'icon-btn', title, 'aria-label': title, onmousedown: (e) => e.preventDefault(), onclick: () => { run(); wrap.focus({ preventScroll: true }); } }, icon(ic));
  const txt = (label, title, run, cls = '') => h('button', { class: `icon-btn txt ${cls}`, title, 'aria-label': title, onmousedown: (e) => e.preventDefault(), onclick: (e) => { run(e); wrap.focus({ preventScroll: true }); } }, label);
  const bg = h('input', { type: 'color', value: '#fff3bf', title: 'Couleur de fond', oninput: () => setFormat('bg', bg.value) });
  const fg = h('input', { type: 'color', value: '#b91c1c', title: 'Couleur du texte', oninput: () => setFormat('fg', fg.value) });
  const freezeBtn = canEdit ? txt('Figer', 'Figer la première ligne (en-têtes toujours visibles)', () => ymeta.set('freeze', data.freeze ? 0 : 1), data.freeze ? 'on' : '') : null;
  const formatsMenu = (e) => showMenu(NUMBER_FORMATS.map(([f, label, example]) => ({
    label, hint: example, run: () => { setFormat('f', f || undefined); wrap.focus({ preventScroll: true }); },
  })), e.currentTarget);
  const toolbar = h('div', { class: 'format-bar', role: 'toolbar' },
    tb('undo', 'Annuler (Ctrl+Z)', doUndo), tb('redo', 'Rétablir (Ctrl+Y)', doRedo),
    h('span', { class: 'sep' }),
    txt('€', 'Format monétaire', () => setFormat('f', 'eur')), txt('%', 'Pourcentage', () => setFormat('f', 'pct')),
    txt('123', 'Autres formats de nombre', formatsMenu),
    h('span', { class: 'sep' }),
    tb('bold', 'Gras (Ctrl+B)', () => toggleFormat('b')), tb('italic', 'Italique (Ctrl+I)', () => toggleFormat('i')),
    h('label', { class: 'color-pick', title: 'Couleur du texte' }, h('span', { class: 'a' }, 'A'), fg),
    h('label', { class: 'color-pick', title: 'Couleur de fond' }, icon('edit'), bg),
    h('span', { class: 'sep' }),
    tb('alignL', 'Aligner à gauche', () => setFormat('a', 'l')), tb('alignC', 'Centrer', () => setFormat('a', 'c')), tb('alignR', 'Aligner à droite', () => setFormat('a', 'r')),
    tb('eraser', 'Effacer la mise en forme', clearFormats),
    h('span', { class: 'sep' }),
    txt('A→Z', 'Trier par la colonne active (A → Z)', () => sortBy(false)),
    freezeBtn,
    tb('search', 'Rechercher (Ctrl+F)', openFind),
    h('span', { class: 'sep' }),
    tb('rowPlus', 'Ajouter 100 lignes', () => grow(100, 0)), tb('colPlus', 'Ajouter une colonne', () => grow(0, 1)));

  clear(app, h('div', { class: 'editor-shell sheet-editor' },
    bar,
    canEdit ? toolbar : null,
    h('div', { class: 'formula-bar' }, refBox, h('span', { class: 'fx' }, 'fx'), fx),
    h('div', { class: 'sheet-area' }, findBar, wrap),
    statusBar));
  build();
  wrap.focus({ preventScroll: true });

  teardown = () => {
    commitEdit();
    ydoc.off('update', onDocUpdate);
    provider.awareness.off('change', renderPeers);
    undoManager.destroy();
    room.destroy();
    document.removeEventListener('mouseup', stopDrag);
    document.removeEventListener('copy', onCopy);
    document.removeEventListener('cut', onCut);
    document.removeEventListener('paste', onPaste);
    document.removeEventListener('keydown', onDocKey);
  };
}
