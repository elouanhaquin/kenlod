import { h, clear, icon, fileIcon, formatBytes } from './ui.js';

const IMAGE = /^image\/(png|jpeg|gif|webp|avif|bmp|x-icon)$/;
const TEXT = /^(text\/(plain|markdown|csv)|application\/json)$/;

// Full-screen viewer. opts.url(item, inline) builds file URLs; opts.onShare optional.
export function openPreview(items, index, opts) {
  let i = index;
  const stage = h('div', { class: 'stage' });
  const name = h('div', { class: 'nm' });
  const actions = h('div', { class: 'row' });
  const prevBtn = h('button', { class: 'icon-btn', title: 'Précédent', onclick: () => go(-1) }, icon('back'));
  const nextBtn = h('button', { class: 'icon-btn', title: 'Suivant', onclick: () => go(1) }, icon('chevron'));
  const viewer = h('div', { class: 'viewer', role: 'dialog', 'aria-modal': 'true' },
    h('header', {},
      h('button', { class: 'icon-btn', title: 'Fermer', onclick: () => close() }, icon('close')),
      name, actions, prevBtn, nextBtn),
    stage);

  const onKey = (e) => {
    if (e.key === 'Escape') close();
    if (e.key === 'ArrowLeft') go(-1);
    if (e.key === 'ArrowRight') go(1);
  };
  function close() {
    viewer.remove();
    document.removeEventListener('keydown', onKey);
  }
  function go(d) {
    if (items.length < 2) return;
    i = (i + d + items.length) % items.length;
    show();
  }

  async function show() {
    const item = items[i];
    name.textContent = item.name;
    prevBtn.hidden = nextBtn.hidden = items.length < 2;
    clear(actions,
      opts.onShare ? h('button', { class: 'icon-btn', title: 'Partager', onclick: () => opts.onShare(item) }, icon('share')) : null,
      h('a', { class: 'icon-btn', title: 'Télécharger', href: opts.url(item, false), download: item.name }, icon('download')));
    const src = opts.url(item, true);
    const mime = item.mime || '';
    if (IMAGE.test(mime)) clear(stage, h('img', { src, alt: item.name }));
    else if (mime === 'application/pdf') clear(stage, h('iframe', { src, title: item.name }));
    else if (/^video\/(mp4|webm)$/.test(mime)) clear(stage, h('video', { src, controls: true, autoplay: true }));
    else if (/^audio\//.test(mime)) clear(stage, h('audio', { src, controls: true, autoplay: true }));
    else if (TEXT.test(mime) && item.size < 2e6) {
      const pre = h('pre', {}, 'Chargement…');
      clear(stage, pre);
      try {
        const res = await fetch(src, { credentials: 'same-origin' });
        pre.textContent = res.ok ? await res.text() : 'Impossible de charger le fichier.';
      } catch { pre.textContent = 'Impossible de charger le fichier.'; }
    } else {
      clear(stage, h('div', { class: 'nopreview' },
        fileIcon(item, 96),
        h('p', {}, 'Aperçu indisponible pour ce type de fichier.'),
        h('p', { class: 'small-text' }, formatBytes(item.size)),
        h('a', { class: 'btn primary', href: opts.url(item, false), download: item.name }, icon('download'), 'Télécharger')));
    }
  }

  document.addEventListener('keydown', onKey);
  document.body.append(viewer);
  show();
  return close;
}
