import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { one, run } from '../db.js';
import { config } from '../config.js';
import { spaceUsage, spaceQuota } from '../access.js';
import { mails, sendMailLater } from '../mail.js';
import {
  HttpError, newId, newToken, now, sha256, hashPassword, verifyPassword, validEmail, parseCookies, safeEqual,
} from '../util.js';

const SESSION_COOKIE = 'kl_sid';
const SESSION_DAYS = 30;

// Resolves the session cookie to { session, user }, or null.
export function sessionFromCookie(cookieHeader) {
  const token = parseCookies(cookieHeader)[SESSION_COOKIE];
  if (!token) return null;
  const s = one(
    `SELECT s.token_hash, s.csrf, s.expires_at, u.id, u.email, u.name, u.is_admin, u.email_verified_at
     FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
    sha256(token),
  );
  if (!s || s.expires_at <= now()) return null;
  return {
    session: { tokenHash: s.token_hash, csrf: s.csrf },
    user: { id: s.id, email: s.email, name: s.name, isAdmin: !!s.is_admin, verified: !!s.email_verified_at },
  };
}

// Until they confirm their e-mail address, new accounts can only reach the auth routes.
export const isBlocked = (user) => config.requireVerification && !user.verified;

// Attaches req.user / req.session when the session cookie is valid.
export function loadSession(req, _res, next) {
  const found = sessionFromCookie(req.headers.cookie);
  if (found) {
    req.session = found.session;
    req.user = found.user;
  }
  next();
}

// Unsafe methods need the custom header (blocks cross-site forms) and, once logged in, the session's CSRF token.
export function csrfGuard(req, _res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get('x-kenlod') !== '1') return next(new HttpError(403, 'Requête refusée'));
  if (req.session && !safeEqual(req.get('x-csrf') || '', req.session.csrf)) {
    return next(new HttpError(403, 'Session expirée, rechargez la page'));
  }
  next();
}

export function requireAuth(req, _res, next) {
  if (!req.user) return next(new HttpError(401, 'Connexion requise'));
  if (isBlocked(req.user)) {
    return next(Object.assign(new HttpError(403, 'Confirmez d’abord votre adresse e-mail'), { reason: 'unverified' }));
  }
  next();
}

const VERIFY_TTL = 24 * 3600e3;
const RESET_TTL = 3600e3;

function createEmailToken(userId, purpose, ttl) {
  run('DELETE FROM email_tokens WHERE user_id = ? AND purpose = ?', userId, purpose);
  const token = newToken(32);
  run('INSERT INTO email_tokens (token_hash, user_id, purpose, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
    sha256(token), userId, purpose, now(), now() + ttl);
  return token;
}

// Returns the user id the token belongs to and burns the token, or throws.
function consumeEmailToken(token, purpose) {
  const row = one('SELECT user_id, expires_at FROM email_tokens WHERE token_hash = ? AND purpose = ?', sha256(String(token || '')), purpose);
  if (!row || row.expires_at <= now()) throw new HttpError(400, 'Ce lien a expiré ou a déjà servi');
  run('DELETE FROM email_tokens WHERE user_id = ? AND purpose = ?', row.user_id, purpose);
  return row.user_id;
}

function sendVerification(user) {
  const token = createEmailToken(user.id, 'verify', VERIFY_TTL);
  sendMailLater(user.email, ...mails.verify(user.name, `${config.appUrl}/verifier/${token}`));
}

function startSession(res, userId) {
  const token = newToken(32);
  const csrf = newToken(18);
  const expires = now() + SESSION_DAYS * 86400e3;
  run('INSERT INTO sessions (token_hash, user_id, csrf, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
    sha256(token), userId, csrf, now(), expires);
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true, secure: config.prod, sameSite: 'lax', path: '/', expires: new Date(expires),
  });
  return csrf;
}

function mePayload(user, csrf) {
  const space = `u:${user.id}`;
  return {
    user: { id: user.id, email: user.email, name: user.name, isAdmin: !!user.isAdmin, verified: !!user.verified },
    mustVerify: isBlocked(user),
    csrf,
    storage: { used: spaceUsage(space), quota: spaceQuota(space) },
    registration: config.registration,
  };
}

const limiter = rateLimit({
  windowMs: 15 * 60e3, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false,
  message: { error: 'Trop de tentatives, réessayez dans quelques minutes' },
});

const r = Router();

r.get('/me', (req, res) => {
  if (!req.user) return res.json({ user: null, registration: config.registration });
  res.json(mePayload(req.user, req.session.csrf));
});

r.post('/register', limiter, async (req, res) => {
  if (config.registration !== 'open') throw new HttpError(403, 'Les inscriptions sont fermées');
  const email = String(req.body?.email || '').trim().toLowerCase();
  const name = String(req.body?.name || '').trim().slice(0, 80);
  const password = String(req.body?.password || '');
  if (!validEmail(email)) throw new HttpError(400, 'Adresse e-mail invalide');
  if (name.length < 2) throw new HttpError(400, 'Indiquez votre nom');
  if (password.length < 10) throw new HttpError(400, 'Le mot de passe doit faire au moins 10 caractères');
  if (one('SELECT 1 FROM users WHERE email = ?', email)) throw new HttpError(409, 'Un compte existe déjà avec cette adresse');
  const id = newId();
  const isFirst = !one('SELECT 1 FROM users LIMIT 1');
  const verified = config.requireVerification ? null : now();
  run('INSERT INTO users (id, email, name, password_hash, is_admin, created_at, email_verified_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    id, email, name, await hashPassword(password), isFirst ? 1 : 0, now(), verified);
  const user = { id, email, name, isAdmin: isFirst, verified: !!verified };
  if (!verified) sendVerification(user);
  const csrf = startSession(res, id);
  res.status(201).json(mePayload(user, csrf));
});

r.post('/verify', limiter, (req, res) => {
  const userId = consumeEmailToken(req.body?.token, 'verify');
  run('UPDATE users SET email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?', now(), userId);
  res.json({ ok: true });
});

r.post('/verify/resend', limiter, (req, res) => {
  if (!req.user) throw new HttpError(401, 'Connexion requise');
  if (!req.user.verified) sendVerification(req.user);
  res.json({ ok: true });
});

// Same answer whether or not the account exists, so the form can't be used to probe addresses.
r.post('/forgot', limiter, (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const u = validEmail(email) && one('SELECT id, email, name FROM users WHERE email = ?', email);
  if (u) {
    const token = createEmailToken(u.id, 'reset', RESET_TTL);
    sendMailLater(u.email, ...mails.reset(u.name, `${config.appUrl}/reinitialiser/${token}`));
  }
  res.json({ ok: true });
});

r.post('/reset', limiter, async (req, res) => {
  const password = String(req.body?.password || '');
  if (password.length < 10) throw new HttpError(400, 'Le mot de passe doit faire au moins 10 caractères');
  const userId = consumeEmailToken(req.body?.token, 'reset');
  // Following the link proves the mailbox, so it also confirms the address. Every session is signed out.
  run('UPDATE users SET password_hash = ?, email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?',
    await hashPassword(password), now(), userId);
  run('DELETE FROM sessions WHERE user_id = ?', userId);
  res.json({ ok: true });
});

r.post('/login', limiter, async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const u = one('SELECT id, email, name, is_admin, password_hash, email_verified_at FROM users WHERE email = ?', email);
  // Always run a hash so response time doesn't reveal whether the account exists.
  const ok = await verifyPassword(password, u?.password_hash || 'scrypt$AAAAAAAAAAAAAAAAAAAAAA==$' + 'A'.repeat(86) + '==');
  if (!u || !ok) throw new HttpError(401, 'E-mail ou mot de passe incorrect');
  const csrf = startSession(res, u.id);
  res.json(mePayload({ id: u.id, email: u.email, name: u.name, isAdmin: u.is_admin, verified: !!u.email_verified_at }, csrf));
});

r.post('/logout', (req, res) => {
  if (req.session) run('DELETE FROM sessions WHERE token_hash = ?', req.session.tokenHash);
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.json({ ok: true });
});

r.patch('/me', requireAuth, async (req, res) => {
  const { name, currentPassword, newPassword } = req.body || {};
  if (name !== undefined) {
    const n = String(name).trim().slice(0, 80);
    if (n.length < 2) throw new HttpError(400, 'Nom trop court');
    run('UPDATE users SET name = ? WHERE id = ?', n, req.user.id);
    req.user.name = n;
  }
  if (newPassword !== undefined) {
    const u = one('SELECT password_hash FROM users WHERE id = ?', req.user.id);
    if (!(await verifyPassword(String(currentPassword || ''), u.password_hash))) {
      throw new HttpError(400, 'Mot de passe actuel incorrect');
    }
    if (String(newPassword).length < 10) throw new HttpError(400, 'Le mot de passe doit faire au moins 10 caractères');
    run('UPDATE users SET password_hash = ? WHERE id = ?', await hashPassword(String(newPassword)), req.user.id);
    // Sign out every other session.
    run('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?', req.user.id, req.session.tokenHash);
  }
  res.json(mePayload(req.user, req.session.csrf));
});

export default r;
