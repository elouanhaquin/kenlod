import { get, put, post, del } from './api.js';
import { h, clear, icon, toast, toastError, copyText, modal, confirmDialog, showMenu, formatFull, debounce } from './ui.js';
import { state, navigate, setCleanup, atLeast, openItemPath } from './state.js';
import { editorTop } from './editor-common.js';

export const QUESTION_TYPES = [
  ['short', 'Réponse courte', 'edit'],
  ['long', 'Paragraphe', 'file'],
  ['single', 'Choix unique', 'check'],
  ['multiple', 'Cases à cocher', 'list'],
  ['dropdown', 'Liste déroulante', 'chevron'],
  ['scale', 'Échelle', 'chart'],
  ['number', 'Nombre', 'plus'],
  ['date', 'Date', 'clock'],
  ['email', 'Adresse e-mail', 'users'],
  ['section', 'Titre et texte', 'info'],
];
const TYPE_LABEL = Object.fromEntries(QUESTION_TYPES.map(([t, l]) => [t, l]));
const CHOICES = ['single', 'multiple', 'dropdown'];
const TABS = [['questions', 'Questions'], ['reponses', 'Réponses'], ['parametres', 'Paramètres']];

// Element.append() prints "null" for missing optional parts: skip them.
const add = (el, ...nodes) => el.append(...nodes.filter((n) => n != null && n !== false));
const newQuestionId = () => `q${Math.random().toString(36).slice(2, 9)}`;
export const answerUrl = (token) => `${location.origin}/f/${token}`;

function blankQuestion(type) {
  const q = { id: newQuestionId(), type, label: '', help: '' };
  if (type !== 'section') q.required = false;
  if (CHOICES.includes(type)) q.options = ['Option 1', 'Option 2'];
  if (type === 'scale') Object.assign(q, { min: 1, max: 5, minLabel: '', maxLabel: '' });
  return q;
}

// Grows a textarea with its content. (h() sets string props as attributes, which a textarea ignores: set the value here.)
function autoGrow(el, value) {
  if (value != null) el.value = value;
  const fit = () => { el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px`; };
  el.addEventListener('input', fit);
  requestAnimationFrame(fit);
  return el;
}

// /questionnaire/:id[/reponses|/parametres]
export async function renderForm(app, id, tab = 'questions') {
  let data;
  try {
    data = await get(`/api/items/${id}/form`);
  } catch (err) {
    clear(app, h('div', { class: 'public' },
      h('main', {}, h('div', { class: 'empty' }, icon('form', 'big'), h('h3', {}, 'Questionnaire introuvable'),
        h('p', {}, err.status === 404 ? 'Ce questionnaire n’existe pas, a été supprimé, ou vous n’y avez pas accès.' : err.message),
        h('a', { class: 'btn', href: '/drive', dataset: { link: '' } }, 'Retour à mon espace')))));
    return;
  }
  const { item } = data;
  const def = data.definition;
  let version = data.version;
  let settings = data.settings;
  let responseCount = data.responseCount;

  const sendBtn = h('button', { class: 'btn', onclick: () => openSend(data.token, settings) }, icon('send'), h('span', {}, 'Envoyer'));
  const previewBtn = h('a', { class: 'icon-btn', href: `/f/${data.token}`, target: '_blank', rel: 'noopener', title: 'Aperçu (formulaire de réponse)' }, icon('eye'));
  const { bar, status, canEdit } = editorTop(item, { extra: [previewBtn, sendBtn] });
  status.textContent = canEdit ? 'Toutes les modifications sont enregistrées' : 'Lecture seule';

  const tabs = h('nav', { class: 'tabs form-tabs' });
  const body = h('div', { class: 'form-body' });
  clear(app, h('div', { class: 'editor-shell form-editor' }, bar, tabs, body));

  // ---- Saving (last write wins, but a stale version is refused so nobody silently loses work) ----
  let saving = Promise.resolve();
  let dirty = false;
  const setStatus = (text, error = false) => { status.textContent = text; status.classList.toggle('error', error); };
  const flush = async () => {
    if (!dirty) return;
    dirty = false;
    setStatus('Enregistrement…');
    try {
      ({ version } = await put(`/api/items/${item.id}/form`, { definition: def, version }));
      setStatus(dirty ? 'Enregistrement…' : 'Toutes les modifications sont enregistrées');
    } catch (err) {
      if (err.data?.reason === 'conflict') {
        setStatus('Modifié ailleurs : rechargez la page', true);
        toast('Ce questionnaire a été modifié par quelqu’un d’autre.', { error: true, duration: 15000, action: { label: 'Recharger', run: () => location.reload() } });
      } else {
        dirty = true;
        setStatus('Échec de l’enregistrement, nouvel essai…', true);
        setTimeout(save, 4000);
      }
    }
  };
  const saveSoon = debounce(() => { saving = saving.then(flush); }, 600);
  const save = () => { dirty = true; setStatus('Modifications non enregistrées…'); saveSoon(); };
  const onLeave = (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } };
  window.addEventListener('beforeunload', onLeave);
  setCleanup(() => {
    window.removeEventListener('beforeunload', onLeave);
    if (dirty) flush();
  });

  const saveSettings = async (patch) => {
    try {
      ({ settings } = await put(`/api/items/${item.id}/form`, { settings: patch }));
      toast('Paramètres enregistrés');
    } catch (err) { toastError(err); }
    return settings;
  };

  const renderTabs = () => clear(tabs, TABS.map(([key, label]) => h('button', { class: key === tab ? 'active' : '', onclick: () => show(key) },
    label, key === 'reponses' && responseCount ? h('span', { class: 'count' }, String(responseCount)) : null)));
  const show = (name) => {
    tab = name;
    const path = `/questionnaire/${item.id}${name === 'questions' ? '' : `/${name}`}`;
    if (location.pathname !== path) history.replaceState({}, '', path);
    renderTabs();
    if (name === 'reponses') renderResponses();
    else if (name === 'parametres') renderSettings();
    else renderQuestions();
  };

  // ---- Questions ----
  function renderQuestions() {
    const list = h('div', { class: 'q-list' });
    const head = h('section', { class: 'q-card q-head' },
      h('input', {
        class: 'q-title', value: def.title, placeholder: item.name, readOnly: !canEdit, 'aria-label': 'Titre affiché',
        oninput: (e) => { def.title = e.target.value; save(); },
      }),
      autoGrow(h('textarea', {
        class: 'q-desc', rows: 1, readOnly: !canEdit,
        placeholder: canEdit ? 'Description : à quoi sert ce questionnaire, combien de temps il prend…' : '',
        oninput: (e) => { def.description = e.target.value; save(); },
      }), def.description));

    const renderList = () => {
      clear(list, def.questions.map((q, i) => questionCard(q, i)));
    };

    const addMenu = (at, index = def.questions.length) => showMenu(QUESTION_TYPES.map(([type, label, ic]) => ({
      label, icon: ic,
      run: () => {
        const q = blankQuestion(type);
        def.questions.splice(index, 0, q);
        save();
        renderList();
        list.querySelector(`[data-q="${q.id}"] .q-label`)?.focus();
      },
    })), at);

    function questionCard(q, i) {
      const card = h('section', { class: `q-card${q.type === 'section' ? ' q-section' : ''}`, dataset: { q: q.id } });
      const rerender = () => card.replaceWith(questionCard(q, def.questions.indexOf(q)));
      const move = (d) => {
        const j = i + d;
        if (j < 0 || j >= def.questions.length) return;
        [def.questions[i], def.questions[j]] = [def.questions[j], def.questions[i]];
        save();
        renderList();
        list.querySelector(`[data-q="${q.id}"]`)?.scrollIntoView({ block: 'nearest' });
      };

      if (!canEdit) {
        add(card,h('div', { class: 'q-label-ro' }, q.label || 'Question sans titre', q.required ? h('span', { class: 'req' }, ' *') : null),
          q.help ? h('p', { class: 'muted small-text' }, q.help) : null,
          h('div', { class: 'muted small-text' }, TYPE_LABEL[q.type]),
          CHOICES.includes(q.type) ? h('ul', { class: 'q-ro-options' }, q.options.map((o) => h('li', {}, o))) : null);
        return card;
      }

      const type = h('select', {
        class: 'input q-type', 'aria-label': 'Type de question',
        onchange: (e) => {
          const fresh = blankQuestion(e.target.value);
          // Keep what still makes sense: wording, help, required, options between choice types.
          Object.assign(fresh, { id: q.id, label: q.label, help: q.help });
          if ('required' in fresh && 'required' in q) fresh.required = q.required;
          if (CHOICES.includes(fresh.type) && CHOICES.includes(q.type)) fresh.options = q.options;
          Object.keys(q).forEach((k) => delete q[k]);
          Object.assign(q, fresh);
          save();
          rerender();
        },
      }, QUESTION_TYPES.map(([t, l]) => h('option', { value: t, selected: t === q.type }, l)));

      const label = autoGrow(h('textarea', {
        class: 'q-label', rows: 1, placeholder: q.type === 'section' ? 'Titre de la section' : 'Question',
        oninput: (e) => { q.label = e.target.value; save(); },
      }), q.label);
      const help = autoGrow(h('textarea', {
        class: 'q-help', rows: 1, placeholder: q.type === 'section' ? 'Texte (facultatif)' : 'Précision ou consigne (facultatif)',
        oninput: (e) => { q.help = e.target.value; save(); },
      }), q.help);

      add(card,h('div', { class: 'q-top' }, label, type), help, questionBody(q, rerender));

      add(card,h('div', { class: 'q-foot' },
        q.type !== 'section'
          ? h('label', { class: 'toggle' },
            h('input', { type: 'checkbox', checked: q.required, onchange: (e) => { q.required = e.target.checked; save(); } }),
            h('span', {}, 'Obligatoire'))
          : h('span'),
        h('div', { class: 'spacer' }),
        h('button', { class: 'icon-btn small', title: 'Monter', disabled: i === 0, onclick: () => move(-1) }, icon('arrowUp')),
        h('button', { class: 'icon-btn small', title: 'Descendre', disabled: i === def.questions.length - 1, onclick: () => move(1) }, icon('arrowDown')),
        h('button', {
          class: 'icon-btn small', title: 'Dupliquer',
          onclick: () => {
            def.questions.splice(i + 1, 0, { ...structuredClone(q), id: newQuestionId() });
            save();
            renderList();
          },
        }, icon('copy')),
        h('button', { class: 'icon-btn small', title: 'Insérer une question en dessous', onclick: (e) => addMenu(e.currentTarget, i + 1) }, icon('plus')),
        h('button', {
          class: 'icon-btn small', title: 'Supprimer',
          onclick: () => {
            def.questions.splice(def.questions.indexOf(q), 1);
            save();
            renderList();
            toast('Question supprimée', {
              action: { label: 'Annuler', run: () => { def.questions.splice(Math.min(i, def.questions.length), 0, q); save(); renderList(); } },
            });
          },
        }, icon('trash'))));
      return card;
    }

    renderList();
    clear(body, h('div', { class: 'form-page' },
      head,
      list,
      canEdit ? h('button', { class: 'btn q-add', onclick: (e) => addMenu(e.currentTarget) }, icon('plus'), 'Ajouter une question') : null,
      !def.questions.length ? h('p', { class: 'muted center' }, 'Aucune question pour l’instant.') : null));
  }

  function questionBody(q, rerender) {
    if (CHOICES.includes(q.type)) {
      const marker = (n) => h('span', { class: `q-marker ${q.type}` }, q.type === 'dropdown' ? `${n + 1}.` : '');
      const rows = q.options.map((o, n) => h('div', { class: 'q-option' },
        marker(n),
        h('input', {
          class: 'input', value: o, 'aria-label': `Option ${n + 1}`,
          oninput: (e) => { q.options[n] = e.target.value; save(); },
          onkeydown: (e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              q.options.splice(n + 1, 0, `Option ${q.options.length + 1}`);
              save();
              rerender();
              requestAnimationFrame(() => document.querySelectorAll(`[data-q="${q.id}"] .q-option input`)[n + 1]?.select());
            }
          },
        }),
        q.options.length > 1 ? h('button', {
          class: 'icon-btn small', title: 'Retirer l’option',
          onclick: () => { q.options.splice(n, 1); save(); rerender(); },
        }, icon('close')) : null));
      return h('div', { class: 'q-options' }, rows,
        h('button', {
          class: 'btn ghost small q-add-option',
          onclick: () => {
            q.options.push(`Option ${q.options.length + 1}`);
            save();
            rerender();
            requestAnimationFrame(() => [...document.querySelectorAll(`[data-q="${q.id}"] .q-option input`)].at(-1)?.select());
          },
        }, icon('plus'), 'Ajouter une option'));
    }
    if (q.type === 'scale') {
      const sel = (key, values) => h('select', { class: 'input', onchange: (e) => { q[key] = Number(e.target.value); save(); rerender(); } },
        values.map((v) => h('option', { value: v, selected: q[key] === v }, String(v))));
      const lbl = (key, ph) => h('input', { class: 'input', value: q[key], placeholder: ph, oninput: (e) => { q[key] = e.target.value; save(); } });
      return h('div', { class: 'q-scale-edit' },
        h('div', { class: 'row' }, 'De', sel('min', [0, 1]), 'à', sel('max', [2, 3, 4, 5, 6, 7, 8, 9, 10])),
        h('div', { class: 'row' }, h('span', { class: 'n' }, String(q.min)), lbl('minLabel', 'Libellé (facultatif), ex. Pas du tout')),
        h('div', { class: 'row' }, h('span', { class: 'n' }, String(q.max)), lbl('maxLabel', 'Libellé (facultatif), ex. Tout à fait')));
    }
    const placeholder = {
      short: 'Réponse courte', long: 'Réponse longue', number: 'Nombre', date: 'jj/mm/aaaa', email: 'nom@exemple.fr',
    }[q.type];
    return placeholder ? h('div', { class: 'q-placeholder' }, placeholder) : null;
  }

  // ---- Responses ----
  async function renderResponses() {
    if (!canEdit) {
      clear(body, h('div', { class: 'form-page' }, h('div', { class: 'empty' }, icon('lock', 'big'), h('h3', {}, 'Réservé aux éditeurs'),
        h('p', {}, 'Les réponses peuvent contenir des informations personnelles : seuls les éditeurs du questionnaire les voient.'))));
      return;
    }
    clear(body, h('div', { class: 'form-page' }, h('p', { class: 'muted center' }, 'Chargement des réponses…')));
    let res;
    try {
      if (dirty) await flush();
      res = await get(`/api/items/${item.id}/responses`);
    } catch (err) { toastError(err); return; }
    if (tab !== 'reponses') return;
    responseCount = res.responses.length;
    renderTabs();
    const { responses } = res;
    const questions = res.definition.questions.filter((q) => q.type !== 'section');
    let view = 'summary';
    let index = responses.length - 1;
    const content = h('div');

    const accepting = h('label', { class: 'toggle big' },
      h('input', {
        type: 'checkbox', checked: settings.accepting,
        onchange: async (e) => { await saveSettings({ accepting: e.target.checked }); e.target.checked = settings.accepting; },
      }),
      h('span', {}, 'Accepte les réponses'));

    const toSheet = async () => {
      try {
        const { item: sheet } = await post(`/api/items/${item.id}/responses/sheet`);
        toast(`Tableur « ${sheet.name} » créé`, { action: { label: 'Ouvrir', run: () => navigate(openItemPath(sheet)) } });
      } catch (err) { toastError(err); }
    };
    const clearAll = async () => {
      if (!await confirmDialog({ title: 'Supprimer toutes les réponses ?', message: `Les ${responses.length} réponses seront définitivement supprimées.`, confirm: 'Tout supprimer', danger: true })) return;
      try { await del(`/api/items/${item.id}/responses`); renderResponses(); } catch (err) { toastError(err); }
    };

    const views = h('div', { class: 'seg' });
    const renderView = () => {
      clear(views,
        h('button', { class: view === 'summary' ? 'active' : '', onclick: () => { view = 'summary'; renderView(); } }, 'Résumé'),
        h('button', { class: view === 'single' ? 'active' : '', onclick: () => { view = 'single'; renderView(); } }, 'Réponse par réponse'));
      if (!responses.length) {
        clear(content, h('div', { class: 'empty' }, icon('form', 'big'), h('h3', {}, 'Aucune réponse pour l’instant'),
          h('p', {}, 'Envoyez le lien du questionnaire : les réponses apparaîtront ici au fur et à mesure.'),
          h('button', { class: 'btn primary', onclick: () => openSend(data.token, settings) }, icon('send'), 'Envoyer le questionnaire')));
        return;
      }
      clear(content, view === 'summary' ? summary(questions, responses) : single());
    };

    function single() {
      const r = responses[index];
      const nav = h('div', { class: 'r-nav' },
        h('button', { class: 'icon-btn', title: 'Précédente', disabled: index === 0, onclick: () => { index -= 1; renderView(); } }, icon('back')),
        h('span', {}, `Réponse ${index + 1} sur ${responses.length}`),
        h('button', { class: 'icon-btn flip', title: 'Suivante', disabled: index === responses.length - 1, onclick: () => { index += 1; renderView(); } }, icon('back')),
        h('div', { class: 'spacer' }),
        h('span', { class: 'muted small-text' }, formatFull(r.at), r.user ? ` · ${r.user.name} (${r.user.email})` : ''),
        h('button', {
          class: 'icon-btn small', title: 'Supprimer cette réponse',
          onclick: async () => {
            if (!await confirmDialog({ title: 'Supprimer cette réponse ?', message: 'Elle sera définitivement supprimée.', confirm: 'Supprimer', danger: true })) return;
            try {
              await del(`/api/items/${item.id}/responses/${r.id}`);
              responses.splice(index, 1);
              responseCount = responses.length;
              renderTabs();
              index = Math.min(index, responses.length - 1);
              renderView();
            } catch (err) { toastError(err); }
          },
        }, icon('trash')));
      return h('div', {}, nav, questions.map((q) => {
        const v = r.answers[q.id];
        return h('section', { class: 'q-card r-answer' },
          h('div', { class: 'q-label-ro' }, q.label || 'Question sans titre'),
          v === undefined ? h('div', { class: 'muted' }, 'Sans réponse')
            : Array.isArray(v) ? h('ul', {}, v.map((x) => h('li', {}, x)))
              : h('div', { class: 'r-value' }, q.type === 'date' ? formatDay(v) : String(v)));
      }));
    }

    renderView();
    clear(body, h('div', { class: 'form-page' },
      h('section', { class: 'q-card r-head' },
        h('div', { class: 'r-count' }, h('b', {}, String(responses.length)), ` réponse${responses.length > 1 ? 's' : ''}`),
        h('div', { class: 'row wrap' },
          accepting,
          h('div', { class: 'spacer' }),
          h('a', { class: 'btn small', href: `/api/items/${item.id}/responses.csv`, download: '' }, icon('download'), 'CSV'),
          h('button', { class: 'btn small', onclick: toSheet }, icon('grid'), 'Créer un tableur'),
          h('button', { class: 'icon-btn small', title: 'Supprimer toutes les réponses', disabled: !responses.length, onclick: clearAll }, icon('trash'))),
        !settings.accepting ? h('p', { class: 'muted small-text', style: 'margin:8px 0 0' }, 'Le questionnaire est fermé : les personnes qui ouvrent le lien voient un message indiquant qu’il ne reçoit plus de réponses.') : null,
        views),
      content));
  }

  // ---- Settings ----
  function renderSettings() {
    const box = (input, title, text) => h('label', { class: 'setting' }, input, h('div', {}, h('b', {}, title), h('p', { class: 'muted small-text' }, text)));
    const check = (key, title, text, extra = {}) => box(h('input', {
      type: 'checkbox', checked: settings[key], disabled: !canEdit,
      onchange: async (e) => { await saveSettings({ [key]: e.target.checked, ...extra }); renderSettings(); },
    }), title, text);
    const pad = (n) => String(n).padStart(2, '0');
    const local = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
    const closes = h('input', {
      class: 'input', type: 'datetime-local', value: settings.closesAt ? local(settings.closesAt) : '', disabled: !canEdit,
      onchange: async (e) => { await saveSettings({ closesAt: e.target.value ? new Date(e.target.value).getTime() : null }); },
    });
    const confirmation = autoGrow(h('textarea', {
      class: 'input', rows: 2, readOnly: !canEdit,
      oninput: (e) => { def.confirmation = e.target.value; save(); },
    }), def.confirmation);
    clear(body, h('div', { class: 'form-page' },
      h('section', { class: 'q-card' },
        h('h3', {}, 'Réponses'),
        check('accepting', 'Accepter les réponses', 'Décochez pour fermer le questionnaire à tout moment.'),
        h('div', { class: 'setting' }, icon('clock'), h('div', { class: 'grow' }, h('b', {}, 'Clôture automatique'),
          h('p', { class: 'muted small-text' }, 'Facultatif : le questionnaire se ferme tout seul à cette date.'), closes)),
        check('requireLogin', 'Exiger un compte Kenlod', 'Les répondant·es doivent se connecter. Leur nom et leur adresse e-mail sont enregistrés avec leur réponse (ils en sont informés). Sinon, les réponses sont anonymes.', settings.requireLogin ? { onePerUser: false } : {}),
        check('onePerUser', 'Une seule réponse par personne', 'Exige un compte Kenlod. Pratique pour un vote ou une inscription.'),
        check('notify', 'M’avertir par e-mail', 'Un e-mail au propriétaire du questionnaire à chaque nouvelle réponse (au plus un toutes les 15 minutes).')),
      h('section', { class: 'q-card' },
        h('h3', {}, 'Message de confirmation'),
        h('p', { class: 'muted small-text' }, 'Affiché après l’envoi d’une réponse.'),
        confirmation)));
  }

  show(TABS.some(([k]) => k === tab) ? tab : 'questions');
}

const formatDay = (v) => { const [y, m, d] = String(v).split('-'); return d ? `${d}/${m}/${y}` : v; };

// Charts and lists for each question.
function summary(questions, responses) {
  const total = responses.length;
  return questions.map((q) => {
    const values = responses.map((r) => r.answers[q.id]).filter((v) => v !== undefined);
    const card = h('section', { class: 'q-card s-card' },
      h('div', { class: 'q-label-ro' }, q.label || 'Question sans titre'),
      h('div', { class: 'muted small-text' }, `${values.length} réponse${values.length > 1 ? 's' : ''}${values.length < total ? ` sur ${total}` : ''}`));
    if (!values.length) return card;

    const bars = (entries, base) => h('div', { class: 's-bars' }, entries.map(([label, n]) => h('div', { class: 's-bar' },
      h('div', { class: 's-label', title: label }, label),
      h('div', { class: 's-track' }, h('i', { style: { width: `${base ? (n / base) * 100 : 0}%` } })),
      h('div', { class: 's-n' }, `${n} · ${base ? Math.round((n / base) * 100) : 0} %`))));

    if (CHOICES.includes(q.type)) {
      const counts = new Map(q.options.map((o) => [o, 0]));
      for (const v of values) for (const x of [v].flat()) counts.set(x, (counts.get(x) || 0) + 1);
      add(card,bars([...counts], values.length));
      if (q.type === 'multiple') add(card,h('p', { class: 'muted small-text' }, 'Plusieurs choix possibles : les pourcentages sont calculés sur le nombre de répondant·es.'));
    } else if (q.type === 'scale') {
      const counts = [];
      for (let n = q.min; n <= q.max; n++) counts.push([String(n), values.filter((v) => v === n).length]);
      const avg = values.reduce((a, b) => a + b, 0) / values.length;
      add(card,h('div', { class: 's-big' }, h('b', {}, avg.toLocaleString('fr-FR', { maximumFractionDigits: 1 })), ` / ${q.max} en moyenne`),
        h('div', { class: 's-columns' }, counts.map(([label, n]) => {
          const max = Math.max(...counts.map((c) => c[1]), 1);
          return h('div', { class: 's-col', title: `${label} : ${n}` }, h('span', { class: 's-n' }, String(n)), h('i', { style: { height: `${(n / max) * 100}%` } }), h('span', {}, label));
        })),
        q.minLabel || q.maxLabel ? h('div', { class: 's-scale-labels muted small-text' }, h('span', {}, q.minLabel), h('span', {}, q.maxLabel)) : null);
    } else if (q.type === 'number') {
      const sum = values.reduce((a, b) => a + b, 0);
      const fmt = (n) => n.toLocaleString('fr-FR', { maximumFractionDigits: 2 });
      add(card,h('div', { class: 's-stats' },
        [['Moyenne', sum / values.length], ['Total', sum], ['Minimum', Math.min(...values)], ['Maximum', Math.max(...values)]]
          .map(([l, v]) => h('div', {}, h('span', { class: 'muted small-text' }, l), h('b', {}, fmt(v))))));
    } else {
      const shown = values.slice(-100).reverse();
      add(card,h('ul', { class: 's-texts' }, shown.map((v) => h('li', {}, q.type === 'date' ? formatDay(v) : String(v)))),
        values.length > shown.length ? h('p', { class: 'muted small-text' }, `… et ${values.length - shown.length} autres (voir l’export CSV)`) : null);
    }
    return card;
  });
}

function openSend(token, settings) {
  modal((box, close) => {
    const url = answerUrl(token);
    box.append(
      h('h2', {}, 'Envoyer le questionnaire'),
      h('p', { class: 'muted' }, 'Partagez ce lien par e-mail, sur votre site, vos réseaux ou dans un message. Les personnes qui le reçoivent peuvent répondre, sans pouvoir modifier le questionnaire ni voir les autres réponses.'),
      h('div', { class: 'link-row' }, icon('link'), h('div', { class: 'info' }, h('code', {}, url)),
        h('button', { class: 'btn small primary', onclick: () => copyText(url) }, 'Copier')),
      h('p', { class: 'muted small-text' },
        settings.requireLogin ? 'Un compte Kenlod est demandé pour répondre (voir les paramètres).' : 'Réponses anonymes, sans compte (modifiable dans les paramètres).',
        settings.accepting ? '' : ' Attention : le questionnaire n’accepte pas de réponses pour le moment.'),
      h('div', { class: 'actions' },
        h('a', { class: 'btn ghost', href: url, target: '_blank', rel: 'noopener' }, icon('eye'), 'Ouvrir'),
        h('button', { class: 'btn primary', onclick: close }, 'Terminé')));
  });
}
