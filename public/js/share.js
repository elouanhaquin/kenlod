import { get, post, patch, del } from './api.js';
import { h, clear, icon, fileIcon, avatar, modal, toastError, copyText, formatFull, debounce, ROLE_LABEL } from './ui.js';
import { state, atLeast } from './state.js';

const roleSelect = (value, onchange, disabled = false) => h('select', { class: 'input', onchange, disabled },
  h('option', { value: 'viewer', selected: value === 'viewer' }, 'Lecteur'),
  h('option', { value: 'editor', selected: value === 'editor' }, 'Éditeur'));

export const linkUrl = (token) => `${location.origin}/s/${token}`;

export async function openShare(item, { focusLinks = false, onChange } = {}) {
  let data;
  try {
    data = await get(`/api/items/${item.id}/shares`);
  } catch (err) {
    return toastError(err);
  }
  let changed = false;
  const canEdit = atLeast(data.role, 'editor');

  modal((box, close) => {
    const err = h('div', { class: 'err' });
    const peopleSlot = h('div', { class: 'people' });
    const linksSlot = h('div');
    let choice = null; // { type: 'user', email } | { type: 'group', groupId, name }

    const apply = (next) => {
      Object.assign(data, next);
      changed = true;
      renderPeople();
      renderLinks();
    };
    const run = async (fn) => {
      err.textContent = '';
      try { apply(await fn()); } catch (ex) { err.textContent = ex.message; }
    };

    // --- Add people / groups ---
    const input = h('input', {
      class: 'input', placeholder: 'Adresse e-mail ou nom d’un groupe', autocomplete: 'off', 'aria-label': 'Ajouter des personnes ou des groupes',
    });
    const role = roleSelect('viewer');
    const suggest = h('div', { class: 'suggest', hidden: true });
    let options = [];
    let active = -1;

    const pick = (opt) => {
      choice = opt;
      input.value = opt.type === 'group' ? `Groupe : ${opt.name}` : opt.email;
      suggest.hidden = true;
      input.focus();
    };
    const renderSuggest = () => {
      clear(suggest, options.map((o, i) => h('button', {
        type: 'button', class: i === active ? 'on' : '', onmousedown: (e) => { e.preventDefault(); pick(o); },
      },
      o.type === 'group' ? avatar(o.name, { small: true, group: true, color: o.color }) : avatar(o.name, { small: true }),
      h('span', { class: 'who' }, h('b', {}, o.name), h('span', {}, o.type === 'group' ? `Groupe · ${o.members} membre${o.members > 1 ? 's' : ''}` : o.email)))));
      suggest.hidden = !options.length;
    };
    const lookup = debounce(async (q) => {
      const ql = q.toLowerCase();
      const groups = state.groups
        .filter((g) => g.name.toLowerCase().includes(ql) && item.space !== `g:${g.id}`)
        .map((g) => ({ type: 'group', groupId: g.id, name: g.name, color: g.color, members: g.members }));
      let users = [];
      if (q.length >= 2) {
        try { users = (await get(`/api/users/suggest?q=${encodeURIComponent(q)}`)).users; } catch { /* ignore */ }
      }
      if (input.value.trim() !== q) return;
      options = [...users.map((u) => ({ type: 'user', email: u.email, name: u.name })), ...groups].slice(0, 8);
      active = options.length ? 0 : -1;
      renderSuggest();
    }, 180);
    input.addEventListener('input', () => {
      choice = null;
      const q = input.value.trim();
      if (!q) { suggest.hidden = true; return; }
      lookup(q);
    });
    input.addEventListener('keydown', (e) => {
      if (suggest.hidden || !options.length) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); active = (active + 1) % options.length; renderSuggest(); }
      if (e.key === 'ArrowUp') { e.preventDefault(); active = (active - 1 + options.length) % options.length; renderSuggest(); }
      if (e.key === 'Enter' && active >= 0) { e.preventDefault(); pick(options[active]); }
      if (e.key === 'Escape') { e.stopPropagation(); suggest.hidden = true; }
    });
    input.addEventListener('blur', () => setTimeout(() => { suggest.hidden = true; }, 120));

    const addForm = h('form', {
      onsubmit: (e) => {
        e.preventDefault();
        const target = choice || { type: 'user', email: input.value.trim() };
        if (!target.email && !target.groupId) return input.focus();
        run(async () => {
          const res = await post(`/api/items/${item.id}/shares`, {
            role: role.value, ...(target.type === 'group' ? { groupId: target.groupId } : { email: target.email }),
          });
          input.value = '';
          choice = null;
          return res;
        });
      },
    }, h('div', { class: 'share-add' }, input, role, suggest),
    h('div', { class: 'row', style: 'justify-content:flex-end;margin-top:8px' }, h('button', { class: 'btn primary small' }, 'Partager')));

    // --- People with access ---
    function renderPeople() {
      const o = data.owner;
      clear(peopleSlot,
        h('div', { class: 'person' },
          o.type === 'group' ? avatar(o.name, { group: true, color: o.color }) : avatar(o.name),
          h('div', { class: 'who' },
            h('b', {}, o.type === 'group' ? `Tous les membres de « ${o.name} »` : o.name),
            h('span', {}, o.type === 'group' ? `Espace du groupe · ${o.members} membre${o.members > 1 ? 's' : ''}` : o.email)),
          h('span', { class: 'muted small-text' }, o.type === 'group' ? 'Selon leur rôle' : 'Propriétaire')),
        data.shares.map((s) => h('div', { class: 'person' },
          s.type === 'group' ? avatar(s.name, { group: true, color: s.color }) : avatar(s.name),
          h('div', { class: 'who' },
            h('b', {}, s.type === 'group' ? `Groupe ${s.name}` : s.name),
            h('span', {}, s.inheritedFrom ? `Accès hérité du dossier « ${s.inheritedFrom.name} »` : s.type === 'group' ? 'Tous les membres du groupe' : s.email)),
          s.inheritedFrom || !canEdit
            ? h('span', { class: 'muted small-text' }, ROLE_LABEL[s.role])
            : [
              roleSelect(s.role, (e) => run(() => patch(`/api/shares/${s.id}`, { role: e.target.value }))),
              h('button', {
                class: 'icon-btn small', title: 'Retirer l’accès', 'aria-label': `Retirer l’accès de ${s.name}`,
                onclick: () => run(() => del(`/api/shares/${s.id}`)),
              }, icon('close')),
            ])));
    }

    // --- Public links ---
    const password = h('input', { class: 'input', type: 'text', placeholder: 'Facultatif', autocomplete: 'off' });
    const expiry = h('select', { class: 'input' },
      h('option', { value: '0' }, 'Jamais'),
      h('option', { value: '1' }, '1 jour'),
      h('option', { value: '7', selected: true }, '7 jours'),
      h('option', { value: '30' }, '30 jours'),
      h('option', { value: '90' }, '3 mois'));
    function renderLinks() {
      if (!canEdit) return clear(linksSlot);
      if (item.kind === 'form') {
        return clear(linksSlot,
          h('div', { class: 'subhead' }, 'Recueillir des réponses'),
          h('p', { class: 'muted small-text', style: 'margin:0' },
            'Les personnes ajoutées ci-dessus peuvent modifier le questionnaire et voir les réponses. Pour faire répondre, utilisez le bouton « Envoyer » du questionnaire : le lien de réponse ne donne accès ni aux questions en modification, ni aux réponses des autres.'));
      }
      clear(linksSlot,
        h('div', { class: 'subhead' }, 'Liens publics'),
        h('p', { class: 'muted small-text', style: 'margin:0 0 10px' },
          'Toute personne disposant du lien peut consulter et télécharger, sans créer de compte. Ajoutez un mot de passe pour les documents sensibles.'),
        data.links.map((l) => h('div', { class: `link-row${l.expired ? ' expired' : ''}` },
          icon('link'),
          h('div', { class: 'info' },
            h('code', {}, linkUrl(l.token)),
            h('div', { class: 'meta' },
              h('span', {}, l.hasPassword ? 'Protégé par mot de passe' : 'Sans mot de passe'),
              h('span', {}, l.expired ? 'Expiré' : l.expiresAt ? `Expire le ${formatFull(l.expiresAt)}` : 'Sans expiration'),
              h('span', {}, `${l.views} consultation${l.views > 1 ? 's' : ''}`))),
          !l.expired ? h('button', { class: 'btn small', onclick: () => copyText(linkUrl(l.token)) }, 'Copier') : null,
          h('button', { class: 'icon-btn small', title: 'Supprimer le lien', onclick: () => run(() => del(`/api/links/${l.id}`)) }, icon('trash')))),
        h('form', {
          class: 'link-form',
          onsubmit: (e) => {
            e.preventDefault();
            run(async () => {
              const res = await post(`/api/items/${item.id}/links`, { password: password.value || null, expiresInDays: Number(expiry.value) });
              password.value = '';
              const fresh = res.links.at(-1);
              if (fresh) copyText(linkUrl(fresh.token));
              return res;
            });
          },
        },
        h('label', { class: 'field' }, h('span', {}, 'Mot de passe'), password),
        h('label', { class: 'field' }, h('span', {}, 'Expiration'), expiry),
        h('button', { class: 'btn' }, icon('link'), 'Créer un lien')));
    }

    box.append(
      h('h2', {}, fileIcon(item), h('span', { class: 'nm' }, `Partager « ${item.name} »`)),
      canEdit ? addForm : h('p', { class: 'muted' }, 'Vous pouvez consulter cet élément, mais seuls les éditeurs peuvent le partager.'),
      err,
      h('div', { class: 'subhead' }, 'Personnes et groupes ayant accès'),
      peopleSlot,
      linksSlot,
      h('div', { class: 'actions' }, h('button', { class: 'btn primary', onclick: close }, 'Terminé')));
    renderPeople();
    renderLinks();
    if (focusLinks) requestAnimationFrame(() => password.scrollIntoView({ block: 'center' }));
  }, { wide: true, onClose: () => changed && onChange?.() });
}
