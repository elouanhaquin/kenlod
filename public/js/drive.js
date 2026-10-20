import { get, post, patch, put, del } from './api.js';
import {
  h, clear, icon, fileIcon, typeOf, avatar, formatBytes, formatDate, formatFull, timeAgo, ROLE_LABEL,
  showMenu, toast, toastError, confirmDialog, promptDialog,
} from './ui.js';
import { state, on, navigate, atLeast, canDelete, openItemPath, spaceLabel, refreshStorage } from './state.js';
import { openShare } from './share.js';
import { openMove } from './move.js';
import { openPreview } from './preview.js';
import { uploadEntries, entriesFromDataTransfer, openNewMenu } from './uploads.js';

const TITLES = {
  shared: 'Partagés avec moi', recent: 'Récents', starred: 'Favoris', trash: 'Corbeille', search: 'Résultats de recherche',
};

const EMPTY = {
  folder: ['Ce dossier est vide', 'Glissez-déposez des fichiers ici, ou utilisez le bouton « Nouveau ».', 'folder'],
  root: ['Bienvenue dans votre espace', 'Importez vos premiers fichiers ou créez un document. Ils ne sont visibles que par vous tant que vous ne les partagez pas.', 'upload'],
  shared: ['Rien de partagé pour l’instant', 'Les fichiers et dossiers que d’autres membres partagent avec vous apparaîtront ici.', 'share'],
  recent: ['Aucun fichier récent', 'Les fichiers que vous ouvrez ou modifiez apparaîtront ici.', 'clock'],
  starred: ['Aucun favori', 'Ajoutez des éléments aux favoris pour les retrouver rapidement.', 'star'],
  trash: ['La corbeille est vide', 'Les éléments supprimés y restent 30 jours avant d’être effacés définitivement.', 'trash'],
  search: ['Aucun résultat', 'Essayez avec d’autres mots-clés.', 'search'],
};

const ACTIONS = {
  create: 'a créé', upload: 'a importé', rename: 'a renommé', move: 'a déplacé vers', share: 'a partagé avec',
  unshare: 'a retiré un accès', link: 'a créé un lien public', trash: 'a mis à la corbeille', restore: 'a restauré',
  edit: 'a modifié', copy: 'a copié depuis',
};
export const actionLabel = (a) => `${ACTIONS[a.action] || a.action}${a.detail ? ` ${a.detail}` : ''}`;

const pref = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
const setPref = (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };
const coarse = matchMedia('(pointer: coarse)');
const collator = new Intl.Collator('fr', { numeric: true, sensitivity: 'base' });

export function rememberBack() {
  sessionStorage.setItem('kl_back', location.pathname + location.search);
}

export function openItem(item, siblings = []) {
  const path = openItemPath(item);
  if (path) {
    if (item.kind !== 'folder') rememberBack();
    return navigate(path);
  }
  const files = siblings.filter((i) => i.kind === 'file');
  openPreview(files.length ? files : [item], Math.max(0, files.findIndex((i) => i.id === item.id)), {
    url: (it, inline) => `/api/items/${it.id}/download${inline ? '?inline=1' : ''}`,
    onShare: atLeast(item.role, 'editor') ? (it) => openShare(it) : null,
  });
}

export function download(items) {
  items.filter((i) => i.kind === 'file').forEach((item, n) => {
    setTimeout(() => {
      const a = h('a', { href: `/api/items/${item.id}/download`, download: item.name });
      document.body.append(a);
      a.click();
      a.remove();
    }, n * 350);
  });
}

export class DriveView {
  constructor(container, ctx) {
    this.ctx = ctx;
    this.root = h('div', { class: 'drive' });
    clear(container, this.root);
    this.items = [];
    this.selected = new Set();
    this.anchor = null;
    this.layout = pref('kl_layout', 'list');
    this.showDetails = pref('kl_details', '0') === '1' && innerWidth > 1100;
    this.sort = ['recent', 'search'].includes(ctx.mode) ? { key: 'none', dir: 1 } : JSON.parse(pref('kl_sort', '{"key":"name","dir":1}'));
    if (ctx.mode === 'trash') this.sort = { key: 'trashedAt', dir: -1 };
    this.alive = true;
    this.onKey = (e) => this.handleKey(e);
    document.addEventListener('keydown', this.onKey);
    this.off = on('changed', () => this.reload());
  }

  destroy() {
    this.alive = false;
    document.removeEventListener('keydown', this.onKey);
    this.off();
  }

  get folder() { return this.data?.folder || null; }
  get canWrite() { return this.ctx.mode === 'folder' && atLeast(this.role, 'editor'); }
  get target() {
    if (this.ctx.mode !== 'folder') return { space: 'me' };
    return this.folder ? { parentId: this.folder.id, space: this.folder.space } : { space: this.ctx.space };
  }

  reload() {
    clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => this.alive && this.load(), 200);
  }

  async load() {
    const { mode, folderId, space, q } = this.ctx;
    try {
      let data;
      if (mode === 'folder') data = await get(folderId ? `/api/folder?id=${encodeURIComponent(folderId)}` : `/api/folder?space=${encodeURIComponent(space)}`);
      else if (mode === 'search') data = await get(`/api/search?q=${encodeURIComponent(q)}`);
      else data = await get(`/api/${mode}`);
      if (!this.alive) return;
      this.data = data;
      this.items = data.items;
      this.role = data.role;
      const ids = new Set(this.items.map((i) => i.id));
      for (const id of this.selected) if (!ids.has(id)) this.selected.delete(id);
      if (this.folder) document.title = `${this.folder.name} — Kenlod`;
      else document.title = `${TITLES[mode] || data.root?.name || 'Mon espace'} — Kenlod`;
      this.render();
    } catch (err) {
      if (!this.alive) return;
      if (err.status === 404 || err.status === 403) {
        clear(this.root, h('div', { class: 'empty' },
          icon('folder', 'big'), h('h3', {}, 'Introuvable'),
          h('p', {}, 'Ce dossier n’existe pas ou vous n’y avez pas accès.'),
          h('a', { class: 'btn', href: '/drive', dataset: { link: '' } }, 'Retour à mon espace')));
      } else toastError(err);
    }
  }

  // ---------- Rendering ----------

  sorted() {
    const { key, dir } = this.sort;
    const items = [...this.items];
    if (key === 'none') return items;
    const val = (i) => (key === 'name' ? i.name : key === 'size' ? i.size : key === 'owner' ? i.ownerName || '' : i[key] || 0);
    items.sort((a, b) => {
      if ((a.kind === 'folder') !== (b.kind === 'folder')) return a.kind === 'folder' ? -1 : 1;
      const va = val(a);
      const vb = val(b);
      const c = typeof va === 'string' ? collator.compare(va, vb) : va - vb;
      return c * dir || collator.compare(a.name, b.name);
    });
    return items;
  }

  render() {
    this.order = this.sorted();
    this.toolbarSlot = h('div');
    this.detailsSlot = h('aside', { class: 'details', hidden: !this.showDetails });
    this.content = h('div', {
      class: 'content',
      onclick: (e) => { if (e.target === this.content || e.target.classList.contains('grid') || e.target.classList.contains('section-label')) this.select([]); },
      oncontextmenu: (e) => {
        if (e.target.closest('.item') || !this.canWrite) return;
        e.preventDefault();
        openNewMenu({ x: e.clientX, y: e.clientY });
      },
    }, this.renderItems());
    if (this.canWrite) this.setupDropZone(this.content);

    const main = h('div', { style: 'display:flex;flex-direction:column;min-height:0;min-width:0;flex:1' }, this.toolbarSlot, this.content);
    clear(this.root,
      this.renderHead(),
      h('div', { class: 'with-details', style: this.showDetails ? '' : 'grid-template-columns:1fr' }, main, this.detailsSlot));
    this.updateSelection();
  }

  renderHead() {
    const { mode } = this.ctx;
    let title;
    if (mode === 'folder') {
      const { root, crumbs } = this.data;
      const rootPath = root.kind === 'shared' ? '/partages' : root.kind === 'group' ? `/groupe/${root.groupId}` : root.id === 'me' ? '/drive' : null;
      const parts = [{ name: root.name, path: rootPath, id: null }, ...crumbs.map((c) => ({ name: c.name, path: `/dossier/${c.id}`, id: c.id }))];
      title = h('div', { class: 'crumbs' }, parts.map((p, i) => {
        const last = i === parts.length - 1;
        return [
          i > 0 ? icon('chevron', 'sep') : null,
          h('button', {
            title: p.name,
            onclick: (e) => {
              if (!last) return p.path && navigate(p.path);
              if (this.folder) this.showItemMenu([this.folder], e.currentTarget, true);
              else if (this.canWrite) openNewMenu(e.currentTarget);
            },
          }, p.name),
        ];
      }));
    } else if (mode === 'search') {
      title = h('div', { class: 'crumbs' }, h('button', {}, `Résultats pour « ${this.ctx.q} »`));
    } else {
      title = h('div', { class: 'crumbs' }, h('button', {}, TITLES[mode]));
    }
    const tools = h('div', { class: 'view-tools' },
      mode === 'trash' && this.items.some((i) => i.space === `u:${state.me.user.id}`)
        ? h('button', { class: 'btn small ghost', onclick: () => this.emptyTrash() }, 'Vider la corbeille') : null,
      h('button', {
        class: 'icon-btn', title: this.layout === 'list' ? 'Affichage en grille' : 'Affichage en liste',
        onclick: () => { this.layout = this.layout === 'list' ? 'grid' : 'list'; setPref('kl_layout', this.layout); this.render(); },
      }, icon(this.layout === 'list' ? 'grid' : 'list')),
      h('button', {
        class: 'icon-btn', title: 'Détails', 'aria-pressed': String(this.showDetails),
        onclick: () => this.toggleDetails(),
      }, icon('info')));
    return h('div', { class: 'main-head' }, title, tools);
  }

  toggleDetails(force) {
    this.showDetails = force ?? !this.showDetails;
    setPref('kl_details', this.showDetails ? '1' : '0');
    this.render();
  }

  renderItems() {
    const { mode } = this.ctx;
    if (!this.items.length) {
      const [title, text, ic] = EMPTY[mode === 'folder' && !this.folder ? 'root' : mode];
      return h('div', { class: 'empty' },
        icon(ic, 'big'), h('h3', {}, title), h('p', {}, text),
        this.canWrite ? h('button', { class: 'btn primary', onclick: (e) => openNewMenu(e.currentTarget) }, icon('plus'), 'Nouveau') : null);
    }
    const nodes = [];
    if (mode === 'trash') {
      nodes.push(h('p', { class: 'muted small-text', style: 'margin:0 4px 10px' },
        `Les éléments de la corbeille sont supprimés définitivement après ${this.data.trashDays} jours.`));
    }
    nodes.push(this.layout === 'grid' ? this.renderGrid() : this.renderList());
    return nodes;
  }

  renderList() {
    const { mode } = this.ctx;
    const dateKey = mode === 'trash' ? 'trashedAt' : 'updatedAt';
    const th = (key, label, cls) => {
      const active = this.sort.key === key;
      return h('th', {
        class: cls,
        onclick: () => {
          this.sort = { key, dir: active ? -this.sort.dir : key === 'name' || key === 'owner' ? 1 : -1 };
          if (mode !== 'trash') setPref('kl_sort', JSON.stringify(this.sort));
          this.render();
        },
      }, label, active ? icon(this.sort.dir > 0 ? 'arrowUp' : 'arrowDown', 'arrow') : null);
    };
    const rows = this.order.map((item) => {
      const tr = h('tr', { class: 'item', tabindex: '-1', dataset: { id: item.id } },
        h('td', { class: 'name' }, h('div', { class: 'cell' },
          fileIcon(item),
          h('span', { class: 'nm', title: item.name }, item.name),
          h('span', { class: 'badges' },
            item.shared ? h('span', { title: 'Partagé' }, icon('users')) : null,
            item.starred ? h('span', { title: 'Favori' }, icon('star')) : null))),
        h('td', { class: 'owner' }, this.ownerLabel(item)),
        h('td', { class: 'date', title: formatFull(item[dateKey]) }, formatDate(item[dateKey]),
          mode !== 'trash' && item.updatedByName ? h('span', { class: 'muted' }, ` · ${item.updatedByName}`) : null),
        h('td', { class: 'size' }, item.kind === 'folder' ? '—' : formatBytes(item.size)),
        h('td', { class: 'actions' },
          mode !== 'trash' && atLeast(item.role, 'editor')
            ? h('button', { class: 'icon-btn small', title: 'Partager', onclick: (e) => { e.stopPropagation(); this.share(item); } }, icon('share')) : null,
          h('button', {
            class: 'icon-btn small', title: 'Plus d’actions', 'aria-label': 'Plus d’actions',
            onclick: (e) => { e.stopPropagation(); if (!this.selected.has(item.id)) this.select([item.id]); this.showItemMenu(this.selectedItems(), e.currentTarget); },
          }, icon('more'))));
      this.bindItem(tr, item);
      return tr;
    });
    return h('table', { class: 'list' },
      h('colgroup', {}, h('col'), h('col', { class: 'col-owner' }), h('col', { class: 'col-date' }), h('col', { class: 'col-size' }), h('col', { class: 'col-act' })),
      h('thead', {}, h('tr', {},
        th('name', 'Nom'),
        th('owner', mode === 'shared' ? 'Partagé par' : 'Propriétaire', 'owner'),
        th(dateKey, mode === 'trash' ? 'Supprimé le' : 'Modifié', 'date'),
        th('size', 'Taille', 'size'),
        h('th', {}))),
      h('tbody', {}, rows));
  }

  ownerLabel(item) {
    if (item.ownerId === state.me.user.id) return 'moi';
    return item.ownerName || '—';
  }

  renderGrid() {
    const folders = this.order.filter((i) => i.kind === 'folder');
    const files = this.order.filter((i) => i.kind !== 'folder');
    const out = [];
    if (folders.length) {
      out.push(h('div', { class: 'section-label' }, 'Dossiers'));
      out.push(h('div', { class: 'grid folders' }, folders.map((item) => {
        const card = h('div', { class: 'card folder item', tabindex: '-1', dataset: { id: item.id } },
          h('div', { class: 'top' }, fileIcon(item), h('span', { class: 'nm', title: item.name }, item.name),
            item.shared ? h('span', { class: 'muted', title: 'Partagé' }, icon('users')) : null,
            this.moreButton(item)));
        this.bindItem(card, item);
        return card;
      })));
    }
    if (files.length) {
      out.push(h('div', { class: 'section-label' }, 'Fichiers'));
      out.push(h('div', { class: 'grid' }, files.map((item) => {
        const isImage = item.kind === 'file' && /^image\/(png|jpeg|gif|webp|avif|bmp)$/.test(item.mime) && item.size < 15e6;
        const thumb = h('div', { class: 'thumb' }, isImage
          ? h('img', { src: `/api/items/${item.id}/download?inline=1`, alt: '', loading: 'lazy', draggable: 'false' })
          : fileIcon(item, 56));
        const card = h('div', { class: 'card item', tabindex: '-1', dataset: { id: item.id } },
          h('div', { class: 'top' }, fileIcon(item, 20), h('span', { class: 'nm', title: item.name }, item.name), this.moreButton(item)),
          thumb,
          h('div', { class: 'meta' }, `${item.shared ? 'Partagé · ' : ''}${formatDate(item.updatedAt)}${item.kind === 'file' ? ` · ${formatBytes(item.size)}` : ''}`));
        this.bindItem(card, item);
        return card;
      })));
    }
    return out;
  }

  moreButton(item) {
    return h('button', {
      class: 'icon-btn small', title: 'Plus d’actions',
      onclick: (e) => { e.stopPropagation(); if (!this.selected.has(item.id)) this.select([item.id]); this.showItemMenu(this.selectedItems(), e.currentTarget); },
    }, icon('more'));
  }

  bindItem(el, item) {
    el.addEventListener('click', (e) => this.onItemClick(e, item));
    el.addEventListener('dblclick', () => this.ctx.mode !== 'trash' && openItem(item, this.order));
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (!this.selected.has(item.id)) this.select([item.id]);
      this.showItemMenu(this.selectedItems(), { x: e.clientX, y: e.clientY });
    });
    if (this.ctx.mode === 'trash') return;
    if (atLeast(item.role, 'editor')) {
      el.draggable = true;
      el.addEventListener('dragstart', (e) => {
        if (!this.selected.has(item.id)) this.select([item.id]);
        e.dataTransfer.setData('application/x-kenlod', JSON.stringify([...this.selected]));
        e.dataTransfer.effectAllowed = 'move';
      });
    }
    if (item.kind === 'folder' && atLeast(item.role, 'editor')) {
      el.addEventListener('dragover', (e) => {
        const types = e.dataTransfer.types;
        if (types.includes('application/x-kenlod') || types.includes('Files')) {
          e.preventDefault();
          e.stopPropagation();
          el.classList.add('drop-target');
        }
      });
      el.addEventListener('dragleave', () => el.classList.remove('drop-target'));
      el.addEventListener('drop', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        el.classList.remove('drop-target');
        this.content.classList.remove('dragover');
        const raw = e.dataTransfer.getData('application/x-kenlod');
        if (raw) {
          const ids = JSON.parse(raw).filter((id) => id !== item.id);
          await this.moveTo(ids, item);
        } else {
          uploadEntries(await entriesFromDataTransfer(e.dataTransfer), { parentId: item.id, space: item.space });
        }
      });
    }
  }

  setupDropZone(el) {
    let depth = 0;
    el.addEventListener('dragenter', (e) => {
      if (!e.dataTransfer.types.includes('Files')) return;
      depth++;
      el.classList.add('dragover');
    });
    el.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; el.classList.remove('dragover'); } });
    el.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); });
    el.addEventListener('drop', async (e) => {
      if (!e.dataTransfer.types.includes('Files')) return;
      e.preventDefault();
      depth = 0;
      el.classList.remove('dragover');
      uploadEntries(await entriesFromDataTransfer(e.dataTransfer), this.target);
    });
  }

  // ---------- Selection ----------

  onItemClick(e, item) {
    if (coarse.matches && !e.ctrlKey && !e.metaKey && !this.selected.size && this.ctx.mode !== 'trash') return openItem(item, this.order);
    if (e.shiftKey && this.anchor) {
      const ids = this.order.map((i) => i.id);
      const [a, b] = [ids.indexOf(this.anchor), ids.indexOf(item.id)].sort((x, y) => x - y);
      this.select(ids.slice(a, b + 1), false);
    } else if (e.ctrlKey || e.metaKey || (coarse.matches && this.selected.size)) {
      const next = new Set(this.selected);
      next.has(item.id) ? next.delete(item.id) : next.add(item.id);
      this.anchor = item.id;
      this.select([...next], false);
    } else {
      this.anchor = item.id;
      this.select([item.id], false);
    }
  }

  select(ids, resetAnchor = true) {
    this.selected = new Set(ids);
    if (resetAnchor) this.anchor = ids[0] || null;
    this.updateSelection();
  }

  selectedItems() {
    return this.order.filter((i) => this.selected.has(i.id));
  }

  updateSelection() {
    for (const el of this.root.querySelectorAll('.item')) el.classList.toggle('selected', this.selected.has(el.dataset.id));
    const items = this.selectedItems();
    clear(this.toolbarSlot, items.length ? this.renderToolbar(items) : null);
    if (this.showDetails) this.renderDetails(items.length === 1 ? items[0] : items.length ? null : this.folder);
  }

  renderToolbar(items) {
    const single = items.length === 1 ? items[0] : null;
    const btn = (ic, title, run) => h('button', { class: 'icon-btn', title, 'aria-label': title, onclick: run }, icon(ic));
    const canEdit = items.every((i) => atLeast(i.role, 'editor'));
    const tools = this.ctx.mode === 'trash'
      ? [btn('restore', 'Restaurer', () => this.restore(items)), btn('trash', 'Supprimer définitivement', () => this.deleteForever(items))]
      : [
        single && canEdit ? btn('share', 'Partager', () => this.share(single)) : null,
        items.some((i) => i.kind === 'file') ? btn('download', 'Télécharger', () => download(items)) : null,
        canEdit ? btn('move', 'Déplacer', () => this.move(items)) : null,
        items.every(canDelete) ? btn('trash', 'Mettre à la corbeille', () => this.trash(items)) : null,
        btn('info', 'Détails', () => this.toggleDetails(true)),
        h('button', { class: 'icon-btn', title: 'Plus d’actions', onclick: (e) => this.showItemMenu(items, e.currentTarget) }, icon('more')),
      ];
    return h('div', { class: 'toolbar' },
      h('button', { class: 'icon-btn small', title: 'Désélectionner', onclick: () => this.select([]) }, icon('close')),
      h('span', { class: 'count' }, items.length === 1 ? '1 élément sélectionné' : `${items.length} éléments sélectionnés`),
      tools);
  }

  handleKey(e) {
    if (e.target.closest('input, textarea, select, [contenteditable="true"]') || document.querySelector('.overlay, .viewer, .menu')) return;
    const items = this.selectedItems();
    if (e.key === 'Escape') this.select([]);
    else if ((e.ctrlKey || e.metaKey) && e.key === 'a') { e.preventDefault(); this.select(this.order.map((i) => i.id)); }
    else if (!items.length) return;
    else if ((e.key === 'Delete' || e.key === 'Backspace') && this.ctx.mode !== 'trash' && items.every(canDelete)) { e.preventDefault(); this.trash(items); }
    else if (e.key === 'F2' && items.length === 1 && atLeast(items[0].role, 'editor')) { e.preventDefault(); this.rename(items[0]); }
    else if (e.key === 'Enter' && items.length === 1 && this.ctx.mode !== 'trash') openItem(items[0], this.order);
  }

  // ---------- Menus & actions ----------

  showItemMenu(items, at, isCurrentFolder = false) {
    if (!items.length) return;
    const single = items.length === 1 ? items[0] : null;
    if (this.ctx.mode === 'trash' && !isCurrentFolder) {
      return showMenu([
        { label: 'Restaurer', icon: 'restore', run: () => this.restore(items) },
        { label: 'Supprimer définitivement', icon: 'trash', danger: true, run: () => this.deleteForever(items) },
      ], at);
    }
    const canEdit = items.every((i) => atLeast(i.role, 'editor'));
    const allStarred = items.every((i) => i.starred);
    const entries = [
      single && !isCurrentFolder ? { label: 'Ouvrir', icon: 'eye', run: () => openItem(single, this.order) } : null,
      isCurrentFolder && this.canWrite ? { label: 'Nouveau…', icon: 'plus', run: () => openNewMenu(at) } : null,
      items.some((i) => i.kind === 'file') ? { label: 'Télécharger', icon: 'download', run: () => download(items) } : null,
      'sep',
      single && canEdit ? { label: 'Partager', icon: 'share', run: () => this.share(single) } : null,
      single && canEdit ? { label: 'Obtenir un lien public', icon: 'link', run: () => this.share(single, true) } : null,
      single && canEdit ? { label: 'Renommer', icon: 'edit', run: () => this.rename(single), hint: 'F2' } : null,
      canEdit && !isCurrentFolder ? { label: 'Déplacer', icon: 'move', run: () => this.move(items) } : null,
      single && single.kind !== 'folder' ? { label: 'Créer une copie', icon: 'copy', run: () => this.copy(single) } : null,
      { label: allStarred ? 'Retirer des favoris' : 'Ajouter aux favoris', icon: 'star', run: () => this.star(items, !allStarred) },
      single ? { label: 'Détails et activité', icon: 'info', run: () => { if (isCurrentFolder) this.select([]); this.toggleDetails(true); } } : null,
      items.every(canDelete) ? 'sep' : null,
      items.every(canDelete) ? { label: 'Mettre à la corbeille', icon: 'trash', danger: true, run: () => this.trash(items, isCurrentFolder), hint: 'Suppr' } : null,
    ].filter(Boolean);
    // Collapse leading / duplicated separators.
    const clean = entries.filter((e, i, arr) => e !== 'sep' || (i > 0 && arr[i - 1] !== 'sep' && i < arr.length - 1));
    showMenu(clean, at);
  }

  share(item, focusLinks = false) {
    openShare(item, { focusLinks, onChange: () => this.reload() });
  }

  async rename(item) {
    const name = await promptDialog({ title: 'Renommer', value: item.name, confirm: 'Renommer', selectBase: item.kind === 'file' });
    if (!name || name === item.name) return;
    try {
      await patch(`/api/items/${item.id}`, { name });
      this.reload();
    } catch (err) { toastError(err); }
  }

  async move(items) {
    openMove(items, async (target) => this.moveTo(items.map((i) => i.id), target));
  }

  async moveTo(ids, target) {
    if (!ids.length) return;
    try {
      for (const id of ids) await patch(`/api/items/${id}`, { parentId: target ? target.id : null });
      toast(`${ids.length > 1 ? `${ids.length} éléments déplacés` : 'Élément déplacé'} vers « ${target ? target.name : 'la racine'} »`);
    } catch (err) { toastError(err); }
    this.reload();
  }

  async copy(item) {
    try {
      const { item: copy } = await post(`/api/items/${item.id}/copy`);
      toast(`« ${copy.name} » créé`);
      this.reload();
      refreshStorage();
    } catch (err) { toastError(err); }
  }

  async star(items, value) {
    try {
      for (const i of items) await (value ? put(`/api/items/${i.id}/star`) : del(`/api/items/${i.id}/star`));
      this.reload();
    } catch (err) { toastError(err); }
  }

  async trash(items, isCurrentFolder = false) {
    try {
      for (const i of items) await post(`/api/items/${i.id}/trash`);
      toast(items.length > 1 ? `${items.length} éléments mis à la corbeille` : `« ${items[0].name} » mis à la corbeille`, {
        action: {
          label: 'Annuler',
          run: async () => {
            for (const i of items) await post(`/api/items/${i.id}/restore`).catch(toastError);
            if (isCurrentFolder) navigate(`/dossier/${items[0].id}`);
            else this.reload();
          },
        },
        duration: 7000,
      });
      this.selected.clear();
      if (isCurrentFolder) navigate(this.data.crumbs.length > 1 ? `/dossier/${this.data.crumbs.at(-2).id}` : '/drive');
      else this.reload();
    } catch (err) { toastError(err); }
  }

  async restore(items) {
    try {
      for (const i of items) await post(`/api/items/${i.id}/restore`);
      toast(items.length > 1 ? `${items.length} éléments restaurés` : `« ${items[0].name} » restauré`);
      this.reload();
    } catch (err) { toastError(err); }
  }

  async deleteForever(items) {
    const ok = await confirmDialog({
      title: 'Supprimer définitivement ?',
      message: items.length > 1
        ? `${items.length} éléments seront effacés. Cette action est irréversible.`
        : `« ${items[0].name} » sera effacé. Cette action est irréversible.`,
      confirm: 'Supprimer définitivement', danger: true,
    });
    if (!ok) return;
    try {
      for (const i of items) await del(`/api/items/${i.id}`);
      this.reload();
      refreshStorage();
    } catch (err) { toastError(err); }
  }

  async emptyTrash() {
    const ok = await confirmDialog({
      title: 'Vider la corbeille ?',
      message: 'Tous les éléments de votre espace personnel présents dans la corbeille seront effacés définitivement.',
      confirm: 'Vider la corbeille', danger: true,
    });
    if (!ok) return;
    try {
      await post('/api/trash/empty');
      this.reload();
      refreshStorage();
    } catch (err) { toastError(err); }
  }

  // ---------- Details panel ----------

  async renderDetails(item) {
    const slot = this.detailsSlot;
    const token = (this.detailsToken = {});
    const header = (it) => h('div', { class: 'head' },
      it ? fileIcon(it) : icon('info'),
      h('h3', { class: 'grow' }, it ? it.name : this.ctx.mode === 'folder' ? this.data.root.name : TITLES[this.ctx.mode]),
      h('button', { class: 'icon-btn small', title: 'Fermer', onclick: () => this.toggleDetails(false) }, icon('close')));
    if (!item) {
      const n = this.selected.size;
      clear(slot, header(null), h('p', { class: 'muted' }, n
        ? `${n} éléments sélectionnés.`
        : 'Sélectionnez un fichier ou un dossier pour afficher ses détails, les personnes qui y ont accès et son historique.'));
      return;
    }
    clear(slot, header(item), h('p', { class: 'muted' }, 'Chargement…'));
    try {
      const [info, access, act] = await Promise.all([
        get(`/api/items/${item.id}`),
        get(`/api/items/${item.id}/shares`).catch(() => null),
        get(`/api/items/${item.id}/activity`).catch(() => ({ activity: [] })),
      ]);
      if (token !== this.detailsToken) return;
      const it = info.item;
      const isImage = it.kind === 'file' && /^image\/(png|jpeg|gif|webp|avif|bmp)$/.test(it.mime);
      const where = info.location ? info.location.name : info.space ? info.space.name : '—';
      clear(slot,
        header(it),
        h('div', { class: 'preview' }, isImage ? h('img', { src: `/api/items/${it.id}/download?inline=1`, alt: '' }) : fileIcon(it, 64)),
        h('dl', {},
          h('dt', {}, 'Type'), h('dd', {}, it.kind === 'folder' ? 'Dossier' : typeOf(it).name),
          it.kind !== 'folder' ? [h('dt', {}, 'Taille'), h('dd', {}, formatBytes(it.size))] : null,
          h('dt', {}, 'Emplacement'), h('dd', {}, where),
          h('dt', {}, 'Espace'), h('dd', {}, spaceLabel(it.space)),
          h('dt', {}, 'Ajouté par'), h('dd', {}, it.ownerName || '—'),
          h('dt', {}, 'Modifié'), h('dd', {}, formatFull(it.updatedAt), it.updatedByName ? ` par ${it.updatedByName}` : ''),
          h('dt', {}, 'Créé'), h('dd', {}, formatFull(it.createdAt)),
          h('dt', {}, 'Votre rôle'), h('dd', {}, ROLE_LABEL[it.role])),
        access ? [
          h('h4', {}, 'Qui a accès'),
          h('div', { class: 'access-list' },
            access.owner.type === 'group'
              ? h('span', { class: 'pill' }, icon('users'), `Groupe ${access.owner.name}`)
              : h('span', { class: 'pill' }, icon('home'), access.owner.name),
            access.shares.map((s) => h('span', { class: 'pill', title: ROLE_LABEL[s.role] }, s.type === 'group' ? icon('users') : null, s.name)),
            access.links.filter((l) => !l.expired).length ? h('span', { class: 'pill accent' }, icon('link'), 'Lien public') : null),
          atLeast(it.role, 'editor') && this.ctx.mode !== 'trash'
            ? h('button', { class: 'btn small', style: 'margin-top:10px', onclick: () => this.share(it) }, 'Gérer l’accès') : null,
        ] : null,
        h('h4', {}, 'Activité'),
        act.activity.length
          ? h('ul', { class: 'activity' }, act.activity.map((a) => h('li', {},
            avatar(a.userName || '?', { small: true }),
            h('div', {}, h('div', {}, h('b', {}, a.userName || 'Compte supprimé'), ' ', actionLabel(a)), h('div', { class: 'when' }, timeAgo(a.at))))))
          : h('p', { class: 'muted' }, 'Aucune activité enregistrée.'));
    } catch (err) {
      if (token === this.detailsToken) clear(slot, header(item), h('p', { class: 'err' }, err.message));
    }
  }
}
