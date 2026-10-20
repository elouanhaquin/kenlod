// Small DOM toolkit: element builder, icons, menus, modals, toasts, formatting.

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export const clear = (el, ...children) => { el.replaceChildren(); append(el, children); return el; };

const P = {
  plus: 'M12 5v14M5 12h14',
  form: 'M9 4h6v3H9zM9 5.5H6a1 1 0 0 0-1 1V20a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V6.5a1 1 0 0 0-1-1h-3M8.5 11.5l1.5 1.5 2.5-2.5M14 12h2.5M8.5 16.5l1.5 1.5 2.5-2.5M14 17h2.5',
  send: 'M21 3 10 14M21 3l-7 18-4-7-7-4z',
  chart: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  dup: 'M8 8h11a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1zM4 16V5a1 1 0 0 1 1-1h11',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4',
  home: 'M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-5v-6h-4v6H5a1 1 0 0 1-1-1z',
  users: 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2 21v-1a6 6 0 0 1 6-6h2a6 6 0 0 1 6 6v1M16 3.1a4 4 0 0 1 0 7.8M22 21v-1a6 6 0 0 0-4-5.6',
  share: 'M16 6a3 3 0 1 0 0-.01M6 15a3 3 0 1 0 0-.01M16 21a3 3 0 1 0 0-.01M8.6 13.5l4.8-2.9M8.6 16.5l4.8 2.9',
  clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2',
  star: 'm12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z',
  trash: 'M4 7h16M10 11v6M14 11v6M5 7l1 13a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1l1-13M9 7V4h6v3',
  folder: 'M3 6.5A1.5 1.5 0 0 1 4.5 5h4.6l2 2h8.4A1.5 1.5 0 0 1 21 8.5v10a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z',
  folderPlus: 'M3 6.5A1.5 1.5 0 0 1 4.5 5h4.6l2 2h8.4A1.5 1.5 0 0 1 21 8.5v10a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5zM12 10.5v6M9 13.5h6',
  upload: 'M12 16V4M7 9l5-5 5 5M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3',
  uploadFolder: 'M3 6.5A1.5 1.5 0 0 1 4.5 5h4.6l2 2h8.4A1.5 1.5 0 0 1 21 8.5v10a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5zM12 17v-6M9.5 13.5 12 11l2.5 2.5',
  download: 'M12 4v12M7 11l5 5 5-5M4 20h16',
  more: 'M12 6h.01M12 12h.01M12 18h.01',
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  list: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01',
  info: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 11v5M12 8h.01',
  edit: 'M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4',
  move: 'M3 6.5A1.5 1.5 0 0 1 4.5 5h4.6l2 2h8.4A1.5 1.5 0 0 1 21 8.5v10a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5zM9 13.5h6M12.5 11l2.5 2.5-2.5 2.5',
  copy: 'M9 9h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V10a1 1 0 0 1 1-1zM5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  restore: 'M4 12a8 8 0 1 0 2.3-5.6M4 4v4h4',
  close: 'M6 6l12 12M18 6 6 18',
  check: 'M5 12.5l4.5 4.5L19 7',
  chevron: 'M9 6l6 6-6 6',
  back: 'M15 6l-6 6 6 6',
  arrowUp: 'M12 19V5M6 11l6-6 6 6',
  arrowDown: 'M12 5v14M6 13l6 6 6-6',
  logout: 'M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4M10 17l5-5-5-5M15 12H3',
  settings: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  lock: 'M6 11h12a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1zM8 11V8a4 4 0 0 1 8 0v3',
  shield: 'M12 3 4 6v6c0 4.5 3.4 8.3 8 9 4.6-.7 8-4.5 8-9V6z M9 12l2 2 4-4',
  menu: 'M4 6h16M4 12h16M4 18h16',
  file: 'M7 3h7l5 5v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM14 3v5h5',
  bold: 'M7 5h6a3.5 3.5 0 0 1 0 7H7zM7 12h7a3.5 3.5 0 0 1 0 7H7z',
  italic: 'M10 5h8M6 19h8M14 5l-4 14',
  underline: 'M7 4v7a5 5 0 0 0 10 0V4M5 20h14',
  strike: 'M5 12h14M16 7a4 3 0 0 0-4-2c-2.5 0-4 1.3-4 3 0 3.5 8 2.5 8 6.5 0 1.7-1.7 3-4 3a4.5 3.5 0 0 1-4.5-2.5',
  ul: 'M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01',
  ol: 'M10 6h10M10 12h10M10 18h10M4 4.5h1.5v4M4 8.5h3M4 14.5c0-1 2.5-1 2.5 0S4 16.5 4 17.5h3',
  alignL: 'M4 6h16M4 10h10M4 14h16M4 18h10',
  alignC: 'M4 6h16M7 10h10M4 14h16M7 18h10',
  alignR: 'M4 6h16M10 10h10M4 14h16M10 18h10',
  alignJ: 'M4 6h16M4 10h16M4 14h16M4 18h16',
  image: 'M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zM8.5 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM20 15l-5-5L5 20',
  table: 'M4 5h16v14H4zM4 10h16M4 15h16M10 5v14',
  quote: 'M7 7h4v4c0 3-1.5 5-4 6M14 7h4v4c0 3-1.5 5-4 6',
  undo: 'M9 14 4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3',
  redo: 'm15 14 5-5-5-5M20 9H10a6 6 0 0 0 0 12h3',
  eraser: 'M16 3l5 5-11 11H5l-2-2zM11 8l5 5M9 21h12',
  print: 'M7 9V3h10v6M7 17H5a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-2M7 14h10v7H7z',
  hr: 'M4 12h16',
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  rowPlus: 'M4 5h16v6H4zM12 15v6M9 18h6',
  colPlus: 'M5 4h6v16H5zM15 12h6M18 9v6',
};

const FILLED = new Set(['more']);

export function icon(name, cls = '') {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  // Default size; CSS rules override it where needed.
  svg.setAttribute('width', '20');
  svg.setAttribute('height', '20');
  svg.style.flex = 'none';
  if (cls) svg.setAttribute('class', cls);
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', P[name] || P.file);
  if (FILLED.has(name)) {
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '3.2');
    path.setAttribute('stroke-linecap', 'round');
  } else {
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '1.8');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
  }
  svg.append(path);
  return svg;
}

// File-type icon: a coloured document glyph with a short label.
const TYPES = [
  { test: (i) => i.kind === 'folder', color: '#6b7489', label: '' },
  { test: (i) => i.kind === 'doc', color: '#2f6fd6', label: 'DOC', name: 'Document Kenlod' },
  { test: (i) => i.kind === 'sheet', color: '#16884a', label: 'TAB', name: 'Tableur Kenlod' },
  { test: (i) => i.kind === 'form', color: '#7c3aed', label: 'Q', name: 'Questionnaire Kenlod' },
  { test: (i) => /^image\//.test(i.mime), color: '#d1453b', label: 'IMG', name: 'Image' },
  { test: (i) => i.mime === 'application/pdf', color: '#c62f2f', label: 'PDF', name: 'PDF' },
  { test: (i) => /^video\//.test(i.mime), color: '#c2410c', label: 'VID', name: 'Vidéo' },
  { test: (i) => /^audio\//.test(i.mime), color: '#7c3aed', label: 'SON', name: 'Audio' },
  { test: (i) => /(word|opendocument\.text|msword)/.test(i.mime), color: '#2b579a', label: 'W', name: 'Document texte' },
  { test: (i) => /(sheet|excel|csv)/.test(i.mime), color: '#1e7145', label: 'X', name: 'Feuille de calcul' },
  { test: (i) => /(presentation|powerpoint)/.test(i.mime), color: '#c4501f', label: 'P', name: 'Présentation' },
  { test: (i) => /(zip|rar|7z)/.test(i.mime), color: '#8a6d1d', label: 'ZIP', name: 'Archive' },
  { test: (i) => /^text\//.test(i.mime) || i.mime === 'application/json', color: '#55607a', label: 'TXT', name: 'Texte' },
];

export function typeOf(item) {
  return TYPES.find((t) => t.test(item)) || { color: '#7a8296', label: '', name: 'Fichier' };
}

export function fileIcon(item, size = 22) {
  const t = typeOf(item);
  const wrap = h('span', { class: 'ficon', style: { width: `${size + 2}px`, height: `${size + 2}px` } });
  if (item.kind === 'folder') {
    const svg = icon('folder');
    svg.style.width = svg.style.height = `${size}px`;
    svg.querySelector('path').setAttribute('fill', 'currentColor');
    svg.querySelector('path').setAttribute('stroke', 'none');
    wrap.style.color = '#7a8296';
    wrap.append(svg);
    return wrap;
  }
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.innerHTML = `<rect x="3" y="2" width="18" height="20" rx="3" fill="${t.color}"/>`;
  if (t.label) {
    const text = document.createElementNS(ns, 'text');
    text.setAttribute('x', '12');
    text.setAttribute('y', '15.2');
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('fill', '#fff');
    text.setAttribute('font-size', t.label.length > 2 ? '6.4' : '9');
    text.setAttribute('font-weight', '700');
    text.setAttribute('font-family', 'system-ui, sans-serif');
    text.textContent = t.label;
    svg.append(text);
  }
  wrap.append(svg);
  return wrap;
}

export function initials(name = '?') {
  const parts = String(name).trim().split(/\s+/);
  return ((parts[0]?.[0] || '?') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

const PALETTE = ['#1f5fbf', '#0f766e', '#b45309', '#9d174d', '#4d7c0f', '#6d28d9', '#475569', '#b91c1c'];
export function colorFor(s = '') {
  let n = 0;
  for (const ch of s) n = (n * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[n % PALETTE.length];
}

export function avatar(name, { small = false, group = false, color } = {}) {
  return h('span', {
    class: `avatar${small ? ' sm' : ''}${group ? ' group' : ''}`,
    style: { background: color || colorFor(name), color: '#fff' },
    title: name,
  }, initials(name));
}

// ---- Formatting ----

export function formatBytes(n) {
  if (!n) return '0 o';
  const units = ['o', 'Ko', 'Mo', 'Go', 'To'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toLocaleString('fr-FR', { maximumFractionDigits: n < 10 && i > 0 ? 1 : 0 })} ${units[i]}`;
}

const dateFmt = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
const timeFmt = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit' });
const fullFmt = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long', timeStyle: 'short' });

export function formatDate(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return timeFmt.format(d);
  const y = new Date(today);
  y.setDate(y.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `Hier, ${timeFmt.format(d)}`;
  return dateFmt.format(d);
}
export const formatFull = (ts) => (ts ? fullFmt.format(new Date(ts)) : '—');

export function timeAgo(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return "à l'instant";
  if (s < 3600) return `il y a ${Math.floor(s / 60)} min`;
  if (s < 86400) return `il y a ${Math.floor(s / 3600)} h`;
  if (s < 7 * 86400) return `il y a ${Math.floor(s / 86400)} j`;
  return formatDate(ts);
}

export const ROLE_LABEL = { owner: 'Propriétaire', manager: 'Administrateur', admin: 'Administrateur', editor: 'Éditeur', viewer: 'Lecteur' };

// ---- Toasts ----

export function toast(message, { error = false, action, duration = 4000 } = {}) {
  const box = document.getElementById('toasts');
  const el = h('div', { class: `toast${error ? ' error' : ''}`, role: error ? 'alert' : 'status' }, h('span', {}, message));
  if (action) {
    el.append(h('button', { onclick: () => { action.run(); el.remove(); } }, action.label));
  }
  box.append(el);
  setTimeout(() => el.remove(), duration);
}
export const toastError = (err) => toast(err?.message || String(err), { error: true, duration: 6000 });

// ---- Context menu ----

let openMenu = null;
export function closeMenu() {
  openMenu?.remove();
  openMenu = null;
}
document.addEventListener('mousedown', (e) => { if (openMenu && !openMenu.contains(e.target)) closeMenu(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
window.addEventListener('resize', closeMenu);
window.addEventListener('blur', closeMenu);

// entries: [{ label, icon, run, danger, hint }] or 'sep'
export function showMenu(entries, at) {
  closeMenu();
  const menu = h('div', { class: 'menu', role: 'menu' });
  for (const e of entries) {
    if (!e) continue;
    if (e === 'sep') { menu.append(h('hr')); continue; }
    menu.append(h('button', {
      role: 'menuitem', class: e.danger ? 'danger' : '',
      onclick: () => { closeMenu(); e.run(); },
    }, e.icon ? icon(e.icon) : null, h('span', {}, e.label), e.hint ? h('span', { class: 'hint' }, e.hint) : null));
  }
  menu.style.visibility = 'hidden';
  document.body.append(menu);
  let x, y;
  if (at instanceof Element) {
    const r = at.getBoundingClientRect();
    x = r.left;
    y = r.bottom + 4;
  } else ({ x, y } = at);
  const { width, height } = menu.getBoundingClientRect();
  x = Math.max(8, Math.min(x, innerWidth - width - 8));
  if (y + height > innerHeight - 8) y = Math.max(8, (at instanceof Element ? at.getBoundingClientRect().top - 4 : y) - height);
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  menu.style.visibility = '';
  openMenu = menu;
  menu.querySelector('button')?.focus();
  menu.addEventListener('keydown', (e) => {
    const items = [...menu.querySelectorAll('button')];
    const i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
  });
}

// ---- Modals ----

export function modal(build, { wide = false, onClose } = {}) {
  const prevFocus = document.activeElement;
  const box = h('div', { class: `modal${wide ? ' wide' : ''}`, role: 'dialog', 'aria-modal': 'true' });
  const overlay = h('div', { class: 'overlay' }, box);
  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey, true);
    onClose?.();
    prevFocus?.focus?.();
  };
  const onKey = (e) => {
    if (e.key === 'Escape' && !document.querySelector('.menu')) { e.stopPropagation(); close(); }
  };
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', onKey, true);
  build(box, close);
  document.body.append(overlay);
  (box.querySelector('[autofocus]') || box.querySelector('input, select, textarea, button'))?.focus();
  return close;
}

export function confirmDialog({ title, message, confirm = 'Confirmer', danger = false }) {
  return new Promise((resolve) => {
    let result = false;
    modal((box, close) => {
      box.append(
        h('h2', {}, title),
        message ? h('p', { class: 'muted' }, message) : null,
        h('div', { class: 'actions' },
          h('button', { class: 'btn ghost', onclick: close }, 'Annuler'),
          h('button', { class: `btn ${danger ? 'danger solid' : 'primary'}`, autofocus: true, onclick: () => { result = true; close(); } }, confirm)),
      );
    }, { onClose: () => resolve(result) });
  });
}

export function promptDialog({ title, value = '', label, confirm = 'OK', selectBase = false }) {
  return new Promise((resolve) => {
    let result = null;
    modal((box, close) => {
      const input = h('input', { class: 'input', value, 'aria-label': label || title });
      const submit = (e) => {
        e.preventDefault();
        if (!input.value.trim()) return input.focus();
        result = input.value.trim();
        close();
      };
      box.append(h('form', { onsubmit: submit },
        h('h2', {}, title),
        label ? h('label', { class: 'field' }, h('span', {}, label), input) : input,
        h('div', { class: 'actions' },
          h('button', { type: 'button', class: 'btn ghost', onclick: close }, 'Annuler'),
          h('button', { class: 'btn primary' }, confirm))));
      requestAnimationFrame(() => {
        input.focus();
        const dot = value.lastIndexOf('.');
        if (selectBase && dot > 0) input.setSelectionRange(0, dot);
        else input.select();
      });
    }, { onClose: () => resolve(result) });
  });
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = h('textarea', { value: text, style: { position: 'fixed', opacity: '0' } });
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast('Lien copié dans le presse-papiers');
}

export function debounce(fn, ms) {
  let t;
  const wrapped = (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  wrapped.flush = (...args) => { clearTimeout(t); fn(...args); };
  wrapped.cancel = () => clearTimeout(t);
  return wrapped;
}
