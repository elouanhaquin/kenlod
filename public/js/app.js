import { get, post, patch, setCsrf } from './api.js';
import { h, clear, icon, avatar, formatBytes, showMenu, modal, toast, toastError } from './ui.js';
import { state, on, setNavigate, refreshGroups, navigate, setCleanup, runCleanup } from './state.js';
import { DriveView } from './drive.js';
import { renderGroupPage, openNewGroup, renderJoin } from './groups.js';
import { openNewMenu } from './uploads.js';

const app = document.getElementById('app');
let shell = null; // { root, main, nav, storage, search }

// ---------- Router ----------

const routes = [
  [/^\/connexion$/, () => renderAuth('login')],
  [/^\/inscription$/, () => renderAuth('register')],
  [/^\/mot-de-passe-oublie$/, () => renderForgot()],
  [/^\/reinitialiser\/([\w-]+)$/, (token) => renderReset(token), { public: true }],
  [/^\/verifier\/([\w-]+)$/, (token) => renderVerify(token), { public: true }],
  [/^\/s\/([\w-]+)$/, (token) => import('./public.js').then((m) => m.renderPublic(app, token)), { public: true }],
  [/^\/rejoindre\/([\w-]+)$/, (token) => renderJoin(app, token), { public: true }],
  [/^\/doc\/([\w-]+)$/, (id) => import('./doc.js').then((m) => m.renderDoc(app, id))],
  [/^\/tableur\/([\w-]+)$/, (id) => import('./sheet.js').then((m) => m.renderSheet(app, id))],
  [/^\/questionnaire\/([\w-]+)(?:\/(reponses|parametres))?$/, (id, tab) => import('./form.js').then((m) => m.renderForm(app, id, tab))],
  [/^\/f\/([\w-]+)$/, (token) => import('./form-answer.js').then((m) => m.renderAnswer(app, token)), { public: true }],
  [/^\/(?:drive)?$/, () => driveRoute({ mode: 'folder', space: 'me' }, '/drive')],
  [/^\/dossier\/([\w-]+)$/, (id) => driveRoute({ mode: 'folder', folderId: id }, null)],
  [/^\/groupe\/([\w-]+)(?:\/(membres|activite))?$/, (id, tab) => { const s = ensureShell(`/groupe/${id}`); renderGroupPage(s.main, id, tab || 'fichiers'); }],
  [/^\/partages$/, () => driveRoute({ mode: 'shared' }, '/partages')],
  [/^\/recents$/, () => driveRoute({ mode: 'recent' }, '/recents')],
  [/^\/favoris$/, () => driveRoute({ mode: 'starred' }, '/favoris')],
  [/^\/corbeille$/, () => driveRoute({ mode: 'trash' }, '/corbeille')],
  [/^\/recherche$/, () => driveRoute({ mode: 'search', q: new URLSearchParams(location.search).get('q') || '' }, null)],
];

const AUTH_PATHS = ['/connexion', '/inscription', '/mot-de-passe-oublie'];

function driveRoute(ctx, navPath) {
  const s = ensureShell(navPath);
  const view = new DriveView(s.main, ctx);
  state.currentView = view;
  setCleanup(() => { view.destroy(); if (state.currentView === view) state.currentView = null; });
  view.load();
}

async function route() {
  const path = location.pathname;
  const match = routes.map(([re, fn, opts]) => [path.match(re), fn, opts]).find(([m]) => m);
  if (!match) return navigate('/drive', { replace: true });
  const [m, fn, opts] = match;
  if (!state.me?.user && !opts?.public && !AUTH_PATHS.includes(path)) {
    sessionStorage.setItem('kl_after_login', path + location.search);
    return navigate('/connexion', { replace: true });
  }
  if (state.me?.user && AUTH_PATHS.includes(path)) return navigate('/drive', { replace: true });
  runCleanup();
  try {
    if (state.me?.mustVerify && !opts?.public) return renderPending();
    await fn(...m.slice(1));
  } catch (err) {
    console.error(err);
    toastError(err);
  }
}

setNavigate((path, { replace = false } = {}) => {
  if (path !== location.pathname + location.search) history[replace ? 'replaceState' : 'pushState']({}, '', path);
  route();
});
window.addEventListener('popstate', route);

// Internal links: <a href="/..." data-link>
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-link]');
  if (!a || e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
  e.preventDefault();
  shell?.root.classList.remove('nav-open');
  navigate(a.getAttribute('href'));
});

// ---------- Auth screens ----------

// Inside the app the logo goes to the drive; on the sign-in screens it goes back to the public site.
function brand(inApp = true) {
  return h('a', { class: 'brand', href: inApp ? '/drive' : '/', dataset: inApp ? { link: '' } : {} },
    h('img', { src: '/img/logo.svg', alt: '' }), h('b', {}, 'Kenlod'));
}

function renderAuth(mode) {
  shell = null;
  const isLogin = mode === 'login';
  const err = h('div', { class: 'err', role: 'alert' });
  const email = h('input', { class: 'input', type: 'email', name: 'email', autocomplete: 'email', required: true, autofocus: true });
  const name = h('input', { class: 'input', name: 'name', autocomplete: 'name', required: true, minLength: 2 });
  const password = h('input', {
    class: 'input', type: 'password', name: 'password', required: true,
    autocomplete: isLogin ? 'current-password' : 'new-password', minLength: isLogin ? 1 : 10,
  });
  const submit = h('button', { class: 'btn primary', type: 'submit' }, isLogin ? 'Se connecter' : 'Créer mon compte');

  const onSubmit = async (e) => {
    e.preventDefault();
    err.textContent = '';
    submit.disabled = true;
    try {
      const body = { email: email.value, password: password.value };
      if (!isLogin) body.name = name.value;
      const me = await post(`/api/auth/${isLogin ? 'login' : 'register'}`, body);
      await boot(me);
      const after = sessionStorage.getItem('kl_after_login');
      sessionStorage.removeItem('kl_after_login');
      // The confirmation link opens in another tab: remember where to go once the address is confirmed.
      if (me.mustVerify && after) storeSet('kl_after_verify', after);
      navigate(after && !after.startsWith('/connexion') ? after : '/drive', { replace: true });
    } catch (ex) {
      err.textContent = ex.message;
      submit.disabled = false;
    }
  };

  const closed = !isLogin && state.me?.registration === 'closed';
  authLayout(
    h('h2', {}, isLogin ? 'Connexion' : 'Créer un compte'),
    h('p', { class: 'sub' }, isLogin ? 'Retrouvez les documents de vos associations.' : 'Gratuit, en moins d’une minute.'),
    closed
      ? h('p', {}, 'Les inscriptions sont fermées sur cette instance. Demandez une invitation à votre association.')
      : h('form', { onsubmit: onSubmit },
        !isLogin ? h('label', { class: 'field' }, h('span', {}, 'Nom et prénom'), name) : null,
        h('label', { class: 'field' }, h('span', {}, 'Adresse e-mail'), email),
        h('label', { class: 'field' }, h('span', {}, 'Mot de passe'), password,
          !isLogin ? h('small', {}, '10 caractères minimum. Une phrase de passe fonctionne très bien.') : null),
        isLogin ? h('p', { class: 'forgot' }, h('a', { href: '/mot-de-passe-oublie', dataset: { link: '' } }, 'Mot de passe oublié ?')) : null,
        err,
        !isLogin ? h('p', { class: 'legal-note' }, 'En créant un compte, vous acceptez les ',
          h('a', { href: '/cgu', target: '_blank' }, 'conditions d’utilisation'), ' et la ',
          h('a', { href: '/confidentialite', target: '_blank' }, 'politique de confidentialité'), '.') : null,
        submit),
    h('p', { class: 'switch' },
      isLogin ? 'Pas encore de compte ? ' : 'Déjà inscrit·e ? ',
      h('a', { href: isLogin ? '/inscription' : '/connexion', dataset: { link: '' } }, isLogin ? 'Créer un compte' : 'Se connecter')));
}

const storeGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const storeSet = (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* private mode */ } };

// The two-column sign-in layout, with the given content in the card.
function authLayout(...card) {
  shell = null;
  const ermines = h('img', { class: 'ermines', src: '/img/logo.svg', alt: '' });
  clear(app, h('div', { class: 'auth' },
    h('section', { class: 'auth-art' },
      brand(false),
      h('div', {},
        h('h1', {}, 'Vos documents d’association, partagés en confiance.'),
        h('p', {}, 'Kenlod rassemble les fichiers, les comptes rendus et les tableurs de votre asso au même endroit, hébergés en Europe, sans publicité ni pistage.'),
        h('ul', {},
          h('li', {}, icon('users'), 'Groupes de travail avec rôles : administrateur, éditeur, lecteur'),
          h('li', {}, icon('lock'), 'Liens de partage protégés par mot de passe et date d’expiration'),
          h('li', {}, icon('edit'), 'Documents et tableurs intégrés, modifiables à plusieurs'))),
      h('div', { class: 'small-text', style: 'opacity:.7' }, 'Degemer mat ! — Bienvenue'),
      ermines),
    h('section', { class: 'auth-form' },
      h('div', { class: 'auth-card' }, ...card),
      h('nav', { class: 'auth-links', 'aria-label': 'Informations' },
        h('a', { href: '/' }, 'Accueil'),
        h('a', { href: '/mentions-legales' }, 'Mentions légales'),
        h('a', { href: '/cgu' }, 'CGU'),
        h('a', { href: '/confidentialite' }, 'Confidentialité')))));
}

// A small form inside the auth layout: runs `action`, then shows `done` (or the error).
function authForm({ title, sub, fields, label, action, done }) {
  const err = h('div', { class: 'err', role: 'alert' });
  const submit = h('button', { class: 'btn primary', type: 'submit' }, label);
  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      err.textContent = '';
      submit.disabled = true;
      try {
        await action();
        form.replaceWith(done());
      } catch (ex) {
        err.textContent = ex.message;
        submit.disabled = false;
      }
    },
  }, ...fields, err, submit);
  authLayout(h('h2', {}, title), h('p', { class: 'sub' }, sub), form,
    h('p', { class: 'switch' }, h('a', { href: '/connexion', dataset: { link: '' } }, 'Retour à la connexion')));
}

function renderForgot() {
  const email = h('input', { class: 'input', type: 'email', autocomplete: 'email', required: true, autofocus: true });
  authForm({
    title: 'Mot de passe oublié',
    sub: 'Indiquez l’adresse de votre compte : nous vous enverrons un lien pour choisir un nouveau mot de passe.',
    fields: [h('label', { class: 'field' }, h('span', {}, 'Adresse e-mail'), email)],
    label: 'Envoyer le lien',
    action: () => post('/api/auth/forgot', { email: email.value }),
    done: () => h('div', { class: 'notice' }, icon('check'),
      h('p', {}, `Si un compte existe pour ${email.value}, un e-mail vient de partir. Le lien est valable 1 heure. Pensez à regarder dans les indésirables.`)),
  });
}

function renderReset(token) {
  const password = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', required: true, minLength: 10, autofocus: true });
  authForm({
    title: 'Nouveau mot de passe',
    sub: 'Choisissez un nouveau mot de passe. Vos autres sessions seront déconnectées.',
    fields: [h('label', { class: 'field' }, h('span', {}, 'Nouveau mot de passe'), password, h('small', {}, '10 caractères minimum'))],
    label: 'Enregistrer',
    action: async () => {
      await post('/api/auth/reset', { token, password: password.value });
      state.me = { user: null, registration: state.me?.registration };
      setCsrf('');
    },
    done: () => h('div', { class: 'notice' }, icon('check'),
      h('p', {}, 'Mot de passe modifié.'),
      h('a', { class: 'btn primary', href: '/connexion', dataset: { link: '' } }, 'Se connecter')),
  });
}

async function renderVerify(token) {
  const card = h('div', { class: 'notice' }, h('p', {}, 'Vérification en cours…'));
  authLayout(h('h2', {}, 'Confirmation de l’adresse'), card);
  try {
    await post('/api/auth/verify', { token });
    if (state.me?.user) {
      await boot(await get('/api/auth/me'));
      const after = storeGet('kl_after_verify');
      storeSet('kl_after_verify', null);
      toast('Adresse confirmée, bienvenue sur Kenlod !');
      return navigate(after || '/drive', { replace: true });
    }
    clear(card, icon('check'), h('p', {}, 'Votre adresse est confirmée. Vous pouvez vous connecter.'),
      h('a', { class: 'btn primary', href: '/connexion', dataset: { link: '' } }, 'Se connecter'));
  } catch (ex) {
    clear(card, h('p', {}, ex.message),
      h('p', { class: 'muted' }, state.me?.user ? 'Vous pouvez demander un nouveau lien.' : 'Connectez-vous pour recevoir un nouveau lien.'),
      h('a', { class: 'btn primary', href: state.me?.user ? '/drive' : '/connexion', dataset: { link: '' } }, 'Continuer'));
  }
}

// Shown instead of the app while the account's address is not confirmed.
function renderPending() {
  const resend = h('button', {
    class: 'btn', type: 'button',
    onclick: async () => {
      resend.disabled = true;
      try {
        await post('/api/auth/verify/resend');
        toast('Un nouveau lien vient de partir');
      } catch (ex) { toastError(ex); }
      setTimeout(() => { resend.disabled = false; }, 30000);
    },
  }, 'Renvoyer l’e-mail');
  authLayout(
    h('h2', {}, 'Vérifiez votre boîte mail'),
    h('p', { class: 'sub' }, `Nous avons envoyé un lien de confirmation à ${state.me.user.email}. Cliquez dessus pour activer votre compte : le lien est valable 24 heures.`),
    h('div', { class: 'notice' }, icon('clock'),
      h('p', {}, 'Rien reçu ? Regardez dans les indésirables, ou renvoyez l’e-mail.')),
    h('div', { class: 'row', style: 'margin-top:16px' },
      resend,
      h('button', { class: 'btn primary', type: 'button', onclick: () => recheck(true) }, 'J’ai confirmé')),
    h('p', { class: 'switch' }, 'Mauvaise adresse ? ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); logout(); } }, 'Se déconnecter')));
}

// Coming back to the tab after clicking the link in the mail: reload the account state.
async function recheck(explicit = false) {
  if (!state.me?.mustVerify) return;
  try {
    const me = await get('/api/auth/me');
    if (me.user && !me.mustVerify) {
      await boot(me);
      const after = storeGet('kl_after_verify');
      storeSet('kl_after_verify', null);
      return navigate(after || location.pathname + location.search, { replace: true });
    }
    if (explicit) toast('Adresse pas encore confirmée : cliquez sur le lien reçu par e-mail');
  } catch (ex) { if (explicit) toastError(ex); }
}
window.addEventListener('focus', () => recheck());

// ---------- App shell ----------

const NAV = [
  ['/drive', 'home', 'Mon espace'],
  ['/partages', 'share', 'Partagés avec moi'],
  ['/recents', 'clock', 'Récents'],
  ['/favoris', 'star', 'Favoris'],
  ['/corbeille', 'trash', 'Corbeille'],
];

function ensureShell(activePath) {
  if (!shell || !document.body.contains(shell.root)) buildShell();
  setActiveNav(activePath ?? location.pathname);
  shell.root.classList.remove('nav-open');
  if (location.pathname !== '/recherche') shell.search.value = '';
  return shell;
}

function setActiveNav(path) {
  for (const a of shell.root.querySelectorAll('.nav a')) {
    a.classList.toggle('active', a.getAttribute('href') === path);
  }
}

function renderGroupsNav(container) {
  clear(container, ...state.groups.map((g) =>
    h('a', { href: `/groupe/${g.id}`, dataset: { link: '' }, title: g.name },
      h('span', { class: 'dot', style: { background: g.color } }), h('span', { class: 'label' }, g.name))),
  h('button', { class: 'navlink', onclick: () => openNewGroup() }, icon('plus'), h('span', { class: 'label' }, 'Nouveau groupe')));
  setActiveNav(location.pathname.replace(/\/(membres|activite)$/, ''));
}

function renderStorage(container) {
  const { used, quota } = state.me.storage;
  const pct = Math.min(100, (used / quota) * 100);
  clear(container,
    h('div', {}, 'Stockage personnel'),
    h('div', { class: `meter${pct > 90 ? ' full' : ''}` }, h('i', { style: { width: `${Math.max(pct, 1)}%` } })),
    h('div', {}, `${formatBytes(used)} utilisés sur ${formatBytes(quota)}`));
}

function buildShell() {
  const user = state.me.user;
  const search = h('input', { type: 'search', placeholder: 'Rechercher dans Kenlod', 'aria-label': 'Rechercher' });
  const groupsNav = h('nav', { class: 'nav' });
  const storage = h('div', { class: 'storage' });
  const main = h('main', { class: 'main' });
  const root = h('div', { class: 'shell' });

  const userMenu = (e) => showMenu([
    { label: user.email, icon: 'users', run: () => {} },
    'sep',
    { label: 'Mon compte', icon: 'settings', run: openAccount },
    { label: 'Conditions et confidentialité', icon: 'lock', run: () => window.open('/cgu', '_blank', 'noopener') },
    { label: 'Se déconnecter', icon: 'logout', run: logout },
  ], e.currentTarget);

  root.append(
    h('header', { class: 'topbar' },
      h('button', { class: 'icon-btn menu-toggle', 'aria-label': 'Menu', onclick: () => root.classList.toggle('nav-open') }, icon('menu')),
      brand(),
      h('form', {
        class: 'search', role: 'search',
        onsubmit: (e) => {
          e.preventDefault();
          const q = search.value.trim();
          if (q) navigate(`/recherche?q=${encodeURIComponent(q)}`);
        },
      }, icon('search'), search),
      h('div', { class: 'spacer' }),
      h('button', { class: 'avatar', title: user.name, 'aria-label': 'Compte', onclick: userMenu, style: { background: '#14213d' } },
        avatar(user.name).textContent)),
    h('aside', { class: 'sidebar' },
      h('button', { class: 'new-btn', onclick: (e) => openNewMenu(e.currentTarget) }, icon('plus'), 'Nouveau'),
      h('nav', { class: 'nav' }, NAV.map(([href, ic, label]) =>
        h('a', { href, dataset: { link: '' } }, icon(ic), h('span', { class: 'label' }, label)))),
      h('div', { class: 'nav-title' }, 'Groupes de travail'),
      groupsNav,
      storage),
    main);
  clear(app, root);
  shell = { root, main, search, groupsNav, storage };
  renderGroupsNav(groupsNav);
  renderStorage(storage);
  if (location.pathname === '/recherche') search.value = new URLSearchParams(location.search).get('q') || '';
}

on('groups', () => shell && renderGroupsNav(shell.groupsNav));
on('storage', () => shell && renderStorage(shell.storage));

async function logout() {
  await post('/api/auth/logout').catch(() => {});
  state.me = { user: null };
  setCsrf('');
  shell = null;
  location.assign('/');
}

function openAccount() {
  const user = state.me.user;
  modal((box, close) => {
    const name = h('input', { class: 'input', value: user.name, required: true });
    const cur = h('input', { class: 'input', type: 'password', autocomplete: 'current-password' });
    const next = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', minLength: 10 });
    const err = h('div', { class: 'err' });
    box.append(h('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        err.textContent = '';
        try {
          const body = { name: name.value };
          if (next.value) Object.assign(body, { currentPassword: cur.value, newPassword: next.value });
          const me = await patch('/api/auth/me', body);
          state.me.user = me.user;
          close();
          toast(next.value ? 'Mot de passe modifié. Vos autres sessions ont été déconnectées.' : 'Profil mis à jour');
          shell = null;
          route();
        } catch (ex) { err.textContent = ex.message; }
      },
    },
    h('h2', {}, 'Mon compte'),
    h('label', { class: 'field' }, h('span', {}, 'Nom affiché'), name),
    h('div', { class: 'field' }, h('span', {}, 'Adresse e-mail'), h('div', { class: 'muted' }, user.email)),
    h('div', { class: 'subhead' }, 'Changer de mot de passe'),
    h('label', { class: 'field' }, h('span', {}, 'Mot de passe actuel'), cur),
    h('label', { class: 'field' }, h('span', {}, 'Nouveau mot de passe'), next, h('small', {}, '10 caractères minimum')),
    err,
    h('div', { class: 'actions' },
      h('button', { type: 'button', class: 'btn ghost', onclick: close }, 'Annuler'),
      h('button', { class: 'btn primary' }, 'Enregistrer'))));
  });
}

// ---------- Boot ----------

async function boot(me) {
  state.me = me;
  setCsrf(me.csrf);
  if (me.user && !me.mustVerify) await refreshGroups();
}

(async () => {
  try {
    await boot(await get('/api/auth/me'));
  } catch (err) {
    state.me = { user: null };
    if (!location.pathname.startsWith('/s/')) toastError(err);
  }
  route();
})();
