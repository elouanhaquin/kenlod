import { get, patch } from './api.js';
import { h, clear, icon, avatar, toastError, ROLE_LABEL } from './ui.js';
import { state, navigate, parentPath, atLeast } from './state.js';
import { openShare } from './share.js';

export function goBack(item) {
  const back = sessionStorage.getItem('kl_back');
  navigate(back || (state.me?.user ? parentPath(item) : '/connexion'));
}

export async function loadEditable(app, id) {
  try {
    return await get(`/api/items/${id}/content`);
  } catch (err) {
    clear(app, h('div', { class: 'public' },
      h('main', {}, h('div', { class: 'empty' }, icon('file', 'big'), h('h3', {}, 'Document introuvable'),
        h('p', {}, err.status === 404 ? 'Ce document n’existe pas, a été supprimé, ou vous n’y avez pas accès.' : err.message),
        h('a', { class: 'btn', href: '/drive', dataset: { link: '' } }, 'Retour à mon espace')))));
    return null;
  }
}

// Top bar shared by the document and spreadsheet editors.
export function editorTop(item, { extra = [], onPrint } = {}) {
  const canEdit = atLeast(item.role, 'editor');
  const status = h('div', { class: 'status' }, 'Connexion…');
  const presence = h('div', { class: 'presence', 'aria-label': 'Personnes présentes' });
  const title = h('input', { class: 'title', value: item.name, readOnly: !canEdit, 'aria-label': 'Titre', spellcheck: false });
  const commitTitle = async () => {
    const name = title.value.trim();
    if (!name) { title.value = item.name; return; }
    if (name === item.name) return;
    try {
      await patch(`/api/items/${item.id}`, { name });
      item.name = name;
      document.title = `${name} — Kenlod`;
    } catch (err) { toastError(err); title.value = item.name; }
  };
  title.addEventListener('blur', commitTitle);
  title.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); title.blur(); } if (e.key === 'Escape') { title.value = item.name; title.blur(); } });
  const bar = h('header', { class: 'editor-top' },
    h('button', { class: 'icon-btn', title: 'Retour', 'aria-label': 'Retour', onclick: () => goBack(item) }, icon('back')),
    h('a', { href: '/drive', dataset: { link: '' }, title: 'Kenlod' }, h('img', { class: 'logo', src: '/img/logo.svg', alt: 'Kenlod' })),
    h('div', { class: 'title-box' }, title, status),
    presence,
    extra,
    onPrint ? h('button', { class: 'icon-btn', title: 'Imprimer / PDF', onclick: onPrint }, icon('print')) : null,
    canEdit ? h('button', { class: 'btn primary', onclick: () => openShare(item) }, icon('share'), h('span', {}, 'Partager')) : null);
  document.title = `${item.name} — Kenlod`;
  return { bar, status, presence, canEdit };
}

// Opens the realtime channel for a document or spreadsheet.
export async function connectRoom(item, { statusEl, presenceEl, onRevoked }) {
  const C = await import('/vendor/collab.js');
  const ydoc = new C.Y.Doc();
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const provider = new C.WebsocketProvider(`${proto}://${location.host}/ws/items`, item.id, ydoc, { disableBc: true });
  const canEdit = atLeast(item.role, 'editor');
  const me = state.me?.user;

  const setStatus = (text, error = false) => {
    statusEl.textContent = text;
    statusEl.classList.toggle('error', error);
  };
  let revoked = false;
  provider.on('status', ({ status }) => {
    if (revoked) return;
    if (status === 'connected') setStatus(canEdit ? 'En direct · enregistrement automatique' : `En direct · lecture seule (${ROLE_LABEL[item.role].toLowerCase()})`);
    else setStatus('Hors ligne : vos modifications seront envoyées à la reconnexion…', true);
  });
  provider.on('connection-close', (event) => {
    if (event?.code === 4403 || event?.code === 4404) {
      revoked = true;
      provider.disconnect();
      setStatus(event.code === 4404 ? 'Ce document a été mis à la corbeille' : 'Votre accès à ce document a été retiré', true);
      onRevoked?.(event.code);
    }
  });

  // Avatars of the other people in the document.
  const renderPresence = () => {
    const seen = new Map();
    for (const [clientId, s] of provider.awareness.getStates()) {
      if (clientId === ydoc.clientID || !s.user || s.user.id === me?.id) continue;
      seen.set(s.user.id, s.user);
    }
    clear(presenceEl, [...seen.values()].slice(0, 6).map((u) => {
      const a = avatar(u.name, { small: true, color: u.color });
      a.title = `${u.name}${u.canEdit ? '' : ' (lecture seule)'}`;
      a.style.boxShadow = `0 0 0 2px var(--panel), 0 0 0 4px ${u.color}`;
      return a;
    }), seen.size > 6 ? h('span', { class: 'muted small-text' }, `+${seen.size - 6}`) : null);
  };
  provider.awareness.on('change', renderPresence);

  const synced = new Promise((resolve) => provider.on('sync', (s) => s && resolve()));
  return {
    C, ydoc, provider, synced,
    destroy() {
      provider.awareness.off('change', renderPresence);
      provider.destroy();
      ydoc.destroy();
    },
  };
}
