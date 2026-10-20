import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const env = process.env;
const MB = 1024 * 1024;

const dataDir = path.resolve(env.DATA_DIR || './data');
fs.mkdirSync(path.join(dataDir, 'files'), { recursive: true });
fs.mkdirSync(path.join(dataDir, 'tmp'), { recursive: true });

// Secret used to sign share-link unlock cookies; generated once and kept with the data.
function loadSecret() {
  if (env.SECRET) return env.SECRET;
  const file = path.join(dataDir, 'secret');
  if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  return fs.readFileSync(file, 'utf8').trim();
}

export const config = {
  port: Number(env.PORT || 3000),
  host: env.HOST || '127.0.0.1',
  prod: env.NODE_ENV === 'production',
  dataDir,
  filesDir: path.join(dataDir, 'files'),
  tmpDir: path.join(dataDir, 'tmp'),
  userQuota: Number(env.USER_QUOTA_MB || 5120) * MB,
  groupQuota: Number(env.GROUP_QUOTA_MB || 20480) * MB,
  maxUpload: Number(env.MAX_UPLOAD_MB || 512) * MB,
  registration: env.REGISTRATION || 'open', // 'open' | 'closed'
  trashDays: Number(env.TRASH_DAYS || 30),
  secret: loadSecret(),
  // Public address of the site, used in the links sent by e-mail.
  appUrl: (env.APP_URL || `http://localhost:${env.PORT || 3000}`).replace(/\/+$/, ''),
  // Outgoing mail: Brevo's HTTP API (BREVO_API_KEY), or authenticated SMTP (SMTP_HOST). Without either,
  // mails are written to DATA_DIR/outbox and the console instead of being sent.
  mail: {
    brevoKey: env.BREVO_API_KEY || null,
    host: env.SMTP_HOST || null,
    port: Number(env.SMTP_PORT || 587),
    user: env.SMTP_USER || '',
    pass: env.SMTP_PASS || '',
    from: env.MAIL_FROM || 'Kenlod <contact@kenlod.fr>',
    outbox: path.join(dataDir, 'outbox'),
  },
  // New accounts must confirm their address before using the app. On by default when mail can really be sent.
  requireVerification: env.EMAIL_VERIFICATION ? env.EMAIL_VERIFICATION === 'required' : !!(env.BREVO_API_KEY || env.SMTP_HOST),
  // Object storage (DigitalOcean Spaces or any S3 API). Without it, files stay on local disk.
  s3: env.S3_BUCKET
    ? {
      bucket: env.S3_BUCKET,
      endpoint: env.S3_ENDPOINT,
      accessKey: env.S3_ACCESS_KEY,
      secretKey: env.S3_SECRET_KEY,
      prefix: env.S3_PREFIX ?? 'files/',
    }
    : null,
};
