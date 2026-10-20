import { get, post } from './api.js';
import { h, clear, icon, toastError } from './ui.js';
import { state } from './state.js';

function page(app, ...content) {
  clear(app, h('div', { class: 'public answer-page' },
    h('header', {}, h('a', { class: 'brand', href: '/' }, h('img', { src: '/img/logo.svg', alt: '' }), h('b', {}, 'Kenlod'))),
    h('main', {}, h('div', { class: 'answer' }, ...content)),
    h('footer', {}, 'Questionnaire créé avec ', h('a', { href: '/' }, 'Kenlod'), ', le drive collaboratif des associations bretonnes. ',
      h('a', { href: '/confidentialite' }, 'Confidentialité'))));
}

function notice(app, ic, title, text, ...extra) {
  page(app, h('section', { class: 'q-card answer-notice' }, icon(ic, 'big'), h('h1', {}, title), text ? h('p', {}, text) : null, ...extra));
}

// /f/:token — anyone with the link can answer (or only signed-in people, if the form says so).
export async function renderAnswer(app, token) {
  let form;
  try {
    form = await get(`/api/f/${token}`);
  } catch (err) {
    return notice(app, 'form', 'Questionnaire introuvable', err.status === 404 ? 'Ce lien ne correspond à aucun questionnaire, ou il a été supprimé.' : err.message);
  }
  document.title = `${form.title} — Kenlod`;
  if (!form.open) return notice(app, 'lock', form.title, 'Ce questionnaire ne reçoit plus de réponses. Merci de votre intérêt !');
  if (form.requireLogin && !form.user) {
    sessionStorage.setItem('kl_after_login', location.pathname);
    return notice(app, 'users', form.title, 'Pour répondre à ce questionnaire, connectez-vous ou créez un compte Kenlod (gratuit).',
      h('div', { class: 'row', style: 'justify-content:center' },
        h('a', { class: 'btn primary', href: '/connexion', dataset: { link: '' } }, 'Se connecter'),
        h('a', { class: 'btn', href: '/inscription', dataset: { link: '' } }, 'Créer un compte')));
  }
  if (form.alreadyAnswered) return notice(app, 'check', form.title, 'Vous avez déjà répondu à ce questionnaire. Merci !');

  const answers = {};
  const fields = new Map(); // question id → { el, error }
  const err = h('div', { class: 'err', role: 'alert' });
  const submit = h('button', { class: 'btn primary', type: 'submit' }, icon('send'), 'Envoyer');
  const honeypot = h('input', { type: 'text', name: 'website', tabIndex: -1, autocomplete: 'off', 'aria-hidden': 'true', class: 'hp' });

  const question = (q) => {
    const errorEl = h('div', { class: 'q-error', role: 'alert' });
    const name = `q-${q.id}`;
    const set = (v) => { answers[q.id] = v; errorEl.textContent = ''; card.classList.remove('invalid'); };
    let input;
    if (q.type === 'section') {
      return h('section', { class: 'q-card a-section' }, q.label ? h('h2', {}, q.label) : null, q.help ? h('p', { class: 'a-help' }, q.help) : null);
    }
    if (q.type === 'single' || q.type === 'multiple') {
      const multi = q.type === 'multiple';
      input = h('div', { class: 'a-choices', role: multi ? 'group' : 'radiogroup' }, q.options.map((o) => h('label', { class: 'a-choice' },
        h('input', {
          type: multi ? 'checkbox' : 'radio', name, value: o,
          onchange: () => set(multi ? [...input.querySelectorAll('input:checked')].map((x) => x.value) : o),
        }),
        h('span', {}, o))));
    } else if (q.type === 'dropdown') {
      input = h('select', { class: 'input', name, onchange: (e) => set(e.target.value || undefined) },
        h('option', { value: '' }, 'Choisir…'), q.options.map((o) => h('option', { value: o }, o)));
    } else if (q.type === 'scale') {
      const opts = [];
      for (let n = q.min; n <= q.max; n++) opts.push(n);
      input = h('div', { class: 'a-scale' },
        q.minLabel ? h('span', { class: 'a-scale-label' }, q.minLabel) : null,
        h('div', { class: 'a-scale-opts', role: 'radiogroup' }, opts.map((n) => h('label', {},
          h('input', { type: 'radio', name, value: n, onchange: () => set(n) }), h('span', {}, String(n))))),
        q.maxLabel ? h('span', { class: 'a-scale-label' }, q.maxLabel) : null);
    } else if (q.type === 'long') {
      input = h('textarea', { class: 'input', name, rows: 4, maxLength: 10000, oninput: (e) => set(e.target.value) });
    } else {
      const type = { number: 'text', date: 'date', email: 'email' }[q.type] || 'text';
      input = h('input', {
        class: 'input', name, type, maxLength: 1000,
        inputMode: q.type === 'number' ? 'decimal' : undefined,
        autocomplete: q.type === 'email' ? 'email' : 'off',
        oninput: (e) => set(e.target.value),
      });
    }
    const card = h('section', { class: 'q-card a-question' },
      h('label', { class: 'a-label', for: input.tagName !== 'DIV' ? name : undefined },
        q.label || 'Question sans titre', q.required ? h('span', { class: 'req', title: 'Obligatoire' }, ' *') : null),
      q.help ? h('p', { class: 'a-help' }, q.help) : null,
      input,
      errorEl);
    if (input.tagName !== 'DIV') input.id = name;
    fields.set(q.id, { card, errorEl, q });
    return card;
  };

  const validate = () => {
    let first = null;
    for (const { card, errorEl, q } of fields.values()) {
      const v = answers[q.id];
      const empty = v === undefined || (typeof v === 'string' && !v.trim()) || (Array.isArray(v) && !v.length);
      let msg = '';
      if (q.required && empty) msg = 'Cette question est obligatoire';
      else if (!empty && q.type === 'number' && !Number.isFinite(Number(String(v).replace(',', '.').replace(/\s/g, '')))) msg = 'Indiquez un nombre';
      else if (!empty && q.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) msg = 'Adresse e-mail invalide';
      errorEl.textContent = msg;
      card.classList.toggle('invalid', !!msg);
      if (msg && !first) first = card;
    }
    first?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return !first;
  };

  const formEl = h('form', {
    class: 'answer-form', novalidate: true,
    onsubmit: async (e) => {
      e.preventDefault();
      err.textContent = '';
      if (!validate()) return;
      submit.disabled = true;
      try {
        const res = await post(`/api/f/${token}`, { answers, website: honeypot.value });
        notice(app, 'check', 'Réponse envoyée', res.confirmation || 'Merci, votre réponse a bien été enregistrée !',
          !form.alreadyAnswered && !form.requireLogin ? h('button', { class: 'btn', onclick: () => renderAnswer(app, token) }, 'Envoyer une autre réponse') : null);
        window.scrollTo(0, 0);
      } catch (ex) {
        err.textContent = ex.message;
        submit.disabled = false;
      }
    },
  },
  h('section', { class: 'q-card a-head' },
    h('h1', {}, form.title),
    form.description ? h('p', { class: 'a-desc' }, form.description) : null,
    form.questions.some((q) => q.required) ? h('p', { class: 'muted small-text' }, h('span', { class: 'req' }, '*'), ' Réponse obligatoire') : null,
    form.requireLogin && form.user
      ? h('p', { class: 'a-identity small-text' }, icon('users'), `Vous répondez en tant que ${form.user.name} (${form.user.email}) : votre nom et votre adresse seront enregistrés avec votre réponse.`)
      : h('p', { class: 'a-identity small-text' }, icon('lock'), 'Réponse anonyme : votre nom et votre adresse e-mail ne sont pas enregistrés, sauf si une question vous les demande.')),
  form.questions.map(question),
  h('div', { class: 'hp-wrap', 'aria-hidden': 'true' }, honeypot),
  err,
  h('div', { class: 'answer-actions' }, submit));

  page(app, formEl);
  if (state.me?.mustVerify && form.requireLogin) toastError(new Error('Confirmez d’abord votre adresse e-mail pour répondre.'));
}
