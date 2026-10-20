import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import { config } from './config.js';
import { run } from './db.js';
import { HttpError, now } from './util.js';
import authRoutes, { loadSession, csrfGuard, sessionFromCookie } from './routes/auth.js';
import itemRoutes, { purgeOldTrash } from './routes/items.js';
import shareRoutes from './routes/shares.js';
import groupRoutes from './routes/groups.js';
import publicRoutes from './routes/public.js';
import { formRoutes, publicFormRoutes } from './routes/forms.js';
import { attachCollab, flushAll } from './collab.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback');

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'blob:'],
      mediaSrc: ["'self'", 'blob:'],
      fontSrc: ["'self'"],
      // 'self' does not cover ws(s):// in every browser.
      connectSrc: ["'self'", (req) => `${config.prod ? 'wss' : 'ws'}://${String(req.headers.host || '').replace(/[^\w.:[\]-]/g, '')}`],
      frameSrc: ["'self'"],
      objectSrc: ["'self'"],
      frameAncestors: ["'self'"],
      formAction: ["'self'"],
      baseUri: ["'self'"],
      ...(config.prod ? { upgradeInsecureRequests: [] } : {}),
    },
  },
  crossOriginEmbedderPolicy: false,
  referrerPolicy: { policy: 'same-origin' },
  strictTransportSecurity: config.prod ? { maxAge: 31536000 } : false,
}));

app.use('/api', express.json({ limit: '6mb' }), loadSession, csrfGuard, (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use('/api/auth', authRoutes);
app.use('/api/public', publicRoutes);
app.use('/api/f', publicFormRoutes);
app.use('/api', groupRoutes);
app.use('/api', shareRoutes);
app.use('/api', itemRoutes);
app.use('/api', formRoutes);
app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Route inconnue')));

// Public site: the landing page for visitors (signed-in users get the app), and the legal pages.
const sendPage = (res, file) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(publicDir, file));
};
app.get('/', (req, res) => {
  res.setHeader('Vary', 'Cookie');
  sendPage(res, sessionFromCookie(req.headers.cookie) ? 'index.html' : 'site/accueil.html');
});
for (const page of ['mentions-legales', 'cgu', 'confidentialite']) {
  app.get(`/${page}`, (_req, res) => sendPage(res, `site/${page}.html`));
}

app.use(express.static(publicDir, { index: false, maxAge: config.prod ? '1h' : 0 }));
// Single-page app: every other GET serves the shell.
app.get(/^(?!\/api\/).*/, (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(publicDir, 'index.html'));
});

app.use((err, req, res, _next) => {
  let status = err.status || err.statusCode || 500;
  let message = err.message;
  if (err.code === 'LIMIT_FILE_SIZE') {
    status = 413;
    message = `Fichier trop volumineux (maximum ${Math.round(config.maxUpload / 1048576)} Mo)`;
  } else if (err.type === 'entity.too.large') {
    message = 'Contenu trop volumineux';
  } else if (status >= 500) {
    console.error(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`, err);
    message = 'Erreur interne, réessayez';
  }
  if (res.headersSent) return;
  res.status(status).json({ error: message, ...(err.reason ? { reason: err.reason } : {}) });
});

function housekeeping() {
  try {
    run('DELETE FROM sessions WHERE expires_at < ?', now());
    run('DELETE FROM group_invites WHERE expires_at < ?', now());
    purgeOldTrash();
  } catch (err) {
    console.error('housekeeping failed', err);
  }
}
housekeeping();
setInterval(housekeeping, 6 * 3600e3).unref();

const server = app.listen(config.port, config.host, () => {
  console.log(`Kenlod écoute sur http://${config.host}:${config.port} (${config.prod ? 'production' : 'dev'})`);
});
attachCollab(server);

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    flushAll();
    process.exit(0);
  });
}
