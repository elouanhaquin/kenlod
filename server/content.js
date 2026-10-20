import sanitizeHtml from 'sanitize-html';
import { HttpError } from './util.js';
import { DOC_IMAGE_SRC } from '../shared/doc-schema.js';

const MAX_CONTENT = 4 * 1024 * 1024;

export function sanitizeDoc(html) {
  if (typeof html !== 'string') throw new HttpError(400, 'Contenu invalide');
  if (html.length > MAX_CONTENT) throw new HttpError(413, 'Document trop volumineux');
  return sanitizeHtml(html, {
    allowedTags: [
      'p', 'br', 'h1', 'h2', 'h3', 'h4', 'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'sub', 'sup', 'mark',
      'ul', 'ol', 'li', 'a', 'blockquote', 'pre', 'code', 'hr', 'span', 'div', 'font',
      'table', 'thead', 'tbody', 'tr', 'th', 'td', 'colgroup', 'col', 'img',
    ],
    allowedAttributes: {
      a: ['href', 'target', 'rel'], font: ['color'], img: ['src', 'alt', 'title'], mark: ['data-color'],
      td: ['colspan', 'rowspan', 'colwidth'], th: ['colspan', 'rowspan', 'colwidth'], '*': ['style'],
    },
    allowedSchemesByTag: { img: [] },
    allowProtocolRelative: false,
    // Only images stored by Kenlod: no external trackers, no data: blobs.
    exclusiveFilter: (frame) => frame.tag === 'img' && !DOC_IMAGE_SRC.test(frame.attribs.src || ''),
    allowedStyles: {
      '*': {
        'text-align': [/^(left|right|center|justify)$/],
        'font-family': [/^[\w\s",-]{1,120}$/],
        'min-width': [/^\d{1,4}px$/],
        width: [/^\d{1,4}px$/],
        color: [/^#[0-9a-f]{3,8}$/i, /^rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\)$/],
        'background-color': [/^#[0-9a-f]{3,8}$/i, /^rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\)$/],
        'font-weight': [/^(bold|normal|[1-9]00)$/],
        'font-style': [/^(italic|normal)$/],
        'text-decoration': [/^(underline|line-through|none)$/],
      },
    },
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    transformTags: {
      a: sanitizeHtml.simpleTransform('a', { target: '_blank', rel: 'noopener noreferrer nofollow' }),
    },
  });
}

const CELL_KEY = /^[A-Z]{1,2}[1-9][0-9]{0,4}$/;
const COL_KEY = /^[A-Z]{1,2}$/;

const NUMBER_FORMATS = ['int', 'n2', 'eur', 'pct'];

// Spreadsheets are stored as JSON: { rows, cols, freeze?, cells: { A1: { v, b?, i?, a?, bg?, fg?, f? } }, widths: { A: 120 } }.
export function validateSheet(raw) {
  if (typeof raw !== 'string' || raw.length > MAX_CONTENT) throw new HttpError(400, 'Tableur invalide');
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'Tableur invalide');
  }
  const out = {
    rows: Math.min(Math.max(Number(data.rows) || 100, 1), 5000),
    cols: Math.min(Math.max(Number(data.cols) || 26, 1), 100),
    ...(data.freeze ? { freeze: 1 } : {}),
    cells: {},
    widths: {},
  };
  for (const [key, cell] of Object.entries(data.cells || {})) {
    if (!CELL_KEY.test(key) || !cell || typeof cell !== 'object') continue;
    const c = {};
    if (cell.v !== undefined && cell.v !== null && cell.v !== '') c.v = String(cell.v).slice(0, 20000);
    if (cell.b) c.b = 1;
    if (cell.i) c.i = 1;
    if (['l', 'c', 'r'].includes(cell.a)) c.a = cell.a;
    if (/^#[0-9a-f]{6}$/i.test(cell.bg || '')) c.bg = cell.bg;
    if (/^#[0-9a-f]{6}$/i.test(cell.fg || '')) c.fg = cell.fg;
    if (NUMBER_FORMATS.includes(cell.f)) c.f = cell.f;
    if (Object.keys(c).length) out.cells[key] = c;
  }
  for (const [key, w] of Object.entries(data.widths || {})) {
    if (COL_KEY.test(key) && Number(w) >= 30 && Number(w) <= 800) out.widths[key] = Math.round(Number(w));
  }
  return JSON.stringify(out);
}

export const EMPTY_SHEET = JSON.stringify({ rows: 100, cols: 26, cells: {}, widths: {} });
