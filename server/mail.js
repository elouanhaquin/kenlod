import fs from 'node:fs';
import path from 'node:path';
import nodemailer from 'nodemailer';
import { config } from './config.js';
import { newId } from './util.js';

const smtp = config.mail.host
  ? nodemailer.createTransport({
    host: config.mail.host,
    port: config.mail.port,
    secure: config.mail.port === 465,
    requireTLS: config.mail.port !== 465,
    auth: { user: config.mail.user, pass: config.mail.pass },
  })
  : null;

// "Kenlod <contact@kenlod.fr>" → { name, email }
function parseAddress(from) {
  const m = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(from);
  return m ? { name: m[1] || undefined, email: m[2] } : { email: from.trim() };
}

// Brevo's HTTP API: works where outgoing SMTP ports are blocked (DigitalOcean droplets).
async function sendWithBrevo({ to, subject, text, html }) {
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': config.mail.brevoKey, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      sender: parseAddress(config.mail.from), to: [{ email: to }], subject, textContent: text, htmlContent: html,
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Brevo ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// One layout for every message: a title, a few paragraphs, an optional button, and a footer.
function render({ title, paragraphs, button, footer }) {
  const text = [title, '', ...paragraphs, ...(button ? ['', `${button.label} : ${button.url}`] : []), '', footer || '', '—', 'Kenlod · ' + config.appUrl]
    .join('\n');
  const html = `<!doctype html><html lang="fr"><body style="margin:0;background:#f6f5f1;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;color:#14213d">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#fff;border-radius:14px;overflow:hidden;border:1px solid #e3e5ea">
<tr><td style="background:#14213d;padding:18px 28px;color:#fff;font-size:20px;font-weight:700">Kenlod</td></tr>
<tr><td style="padding:28px">
<h1 style="font-family:Georgia,serif;font-size:22px;margin:0 0 16px">${esc(title)}</h1>
${paragraphs.map((p) => `<p style="font-size:15px;line-height:1.6;margin:0 0 14px;color:#3b4660">${esc(p)}</p>`).join('')}
${button ? `<p style="margin:24px 0"><a href="${esc(button.url)}" style="display:inline-block;background:#f2b705;color:#14213d;text-decoration:none;font-weight:700;padding:13px 22px;border-radius:999px">${esc(button.label)}</a></p>
<p style="font-size:12px;color:#6b7489;word-break:break-all;margin:0">Si le bouton ne fonctionne pas, copiez ce lien : ${esc(button.url)}</p>` : ''}
${footer ? `<p style="font-size:13px;color:#6b7489;margin:22px 0 0">${esc(footer)}</p>` : ''}
</td></tr></table>
<p style="font-size:12px;color:#6b7489;margin:16px 0 0">Kenlod · le drive collaboratif des associations bretonnes</p>
</td></tr></table></body></html>`;
  return { text, html };
}

export async function sendMail(to, subject, content) {
  const { text, html } = render(content);
  if (config.mail.brevoKey) return sendWithBrevo({ to, subject, text, html });
  if (smtp) return smtp.sendMail({ from: config.mail.from, to, subject, text, html });
  fs.mkdirSync(config.mail.outbox, { recursive: true });
  fs.writeFileSync(path.join(config.mail.outbox, `${Date.now()}-${newId()}.json`), JSON.stringify({ to, subject, text }));
  if (!config.prod) console.log(`[mail] ${to} — ${subject}\n${text}\n`);
}

// Mail failures must not break the request that triggered them; they are logged instead.
export function sendMailLater(to, subject, content) {
  sendMail(to, subject, content).catch((err) => console.error(`[mail] échec de l'envoi à ${to}:`, err.message));
}

export const mails = {
  verify: (name, url) => ['Confirmez votre adresse e-mail', {
    title: `Degemer mat, ${name} !`,
    paragraphs: ['Bienvenue sur Kenlod. Pour activer votre compte, confirmez votre adresse e-mail. Le lien est valable 24 heures.'],
    button: { label: 'Confirmer mon adresse', url },
    footer: "Vous n'avez pas créé de compte Kenlod ? Ignorez ce message, aucun compte ne sera activé.",
  }],
  reset: (name, url) => ['Réinitialiser votre mot de passe', {
    title: 'Nouveau mot de passe',
    paragraphs: [`Bonjour ${name}, une demande de réinitialisation du mot de passe a été faite pour votre compte Kenlod. Le lien est valable 1 heure et ne sert qu'une fois.`],
    button: { label: 'Choisir un nouveau mot de passe', url },
    footer: "Vous n'êtes pas à l'origine de cette demande ? Ignorez ce message : votre mot de passe reste inchangé.",
  }],
  invite: (inviter, group, url) => [`${inviter} vous invite dans « ${group} » sur Kenlod`, {
    title: `Rejoignez « ${group} »`,
    paragraphs: [`${inviter} vous invite à rejoindre le groupe de travail « ${group} » sur Kenlod, pour partager ses documents, tableurs et fichiers. L'invitation est valable 14 jours.`],
    button: { label: 'Rejoindre le groupe', url },
    footer: "Pas encore de compte ? Vous pourrez en créer un gratuitement en suivant le lien.",
  }],
  formResponse: (form, count, url) => [`Nouvelle réponse à « ${form} »`, {
    title: 'Nouvelle réponse',
    paragraphs: [`Votre questionnaire « ${form} » a reçu une nouvelle réponse (${count} au total).`],
    button: { label: 'Voir les réponses', url },
    footer: 'Pour éviter les avalanches, vous recevez au plus un e-mail toutes les 15 minutes par questionnaire. Désactivez ces alertes dans les paramètres du questionnaire.',
  }],
  addedToGroup: (inviter, group, url) => [`Vous avez été ajouté·e à « ${group} »`, {
    title: `Bienvenue dans « ${group} »`,
    paragraphs: [`${inviter} vous a ajouté·e au groupe de travail « ${group} » sur Kenlod.`],
    button: { label: 'Ouvrir le groupe', url },
  }],
};
