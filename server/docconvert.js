// Converts between stored HTML snapshots and the collaborative Yjs document.
import { getSchema } from '@tiptap/core';
import { DOMParser as PMDOMParser, DOMSerializer } from '@tiptap/pm/model';
import { parseHTML } from 'linkedom';
import { prosemirrorToYXmlFragment, yXmlFragmentToProseMirrorRootNode } from 'y-prosemirror';
import { docExtensions } from '../shared/doc-schema.js';

export const schema = getSchema(docExtensions());
export const FRAGMENT = 'default'; // field used by TipTap's Collaboration extension

const page = (html = '') => parseHTML(`<!doctype html><html><body>${html}</body></html>`).document;

export function htmlIntoYDoc(html, ydoc) {
  const node = PMDOMParser.fromSchema(schema).parse(page(html).body);
  prosemirrorToYXmlFragment(node, ydoc.getXmlFragment(FRAGMENT));
}

export function yDocToHtml(ydoc) {
  const node = yXmlFragmentToProseMirrorRootNode(ydoc.getXmlFragment(FRAGMENT), schema);
  const document = page();
  const div = document.createElement('div');
  div.appendChild(DOMSerializer.fromSchema(schema).serializeFragment(node.content, { document }));
  return div.innerHTML;
}
