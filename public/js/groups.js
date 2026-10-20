import { get, post, patch, del } from './api.js';
import {
  h, clear, icon, avatar, modal, toast, toastError, copyText, confirmDialog, formatBytes, formatFull, timeAgo, fileIcon,
  showMenu, ROLE_LABEL,
} from './ui.js';
import { state, navigate, refreshGroups, setCleanup, openItemPath } from './state.js';
import { DriveView, actionLabel, rememberBack } from './drive.js';

const MEMBER_ROLES = [['admin', 'Administrateur'], ['editor', 'Éditeur'], ['viewer', 'Lecteur']];
const ROLE_HELP = {
  admin: 'Gère les membres et le groupe, peut tout supprimer',
  editor: 'Ajoute, modifie et partage les fichiers du groupe',
  viewer: 'Consulte et télécharge les fichiers du groupe',
};
const inviteUrl = (token) => `${location.origin}/rejoindre/${token}`;

function groupForm(box, close, { group, onSave, title, submit }) {
  const colors = state.colors.length ? state.colors : ['#1f4e8c'];
  let color = group?.color || colors[Math.floor(Math.random() * colors.length)];
  const name = h('input', { class: 'input', value: group?.name || '', required: true, minLength: 2, maxLength: 80, placeholder: 'ex. Bureau, Fest-noz 2026, Cours de breton…' });
  const description = h('textarea', { class: 'input', rows: 3, maxLength: 500, placeholder: 'À quoi sert ce groupe ? (facultatif)' }, group?.description || '');
  const swatches = h('div', { class: 'row wrap' });
  const renderSwatches = () => clear(swatches, colors.map((c) => h('button', {
    type: 'button', title: c, 'aria-pressed': String(c === color),
    style: { width: '28px', height: '28px', borderRadius: '8px', background: c, border: c === color ? '3px solid var(--ink)' : '3px solid transparent', cursor: 'pointer' },
    onclick: () => { color = c; renderSwatches(); },
  })));
  renderSwatches();
  const err = h('div', { class: 'err' });
  box.append(h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      err.textContent = '';
      try {
        await onSave({ name: name.value, description: description.value, color });
        close();
      } catch (ex) { err.textContent = ex.message; }
    },
  },
  h('h2', {}, title),
  h('label', { class: 'field' }, h('span', {}, 'Nom du groupe'), name),
  h('label', { class: 'field' }, h('span', {}, 'Description'), description),
  h('div', { class: 'field' }, h('span', {}, 'Couleur'), swatches),
  err,
  h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn ghost', onclick: close }, 'Annuler'), h('button', { class: 'btn primary' }, submit))));
}

export function openNewGroup() {
  modal((box, close) => groupForm(box, close, {
    title: 'Nouveau groupe de travail',
    submit: 'Créer le groupe',
    onSave: async (body) => {
      const data = await post('/api/groups', body);
      await refreshGroups();
      toast(`Groupe « ${data.group.name} » créé. Invitez maintenant ses membres.`);
      navigate(`/groupe/${data.group.id}/membres`);
    },
  }));
}

export async function renderGroupPage(main, groupId, tab) {
  let data;
  try {
    data = await get(`/api/groups/${groupId}`);
  } catch (err) {
    clear(main, h('div', { class: 'empty' }, icon('users', 'big'), h('h3', {}, 'Groupe introuvable'),
      h('p', {}, err.status === 404 ? 'Ce groupe n’existe pas ou vous n’en faites plus partie.' : err.message),
      h('a', { class: 'btn', href: '/drive', dataset: { link: '' } }, 'Retour à mon espace')));
    return;
  }
  const g = data.group;
  const isAdmin = g.role === 'admin';
  document.title = `${g.name} — Kenlod`;

  const reload = () => renderGroupPage(main, groupId, tab);
  const body = h('div', { style: 'flex:1;min-height:0;display:flex;flex-direction:column' });
  const tabBtn = (key, label) => h('button', {
    class: key === tab ? 'active' : '',
    onclick: () => navigate(`/groupe/${g.id}${key === 'fichiers' ? '' : `/${key}`}`),
  }, label);

  const menu = (e) => showMenu([
    isAdmin ? { label: 'Modifier le groupe', icon: 'edit', run: () => editGroup(g, reload) } : null,
    { label: 'Quitter le groupe', icon: 'logout', run: () => leaveGroup(g) },
    isAdmin ? 'sep' : null,
    isAdmin ? { label: 'Supprimer le groupe', icon: 'trash', danger: true, run: () => deleteGroup(g) } : null,
  ].filter(Boolean), e.currentTarget);

  clear(main,
    h('div', { class: 'group-head' },
      avatar(g.name, { group: true, color: g.color }),
      h('div', { class: 'grow' }, h('h1', {}, g.name), g.description ? h('p', {}, g.description) : null),
      h('div', { class: 'row' },
        h('span', { class: 'pill', title: ROLE_HELP[g.role] }, ROLE_LABEL[g.role]),
        isAdmin ? h('button', { class: 'btn small', onclick: () => navigate(`/groupe/${g.id}/membres`) }, icon('users'), 'Inviter') : null,
        h('button', { class: 'icon-btn', title: 'Options du groupe', onclick: menu }, icon('settings')))),
    h('div', { class: 'tabs' },
      tabBtn('fichiers', 'Fichiers'),
      tabBtn('membres', `Membres (${data.members.length})`),
      tabBtn('activite', 'Activité')),
    body);

  if (tab === 'fichiers') {
    const view = new DriveView(body, { mode: 'folder', space: `g:${g.id}` });
    state.currentView = view;
    setCleanup(() => { view.destroy(); if (state.currentView === view) state.currentView = null; });
    view.load();
  } else if (tab === 'membres') {
    renderMembers(body, data, reload);
  } else {
    renderActivity(body, g);
  }
}

function renderMembers(body, data, reload) {
  const g = data.group;
  const isAdmin = g.role === 'admin';
  const me = state.me.user.id;
  const err = h('div', { class: 'err' });
  const run = async (fn) => {
    err.textContent = '';
    try { await fn(); reload(); } catch (ex) { err.textContent = ex.message; }
  };

  const email = h('input', { class: 'input', type: 'email', placeholder: 'adresse@exemple.bzh', required: true, 'aria-label': 'Adresse e-mail' });
  const role = h('select', { class: 'input', style: 'width:150px' }, MEMBER_ROLES.map(([v, l]) => h('option', { value: v, selected: v === 'editor' }, l)));
  const inviteRole = h('select', { class: 'input', style: 'width:150px' }, h('option', { value: 'editor' }, 'Éditeur'), h('option', { value: 'viewer' }, 'Lecteur'));
  const inviteEmails = h('input', {
    class: 'input', type: 'text', inputMode: 'email', placeholder: 'anna@exemple.bzh, yann@exemple.bzh',
    'aria-label': 'Adresses e-mail à inviter (facultatif)',
  });

  clear(body, h('div', { class: 'content', style: 'padding-top:16px' }, h('div', { class: 'members' },
    isAdmin ? h('div', { class: 'card-box' },
      h('h3', {}, 'Ajouter un membre'),
      h('p', { class: 'muted small-text', style: 'margin:0 0 12px' }, 'La personne doit déjà avoir un compte Kenlod. Sinon, invitez-la par e-mail ci-dessous.'),
      h('form', {
        class: 'row wrap',
        onsubmit: (e) => { e.preventDefault(); run(() => post(`/api/groups/${g.id}/members`, { email: email.value, role: role.value })); },
      }, h('div', { class: 'grow', style: 'min-width:200px' }, email), role, h('button', { class: 'btn primary' }, 'Ajouter')),
      h('div', { class: 'subhead' }, 'Lien d’invitation'),
      h('p', { class: 'muted small-text', style: 'margin:0 0 10px' }, 'Valable 14 jours. Toute personne qui l’ouvre peut créer un compte et rejoindre le groupe : ne le diffusez qu’aux personnes concernées.'),
      data.invites.map((inv) => h('div', { class: 'link-row' },
        icon('link'),
        h('div', { class: 'info' }, h('code', {}, inviteUrl(inv.token)),
          h('div', { class: 'meta' }, h('span', {}, `Rôle : ${ROLE_LABEL[inv.role]}`), h('span', {}, `Expire le ${formatFull(inv.expiresAt)}`), h('span', {}, `${inv.uses} utilisation${inv.uses > 1 ? 's' : ''}`))),
        h('button', { class: 'btn small', onclick: () => copyText(inviteUrl(inv.token)) }, 'Copier'),
        h('button', { class: 'icon-btn small', title: 'Révoquer', onclick: () => run(() => del(`/api/groups/${g.id}/invites/${inv.token}`)) }, icon('trash')))),
      h('div', { class: 'grow', style: 'margin:4px 0 8px' }, inviteEmails,
        h('small', { class: 'muted small-text' }, 'Facultatif : le lien sera envoyé par e-mail à ces adresses, séparées par des virgules.')),
      h('div', { class: 'row' }, inviteRole, h('button', {
        class: 'btn', onclick: () => run(async () => {
          const emails = inviteEmails.value.split(/[\s,;]+/).filter(Boolean);
          const res = await post(`/api/groups/${g.id}/invites`, { role: inviteRole.value, emails });
          if (res.sent) toast(`Invitation envoyée à ${res.sent} personne${res.sent > 1 ? 's' : ''}`);
          else if (res.invites[0]) copyText(inviteUrl(res.invites[0].token));
        }),
      }, icon('link'), 'Créer une invitation'))) : null,
    err,
    h('div', { class: 'subhead' }, `${data.members.length} membre${data.members.length > 1 ? 's' : ''}`),
    data.members.map((m) => h('div', { class: 'member' },
      avatar(m.name),
      h('div', { class: 'who' }, h('b', {}, m.name, m.id === me ? ' (vous)' : ''), h('span', {}, m.email)),
      isAdmin
        ? h('select', {
          class: 'input', title: ROLE_HELP[m.role],
          onchange: (e) => run(() => patch(`/api/groups/${g.id}/members/${m.id}`, { role: e.target.value })),
        }, MEMBER_ROLES.map(([v, l]) => h('option', { value: v, selected: v === m.role }, l)))
        : h('span', { class: 'pill', title: ROLE_HELP[m.role] }, ROLE_LABEL[m.role]),
      isAdmin && m.id !== me
        ? h('button', {
          class: 'icon-btn small', title: 'Retirer du groupe',
          onclick: async () => {
            if (await confirmDialog({ title: `Retirer ${m.name} ?`, message: 'Cette personne perdra l’accès aux fichiers du groupe.', confirm: 'Retirer', danger: true })) {
              run(() => del(`/api/groups/${g.id}/members/${m.id}`));
            }
          },
        }, icon('close')) : null)),
    h('div', { class: 'card-box' },
      h('h3', {}, 'Rôles'),
      h('dl', { class: 'small-text', style: 'display:grid;grid-template-columns:130px 1fr;gap:6px;margin:8px 0 0' },
        MEMBER_ROLES.map(([v, l]) => [h('dt', { style: 'font-weight:600' }, l), h('dd', { class: 'muted', style: 'margin:0' }, ROLE_HELP[v])])),
      h('p', { class: 'muted small-text', style: 'margin:12px 0 0' }, `Stockage du groupe : ${formatBytes(data.storage.used)} sur ${formatBytes(data.storage.quota)}`)))));
}

async function renderActivity(body, g) {
  const box = h('div', { class: 'content', style: 'padding-top:16px' }, h('p', { class: 'muted' }, 'Chargement…'));
  clear(body, box);
  try {
    const { activity } = await get(`/api/groups/${g.id}/activity`);
    clear(box, activity.length
      ? h('ul', { class: 'activity', style: 'max-width:760px' }, activity.map((a) => h('li', {},
        avatar(a.userName || '?', { small: true }),
        h('div', { class: 'grow' },
          h('div', {}, h('b', {}, a.userName || 'Compte supprimé'), ' ', actionLabel(a), a.item && a.action !== 'move' && a.action !== 'rename' ? ' ' : '',
            a.item ? h('a', {
              href: a.item.trashed ? '#' : openItemPath(a.item) || '#',
              onclick: (e) => {
                e.preventDefault();
                if (a.item.trashed) return toast('Cet élément est dans la corbeille');
                const path = openItemPath(a.item);
                if (path) { rememberBack(); navigate(path); }
              },
            }, fileIcon(a.item, 14), ' ', a.item.name) : null),
          h('div', { class: 'when' }, timeAgo(a.at))))))
      : h('div', { class: 'empty' }, icon('clock', 'big'), h('h3', {}, 'Pas encore d’activité'), h('p', {}, 'Les ajouts, modifications et partages des membres apparaîtront ici.')));
  } catch (err) { toastError(err); }
}

function editGroup(g, reload) {
  modal((box, close) => groupForm(box, close, {
    group: g, title: 'Modifier le groupe', submit: 'Enregistrer',
    onSave: async (body) => { await patch(`/api/groups/${g.id}`, body); await refreshGroups(); reload(); },
  }));
}

async function leaveGroup(g) {
  if (!(await confirmDialog({ title: `Quitter « ${g.name} » ?`, message: 'Vous perdrez l’accès aux fichiers du groupe. Un administrateur pourra vous réinviter.', confirm: 'Quitter', danger: true }))) return;
  try {
    await del(`/api/groups/${g.id}/members/${state.me.user.id}`);
    await refreshGroups();
    navigate('/drive');
  } catch (err) { toastError(err); }
}

function deleteGroup(g) {
  modal((box, close) => {
    const input = h('input', { class: 'input', placeholder: g.name, autocomplete: 'off' });
    const err = h('div', { class: 'err' });
    box.append(h('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        try {
          await del(`/api/groups/${g.id}`, { confirm: input.value });
          close();
          await refreshGroups();
          toast(`Groupe « ${g.name} » supprimé`);
          navigate('/drive');
        } catch (ex) { err.textContent = ex.message; }
      },
    },
    h('h2', {}, 'Supprimer le groupe ?'),
    h('p', {}, 'Tous les fichiers de l’espace du groupe seront ', h('b', {}, 'définitivement effacés'), ', pour tous les membres. Cette action est irréversible.'),
    h('label', { class: 'field' }, h('span', {}, `Tapez « ${g.name} » pour confirmer`), input),
    err,
    h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn ghost', onclick: close }, 'Annuler'), h('button', { class: 'btn danger solid' }, 'Supprimer définitivement'))));
  });
}

// /rejoindre/:token
export async function renderJoin(app, token) {
  const card = h('div', { class: 'auth-card', style: 'text-align:center' });
  clear(app, h('div', { class: 'public' },
    h('header', {}, h('a', { class: 'brand', href: '/drive', dataset: { link: '' } }, h('img', { src: '/img/logo.svg', alt: '' }), h('b', {}, 'Kenlod'))),
    h('main', {}, h('div', { class: 'lock' }, card))));
  if (!state.me?.user) {
    sessionStorage.setItem('kl_after_login', location.pathname);
    clear(card,
      icon('users', 'big'),
      h('h2', {}, 'Vous êtes invité·e à rejoindre un groupe'),
      h('p', { class: 'muted' }, 'Connectez-vous ou créez un compte Kenlod pour accepter l’invitation.'),
      h('div', { class: 'row', style: 'justify-content:center' },
        h('a', { class: 'btn primary', href: '/inscription', dataset: { link: '' } }, 'Créer un compte'),
        h('a', { class: 'btn', href: '/connexion', dataset: { link: '' } }, 'Se connecter')));
    return;
  }
  try {
    const inv = await get(`/api/invites/${token}`);
    if (inv.alreadyMember) return navigate(`/groupe/${inv.group.id}`, { replace: true });
    const btn = h('button', {
      class: 'btn primary',
      onclick: async () => {
        btn.disabled = true;
        try {
          const { groupId } = await post(`/api/invites/${token}/accept`);
          await refreshGroups();
          toast(`Bienvenue dans « ${inv.group.name} » !`);
          navigate(`/groupe/${groupId}`, { replace: true });
        } catch (err) { toastError(err); btn.disabled = false; }
      },
    }, 'Rejoindre le groupe');
    clear(card,
      avatar(inv.group.name, { group: true, color: inv.group.color }),
      h('h2', { style: 'margin-top:12px' }, inv.group.name),
      inv.group.description ? h('p', { class: 'muted' }, inv.group.description) : null,
      h('p', {}, `Vous rejoindrez ce groupe en tant que `, h('b', {}, ROLE_LABEL[inv.role].toLowerCase()), '.'),
      h('div', { class: 'row', style: 'justify-content:center' }, h('a', { class: 'btn ghost', href: '/drive', dataset: { link: '' } }, 'Plus tard'), btn));
  } catch (err) {
    clear(card, icon('users', 'big'), h('h2', {}, 'Invitation invalide'), h('p', { class: 'muted' }, err.message),
      h('a', { class: 'btn', href: '/drive', dataset: { link: '' } }, 'Aller à mon espace'));
  }
}
