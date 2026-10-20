import { get } from './api.js';

export const state = {
  me: null, // { user, storage, registration }
  groups: [],
  colors: [],
  currentView: null, // active DriveView, used by the "Nouveau" button and uploads
};

export const bus = new EventTarget();
export const emit = (name, detail) => bus.dispatchEvent(new CustomEvent(name, { detail }));
export const on = (name, fn) => {
  const listener = (e) => fn(e.detail);
  bus.addEventListener(name, listener);
  return () => bus.removeEventListener(name, listener);
};

// Teardown for the page currently on screen (polling, key handlers…), run before each route change.
let cleanup = null;
export function setCleanup(fn) { cleanup = fn; }
export function runCleanup() {
  const fn = cleanup;
  cleanup = null;
  fn?.();
}

export const atLeast = (role, min) => {
  const rank = { viewer: 1, editor: 2, manager: 3, owner: 4 };
  return !!role && rank[role] >= rank[min];
};

export function canDelete(item) {
  if (atLeast(item.role, 'manager')) return true;
  return item.role === 'editor' && (item.space?.startsWith('g:') || item.ownerId === state.me?.user?.id);
}

// Where to go "back" to from an item: its folder, or the root of its space.
export function parentPath(item) {
  if (item.parentId) return `/dossier/${item.parentId}`;
  if (item.space === `u:${state.me?.user?.id}`) return '/drive';
  if (item.space?.startsWith('g:') && state.groups.some((g) => g.id === item.space.slice(2))) return `/groupe/${item.space.slice(2)}`;
  return '/partages';
}

let navigateImpl = (path) => { location.href = path; };
export const setNavigate = (fn) => { navigateImpl = fn; };
export const navigate = (path, opts) => navigateImpl(path, opts);

export async function refreshGroups() {
  const data = await get('/api/groups');
  state.groups = data.groups;
  state.colors = data.colors;
  emit('groups');
}

export async function refreshStorage() {
  const me = await get('/api/auth/me');
  if (me.user) {
    state.me.storage = me.storage;
    emit('storage');
  }
}

export function openItemPath(item) {
  if (item.kind === 'folder') return `/dossier/${item.id}`;
  if (item.kind === 'doc') return `/doc/${item.id}`;
  if (item.kind === 'sheet') return `/tableur/${item.id}`;
  if (item.kind === 'form') return `/questionnaire/${item.id}`;
  return null;
}

export function spaceLabel(space) {
  if (!space) return '';
  if (space === `u:${state.me?.user?.id}`) return 'Mon espace';
  if (space.startsWith('g:')) {
    const g = state.groups.find((x) => x.id === space.slice(2));
    return g ? g.name : 'Groupe';
  }
  return 'Espace partagé';
}
