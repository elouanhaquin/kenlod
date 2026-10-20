// Document schema shared by the browser editor and the server (HTML snapshots, migration).
// Any change here must stay backward compatible with stored documents.
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import Link from '@tiptap/extension-link';
import TextAlign from '@tiptap/extension-text-align';
import TextStyle from '@tiptap/extension-text-style';
import Color from '@tiptap/extension-color';
import Highlight from '@tiptap/extension-highlight';
import FontFamily from '@tiptap/extension-font-family';
import Table from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableHeader from '@tiptap/extension-table-header';
import TableCell from '@tiptap/extension-table-cell';
import Image from '@tiptap/extension-image';

// Fonts available on every system: no web font is loaded (privacy, CSP).
export const FONTS = [
  ['', 'Police par défaut'],
  ['Georgia, serif', 'Georgia'],
  ['"Times New Roman", Times, serif', 'Times New Roman'],
  ['Arial, Helvetica, sans-serif', 'Arial'],
  ['Verdana, Geneva, sans-serif', 'Verdana'],
  ['"Trebuchet MS", sans-serif', 'Trebuchet MS'],
  ['system-ui, sans-serif', 'Système'],
  ['"Courier New", Courier, monospace', 'Courier New'],
  ['"Comic Sans MS", "Comic Sans", cursive', 'Comic Sans MS'],
];

// Images inside documents are only ever served by Kenlod itself.
export const DOC_IMAGE_SRC = /^\/api\/items\/[\w-]+\/images\/[\w-]+$/;

export function docExtensions({ collaborative = true } = {}) {
  return [
    // Undo history comes from Yjs when editing collaboratively.
    StarterKit.configure(collaborative ? { history: false } : {}),
    Underline,
    Link.configure({ openOnClick: false, autolink: true, protocols: ['mailto', 'tel'], HTMLAttributes: { rel: 'noopener noreferrer nofollow', target: '_blank' } }),
    TextAlign.configure({ types: ['heading', 'paragraph'] }),
    TextStyle,
    Color,
    FontFamily,
    Highlight.configure({ multicolor: true }),
    Table.configure({ resizable: true }),
    TableRow,
    TableHeader,
    TableCell,
    Image.configure({ inline: false, allowBase64: false }),
  ];
}
