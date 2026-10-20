import { get, post } from './api.js';
import { h, clear, icon, fileIcon, formatBytes, formatDate } from './ui.js';
import { state } from './state.js';
import { openPreview } from './preview.js';

const IMAGE = /^image\/(png|jpeg|gif|webp|avif|bmp)$/;
const TEXT = /^(text\/(plain|markdown|csv)|application\/json)$/;

export async function renderPublic(app, token) {
  const base = `/api/public/${token}`;
  const fileUrl = (it, inline) => `${base}/file/${it.id}${inline ? '?inline=1' : ''}`;
  const itemId = new URLSearchParams(location.search).get('item');

  const header = h('header', {},
    h('a', { class: 'brand', href: state.me?.user ? '/drive' : '/connexion', dataset: { link: '' } },
      h('img', { src: '/img/logo.svg', alt: '' }), h('b', {}, 'Kenlod')),
    h('div', { class: 'nm' }));
  const main = h('main');
  clear(app, h('div', { class: 'public' }, header, main,
    h('footer', {}, 'Partagé de façon sécurisée avec Kenlod — l’espace documentaire des associations bretonnes. ',
      !state.me?.user ? h('a', { href: '/inscription', dataset: { link: '' } }, 'Créer un compte') : null)));

  let data;
  try {
    data = await get(`${base}${itemId ? `?item=${encodeURIComponent(itemId)}` : ''}`);
  } catch (err) {
    if (err.status === 401) return renderLock(main, base, () => renderPublic(app, token));
    clear(main, h('div', { class: 'empty' }, icon('link', 'big'), h('h3', {}, 'Lien indisponible'), h('p', {}, err.message)));
    return;
  }

  const item = data.item;
  document.title = `${item.name} — Kenlod`;
  clear(header.querySelector('.nm'), item.name);
  if (item.kind === 'file') {
    header.append(h('a', { class: 'btn primary', href: fileUrl(item, false), download: item.name }, icon('download'), 'Télécharger'));
  }

  const go = (id) => {
    const url = id && id !== data.root.id ? `/s/${token}?item=${encodeURIComponent(id)}` : `/s/${token}`;
    history.pushState({}, '', url);
    renderPublic(app, token);
  };

  if (item.kind === 'folder') {
    const files = data.children.filter((c) => c.kind === 'file');
    const sorted = [...data.children].sort((a, b) => (a.kind === 'folder') !== (b.kind === 'folder') ? (a.kind === 'folder' ? -1 : 1) : a.name.localeCompare(b.name, 'fr', { numeric: true }));
    clear(main,
      h('div', { class: 'crumbs', style: 'margin-bottom:12px' }, data.crumbs.map((c, i) => [
        i ? icon('chevron', 'sep') : null,
        h('button', { onclick: () => go(c.id) }, c.name),
      ])),
      h('div', { class: 'frame' }, sorted.length
        ? h('table', { class: 'list' },
          h('colgroup', {}, h('col'), h('col', { class: 'col-date' }), h('col', { class: 'col-size' }), h('col', { class: 'col-act' })),
          h('thead', {}, h('tr', {}, h('th', {}, 'Nom'), h('th', { class: 'date' }, 'Modifié'), h('th', { class: 'size' }, 'Taille'), h('th'))),
          h('tbody', {}, sorted.map((c) => {
            const open = () => {
              if (c.kind === 'file') openPreview(files, files.indexOf(c), { url: fileUrl });
              else go(c.id);
            };
            return h('tr', { class: 'item', style: 'cursor:pointer', onclick: open },
              h('td', { class: 'name' }, h('div', { class: 'cell' }, fileIcon(c), h('span', { class: 'nm' }, c.name))),
              h('td', { class: 'date' }, formatDate(c.updatedAt)),
              h('td', { class: 'size' }, c.kind === 'file' ? formatBytes(c.size) : '—'),
              h('td', { class: 'actions' }, c.kind === 'file'
                ? h('a', { class: 'icon-btn small', title: 'Télécharger', href: fileUrl(c, false), download: c.name, onclick: (e) => e.stopPropagation() }, icon('download'))
                : null));
          })))
        : h('div', { class: 'empty' }, icon('folder', 'big'), h('h3', {}, 'Dossier vide'))));
    return;
  }

  if (item.kind === 'doc' || item.kind === 'sheet') {
    const { content } = await get(`${base}/content/${item.id}`);
    if (item.kind === 'doc') {
      const page = h('div', { class: 'page', style: 'min-height:0' });
      page.innerHTML = content; // sanitized server-side
      clear(main, page);
    } else {
      const { renderSheetTable } = await import('./sheet.js');
      clear(main, h('div', { class: 'frame' }, renderSheetTable(content)));
    }
    return;
  }

  const src = fileUrl(item, true);
  let body;
  if (IMAGE.test(item.mime)) body = h('img', { src, alt: item.name });
  else if (item.mime === 'application/pdf') body = h('iframe', { src, title: item.name });
  else if (/^video\/(mp4|webm)$/.test(item.mime)) body = h('video', { src, controls: true });
  else if (/^audio\//.test(item.mime)) body = h('div', { style: 'padding:24px' }, h('audio', { src, controls: true, style: 'width:100%' }));
  else if (TEXT.test(item.mime) && item.size < 2e6) {
    body = h('pre', {}, 'Chargement…');
    fetch(src).then((r) => r.text()).then((t) => { body.textContent = t; });
  } else {
    body = h('div', { class: 'empty' }, fileIcon(item, 72), h('h3', {}, item.name), h('p', {}, formatBytes(item.size)),
      h('a', { class: 'btn primary', href: fileUrl(item, false), download: item.name }, icon('download'), 'Télécharger'));
  }
  clear(main, h('div', { class: 'frame' }, body));
}

function renderLock(main, base, retry) {
  const pwd = h('input', { class: 'input', type: 'password', autocomplete: 'off', autofocus: true, 'aria-label': 'Mot de passe' });
  const err = h('div', { class: 'err' });
  clear(main, h('div', { class: 'lock' },
    icon('lock', 'big'),
    h('h2', {}, 'Ce partage est protégé'),
    h('p', { class: 'muted' }, 'Saisissez le mot de passe communiqué par la personne qui vous a envoyé ce lien.'),
    h('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        err.textContent = '';
        try {
          await post(`${base}/unlock`, { password: pwd.value });
          retry();
        } catch (ex) { err.textContent = ex.message; pwd.select(); }
      },
    }, pwd, err, h('button', { class: 'btn primary', style: 'width:100%;margin-top:8px' }, 'Accéder aux fichiers'))));
  pwd.focus();
}
