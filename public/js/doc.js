import { h, clear, icon, showMenu, promptDialog, toast, toastError, colorFor } from './ui.js';
import { state, setCleanup } from './state.js';
import { getCsrf } from './api.js';
import { loadEditable, editorTop, connectRoom } from './editor-common.js';

const BLOCKS = [['p', 'Texte normal'], ['h1', 'Titre 1'], ['h2', 'Titre 2'], ['h3', 'Titre 3'], ['blockquote', 'Citation'], ['pre', 'Code']];
const IMAGE_TYPES = /^image\/(png|jpeg|gif|webp)$/;

async function uploadImage(itemId, file) {
  const fd = new FormData();
  fd.append('file', file);
  const res = await fetch(`/api/items/${itemId}/images`, {
    method: 'POST', body: fd, credentials: 'same-origin', headers: { 'X-Kenlod': '1', 'X-CSRF': getCsrf() },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Erreur ${res.status}`);
  return data.src;
}

export async function renderDoc(app, id) {
  const data = await loadEditable(app, id);
  if (!data) return;
  const item = data.item;
  const page = h('div', { class: 'page' });
  const { bar, status, presence, canEdit } = editorTop(item, {
    extra: [h('button', { class: 'icon-btn', title: 'Télécharger', onclick: (e) => exportMenu(e.currentTarget) }, icon('download'))],
    onPrint: () => window.print(),
  });
  const toolbarSlot = h('div');
  clear(app, h('div', { class: 'editor-shell' },
    bar, toolbarSlot,
    h('div', { class: 'doc-scroll', onclick: (e) => { if (e.target.classList.contains('doc-scroll')) editor?.commands.focus('end'); } }, page)));

  let editor = null;
  const room = await connectRoom(item, { statusEl: status, presenceEl: presence, onRevoked: () => editor?.setEditable(false) });
  const { C, ydoc, provider } = room;
  const me = state.me.user;

  const insertImages = async (files) => {
    for (const file of files) {
      if (!IMAGE_TYPES.test(file.type)) { toast('Formats acceptés : PNG, JPEG, GIF, WebP', { error: true }); continue; }
      try {
        toast('Envoi de l’image…', { duration: 1500 });
        const src = await uploadImage(item.id, file);
        editor.chain().focus().setImage({ src, alt: file.name }).run();
      } catch (err) { toastError(err); }
    }
  };

  editor = new C.Editor({
    element: page,
    editable: canEdit,
    extensions: [
      ...C.docExtensions(),
      C.Collaboration.configure({ document: ydoc, field: 'default' }),
      C.CollaborationCursor.configure({ provider, user: { name: me.name, color: colorFor(me.id) } }),
      C.Placeholder.configure({ placeholder: canEdit ? 'Commencez à écrire…' : '' }),
    ],
    editorProps: {
      attributes: { spellcheck: 'true', lang: 'fr' },
      handlePaste: (_view, event) => {
        const files = [...(event.clipboardData?.files || [])].filter((f) => IMAGE_TYPES.test(f.type));
        if (!files.length || !canEdit) return false;
        insertImages(files);
        return true;
      },
      handleDrop: (_view, event) => {
        const files = [...(event.dataTransfer?.files || [])].filter((f) => f.type.startsWith('image/'));
        if (!files.length || !canEdit) return false;
        event.preventDefault();
        insertImages(files);
        return true;
      },
      handleClickOn: (_view, _pos, node, _nodePos, event) => {
        const a = event.target.closest?.('a[href]');
        if (a && (!editor.isEditable || event.ctrlKey || event.metaKey)) { window.open(a.href, '_blank', 'noopener'); return true; }
        return false;
      },
    },
  });

  setCleanup(() => {
    editor.destroy();
    room.destroy();
  });

  // ---- Toolbar ----
  const cmd =(fn) => () => { fn(editor.chain().focus()).run(); };
  const btn = (ic, title, run, isActive) => {
    const b = h('button', { class: 'icon-btn', title, 'aria-label': title, onmousedown: (e) => e.preventDefault(), onclick: run }, icon(ic));
    if (isActive) b._active = isActive;
    return b;
  };
  const blockSelect = h('select', {
    title: 'Style de paragraphe',
    onchange: () => {
      const v = blockSelect.value;
      const c = editor.chain().focus();
      if (v === 'p') c.setParagraph().run();
      else if (v === 'blockquote') c.toggleBlockquote().run();
      else if (v === 'pre') c.toggleCodeBlock().run();
      else c.setHeading({ level: Number(v[1]) }).run();
    },
  }, BLOCKS.map(([v, l]) => h('option', { value: v }, l)));
  const fontSelect = h('select', {
    title: 'Police',
    onchange: () => {
      const v = fontSelect.value;
      if (v) editor.chain().focus().setFontFamily(v).run();
      else editor.chain().focus().unsetFontFamily().run();
    },
  }, C.FONTS.map(([v, l]) => h('option', { value: v, style: v ? { fontFamily: v } : {} }, l)));
  const color = h('input', { type: 'color', value: '#1d2433', title: 'Couleur du texte', oninput: () => editor.chain().focus().setColor(color.value).run() });

  async function addLink() {
    const prev = editor.getAttributes('link').href || 'https://';
    const url = await promptDialog({ title: 'Lien', value: prev, label: 'Adresse du lien (vide pour retirer)', confirm: 'Appliquer' });
    if (url === null) return;
    if (!url.trim() || url === 'https://') return editor.chain().focus().extendMarkRange('link').unsetLink().run();
    if (!/^(https?:\/\/|mailto:|tel:)/i.test(url)) return toast('Le lien doit commencer par https://, mailto: ou tel:', { error: true });
    if (editor.state.selection.empty && !editor.isActive('link')) {
      editor.chain().focus().insertContent({ type: 'text', text: url, marks: [{ type: 'link', attrs: { href: url } }] }).run();
    } else editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
  }

  function tableMenu(at) {
    const inTable = editor.isActive('table');
    const c = () => editor.chain().focus();
    showMenu(inTable ? [
      { label: 'Ligne au-dessus', icon: 'rowPlus', run: () => c().addRowBefore().run() },
      { label: 'Ligne en dessous', icon: 'rowPlus', run: () => c().addRowAfter().run() },
      { label: 'Colonne à gauche', icon: 'colPlus', run: () => c().addColumnBefore().run() },
      { label: 'Colonne à droite', icon: 'colPlus', run: () => c().addColumnAfter().run() },
      'sep',
      { label: 'Fusionner / séparer les cellules', icon: 'grid', run: () => c().mergeOrSplit().run() },
      { label: 'Ligne d’en-tête oui/non', icon: 'bold', run: () => c().toggleHeaderRow().run() },
      'sep',
      { label: 'Supprimer la ligne', icon: 'close', run: () => c().deleteRow().run() },
      { label: 'Supprimer la colonne', icon: 'close', run: () => c().deleteColumn().run() },
      { label: 'Supprimer le tableau', icon: 'trash', danger: true, run: () => c().deleteTable().run() },
    ] : [
      { label: 'Tableau 2 × 2', icon: 'grid', run: () => c().insertTable({ rows: 2, cols: 2, withHeaderRow: true }).run() },
      { label: 'Tableau 3 × 3', icon: 'grid', run: () => c().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
      { label: 'Tableau 4 × 5', icon: 'grid', run: () => c().insertTable({ rows: 5, cols: 4, withHeaderRow: true }).run() },
    ], at);
  }

  function pickImage() {
    const input = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp', multiple: true, style: { display: 'none' } });
    input.addEventListener('change', () => { insertImages([...input.files]); input.remove(); });
    document.body.append(input);
    input.click();
  }

  const toggles = [
    btn('bold', 'Gras (Ctrl+B)', cmd((c) => c.toggleBold()), () => editor.isActive('bold')),
    btn('italic', 'Italique (Ctrl+I)', cmd((c) => c.toggleItalic()), () => editor.isActive('italic')),
    btn('underline', 'Souligné (Ctrl+U)', cmd((c) => c.toggleUnderline()), () => editor.isActive('underline')),
    btn('strike', 'Barré', cmd((c) => c.toggleStrike()), () => editor.isActive('strike')),
  ];
  const highlight = btn('edit', 'Surligner', cmd((c) => c.toggleHighlight({ color: '#fff3a3' })), () => editor.isActive('highlight'));
  const lists = [
    btn('ul', 'Liste à puces', cmd((c) => c.toggleBulletList()), () => editor.isActive('bulletList')),
    btn('ol', 'Liste numérotée', cmd((c) => c.toggleOrderedList()), () => editor.isActive('orderedList')),
  ];
  const aligns = [
    btn('alignL', 'Aligner à gauche', cmd((c) => c.setTextAlign('left')), () => editor.isActive({ textAlign: 'left' })),
    btn('alignC', 'Centrer', cmd((c) => c.setTextAlign('center')), () => editor.isActive({ textAlign: 'center' })),
    btn('alignR', 'Aligner à droite', cmd((c) => c.setTextAlign('right')), () => editor.isActive({ textAlign: 'right' })),
    btn('alignJ', 'Justifier', cmd((c) => c.setTextAlign('justify')), () => editor.isActive({ textAlign: 'justify' })),
  ];
  const linkBtn = btn('link', 'Lien (Ctrl+K)', addLink, () => editor.isActive('link'));
  const tableBtn = btn('table', 'Tableau', (e) => tableMenu(e.currentTarget), () => editor.isActive('table'));
  const all = [...toggles, highlight, ...lists, ...aligns, linkBtn, tableBtn];

  const toolbar = h('div', { class: 'format-bar', role: 'toolbar', 'aria-label': 'Mise en forme' },
    btn('undo', 'Annuler (Ctrl+Z)', cmd((c) => c.undo())), btn('redo', 'Rétablir (Ctrl+Y)', cmd((c) => c.redo())),
    h('span', { class: 'sep' }), blockSelect, fontSelect, h('span', { class: 'sep' }),
    toggles, color, highlight,
    h('span', { class: 'sep' }), linkBtn, btn('image', 'Insérer une image', pickImage), tableBtn,
    h('span', { class: 'sep' }), lists, aligns,
    btn('hr', 'Ligne horizontale', cmd((c) => c.setHorizontalRule())),
    h('span', { class: 'sep' }),
    btn('eraser', 'Effacer la mise en forme', cmd((c) => c.unsetAllMarks().clearNodes())));
  if (canEdit) clear(toolbarSlot, toolbar);

  const refresh = () => {
    if (!canEdit) return;
    for (const b of all) b.classList.toggle('on', !!b._active?.());
    const level = [1, 2, 3].find((l) => editor.isActive('heading', { level: l }));
    blockSelect.value = level ? `h${level}` : editor.isActive('blockquote') ? 'blockquote' : editor.isActive('codeBlock') ? 'pre' : 'p';
    const font = editor.getAttributes('textStyle').fontFamily || '';
    fontSelect.value = C.FONTS.some(([v]) => v === font) ? font : '';
  };
  editor.on('selectionUpdate', refresh);
  editor.on('transaction', refresh);

  page.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); toast('Pas besoin : tout est enregistré automatiquement', { duration: 2000 }); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); addLink(); }
  });

  function download(name, body, type) {
    const a = h('a', { href: URL.createObjectURL(new Blob([body], { type })), download: name });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  function exportMenu(at) {
    showMenu([
      {
        label: 'Page web (.html)', icon: 'download',
        run: () => download(`${item.name}.html`, `<!doctype html><html lang="fr"><meta charset="utf-8"><title>${item.name.replace(/[<&]/g, '')}</title>`
          + '<style>body{font:16px/1.6 Georgia,serif;max-width:760px;margin:40px auto;padding:0 20px;color:#1d2433}table{border-collapse:collapse}td,th{border:1px solid #c9d3e6;padding:4px 8px}img{max-width:100%}</style>'
          + `<body>${editor.getHTML()}</body></html>`, 'text/html'),
      },
      { label: 'Texte brut (.txt)', icon: 'download', run: () => download(`${item.name}.txt`, editor.getText({ blockSeparator: '\n\n' }), 'text/plain;charset=utf-8') },
      { label: 'PDF (via Imprimer)', icon: 'print', run: () => window.print() },
    ], at);
  }

  await room.synced;
  if (canEdit && editor.isEmpty && !editor.isDestroyed) editor.commands.focus('end');
}
