import { post, uploadFile } from './api.js';
import { h, clear, icon, showMenu, toast, toastError, promptDialog, formatBytes } from './ui.js';
import { state, emit, navigate, refreshStorage, openItemPath } from './state.js';
import { rememberBack } from './drive.js';

const CONCURRENCY = 3;
const queue = [];
const tasks = [];
let active = 0;
let panel = null;
let list = null;
let title = null;
let storageTimer = null;

function currentTarget() {
  return state.currentView?.canWrite ? state.currentView.target : { space: 'me' };
}

export function openNewMenu(at) {
  const target = currentTarget();
  showMenu([
    { label: 'Nouveau dossier', icon: 'folderPlus', run: () => newFolder(target) },
    'sep',
    { label: 'Importer des fichiers', icon: 'upload', run: () => pickFiles(target, false) },
    { label: 'Importer un dossier', icon: 'uploadFolder', run: () => pickFiles(target, true) },
    'sep',
    { label: 'Document Kenlod', icon: 'file', run: () => newDoc('doc', target) },
    { label: 'Tableur Kenlod', icon: 'grid', run: () => newDoc('sheet', target) },
    { label: 'Questionnaire Kenlod', icon: 'form', run: () => newDoc('form', target) },
  ], at);
}

async function newFolder(target) {
  const name = await promptDialog({ title: 'Nouveau dossier', value: 'Dossier sans titre', confirm: 'Créer' });
  if (!name) return;
  try {
    await post('/api/items', { kind: 'folder', name, ...target });
    emit('changed');
    if (!state.currentView?.canWrite) toast(`Dossier « ${name} » créé dans Mon espace`);
  } catch (err) { toastError(err); }
}

async function newDoc(kind, target) {
  try {
    const { item } = await post('/api/items', { kind, ...target });
    rememberBack();
    navigate(openItemPath(item));
  } catch (err) { toastError(err); }
}

function pickFiles(target, directory) {
  const input = h('input', { type: 'file', multiple: true, style: { display: 'none' } });
  if (directory) input.webkitdirectory = true;
  input.addEventListener('change', () => {
    const entries = [...input.files].map((file) => ({ file, path: directory ? file.webkitRelativePath || file.name : file.name }));
    input.remove();
    uploadEntries(entries, target);
  });
  document.body.append(input);
  input.click();
}

// Turns a drop into [{ file, path }], walking dropped folders.
export async function entriesFromDataTransfer(dt) {
  const roots = [...dt.items].map((it) => it.webkitGetAsEntry?.()).filter(Boolean);
  if (!roots.length) return [...dt.files].map((file) => ({ file, path: file.name }));
  const out = [];
  const walk = async (entry, prefix) => {
    if (entry.isFile) {
      const file = await new Promise((res, rej) => entry.file(res, rej));
      out.push({ file, path: prefix + file.name });
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      let batch;
      do {
        batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        for (const child of batch) await walk(child, `${prefix}${entry.name}/`);
      } while (batch.length);
    }
  };
  for (const entry of roots) await walk(entry, '');
  return out;
}

// Creates the needed folders, then queues every file.
export async function uploadEntries(entries, target) {
  if (!entries.length) return;
  const folders = new Map(); // "a/b" → folder id
  try {
    for (const { file, path } of entries) {
      const dirs = path.split('/').slice(0, -1);
      let parent = target;
      let key = '';
      for (const dir of dirs) {
        key = key ? `${key}/${dir}` : dir;
        if (!folders.has(key)) {
          const { item } = await post('/api/items', { kind: 'folder', name: dir, ...parent });
          folders.set(key, item.id);
          emit('changed');
        }
        parent = { parentId: folders.get(key), space: parent.space };
      }
      enqueue(file, parent);
    }
  } catch (err) {
    toastError(err);
  }
}

function enqueue(file, target) {
  const task = { file, target, progress: 0, status: 'waiting', error: null };
  tasks.push(task);
  queue.push(task);
  renderPanel();
  pump();
}

function pump() {
  while (active < CONCURRENCY && queue.length) {
    const task = queue.shift();
    active++;
    task.status = 'uploading';
    const { promise, abort } = uploadFile(task.file, task.target, (p) => { task.progress = p; renderTask(task); });
    task.abort = abort;
    renderTask(task);
    promise
      .then(() => { task.status = 'done'; emit('changed'); })
      .catch((err) => { task.status = 'error'; task.error = err.message; })
      .finally(() => {
        active--;
        renderTask(task);
        renderTitle();
        clearTimeout(storageTimer);
        storageTimer = setTimeout(refreshStorage, 600);
        pump();
      });
  }
}

function renderPanel() {
  if (!panel || !document.body.contains(panel)) {
    list = h('ul');
    title = h('span');
    panel = h('section', { class: 'uploads', 'aria-live': 'polite' },
      h('header', {}, title,
        h('button', { class: 'icon-btn small', title: 'Fermer', onclick: closePanel }, icon('close'))),
      list);
    document.body.append(panel);
  }
  for (const task of tasks) if (!task.el) { task.el = h('li'); list.append(task.el); renderTask(task); }
  renderTitle();
}

function closePanel() {
  for (const t of tasks) if (t.status === 'uploading' || t.status === 'waiting') t.abort?.();
  queue.length = 0;
  tasks.length = 0;
  panel?.remove();
  panel = null;
}

function renderTitle() {
  if (!title) return;
  const pending = tasks.filter((t) => t.status === 'waiting' || t.status === 'uploading').length;
  const failed = tasks.filter((t) => t.status === 'error').length;
  title.textContent = pending
    ? `Importation de ${pending} élément${pending > 1 ? 's' : ''}…`
    : `${tasks.length - failed} importation${tasks.length - failed > 1 ? 's' : ''} terminée${tasks.length - failed > 1 ? 's' : ''}${failed ? ` · ${failed} échec${failed > 1 ? 's' : ''}` : ''}`;
}

function renderTask(task) {
  if (!task.el) return;
  const st = {
    waiting: h('span', { class: 'st' }, 'En attente'),
    uploading: h('span', { class: 'st' }, `${Math.round(task.progress * 100)} %`),
    done: h('span', { class: 'st ok', title: 'Importé' }, icon('check')),
    error: h('span', { class: 'st ko', title: task.error }, task.error),
  }[task.status];
  clear(task.el,
    h('div', { class: 'grow' },
      h('div', { class: 'row' }, h('span', { class: 'nm', title: task.file.name }, task.file.name), h('span', { class: 'st' }, formatBytes(task.file.size))),
      task.status === 'uploading' ? h('div', { class: 'bar' }, h('i', { style: { width: `${task.progress * 100}%` } })) : null),
    st);
}
