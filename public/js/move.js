import { get } from './api.js';
import { h, clear, icon, fileIcon, modal } from './ui.js';
import { state, atLeast } from './state.js';

// Folder picker limited to the items' own space. onPick(folder | null for the space root).
export function openMove(items, onPick) {
  const space = items[0].space;
  if (items.some((i) => i.space !== space)) {
    import('./ui.js').then(({ toast }) => toast('Sélectionnez des éléments d’un même espace', { error: true }));
    return;
  }
  const movingIds = new Set(items.map((i) => i.id));
  const spaceParam = space === `u:${state.me.user.id}` ? 'me' : space;
  let current = items[0].parentId ? { id: items[0].parentId } : null;

  modal((box, close) => {
    const crumbs = h('div', { class: 'crumbs', style: 'font-size:15px;margin-bottom:8px' });
    const list = h('div', { style: 'height:300px;overflow:auto;border:1px solid var(--line);border-radius:10px;padding:4px' });
    const moveBtn = h('button', { class: 'btn primary' }, 'Déplacer ici');
    let data = null;

    async function load() {
      clear(list, h('p', { class: 'muted', style: 'padding:12px' }, 'Chargement…'));
      try {
        data = await get(current ? `/api/folder?id=${current.id}` : `/api/folder?space=${encodeURIComponent(spaceParam)}`);
      } catch (err) {
        clear(list, h('p', { class: 'err', style: 'padding:12px' }, err.message));
        return;
      }
      const parts = [{ id: null, name: data.root.name, clickable: data.root.kind !== 'shared' }, ...data.crumbs.map((c) => ({ ...c, clickable: true }))];
      clear(crumbs, parts.map((p, i) => [
        i ? icon('chevron', 'sep') : null,
        h('button', { type: 'button', disabled: !p.clickable, onclick: () => { current = p.id ? { id: p.id } : null; load(); } }, p.name),
      ]));
      const folders = data.items.filter((i) => i.kind === 'folder' && !movingIds.has(i.id));
      clear(list, folders.length
        ? folders.map((f) => h('button', {
          type: 'button', class: 'btn ghost', style: 'width:100%;justify-content:flex-start;height:40px',
          ondblclick: () => { current = { id: f.id }; load(); },
          onclick: () => { current = { id: f.id }; load(); },
        }, fileIcon(f), h('span', { class: 'grow', style: 'text-align:left;overflow:hidden;text-overflow:ellipsis' }, f.name), icon('chevron')))
        : h('p', { class: 'muted', style: 'padding:12px' }, 'Aucun sous-dossier'));
      const here = data.folder ? data.folder.id : null;
      moveBtn.disabled = !atLeast(data.role, 'editor') || items.every((i) => (i.parentId || null) === here);
    }

    moveBtn.addEventListener('click', () => {
      close();
      onPick(data.folder ? { id: data.folder.id, name: data.folder.name } : null);
    });
    box.append(
      h('h2', {}, items.length > 1 ? `Déplacer ${items.length} éléments` : `Déplacer « ${items[0].name} »`),
      crumbs, list,
      h('div', { class: 'actions' }, h('button', { class: 'btn ghost', onclick: close }, 'Annuler'), moveBtn));
    load();
  }, { wide: true });
}
