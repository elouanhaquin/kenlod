// Daily database backup: consistent SQLite snapshot, gzipped, kept locally (7 days) and in the bucket (30 days).
// Usage: DATA_DIR=/var/lib/kenlod BACKUP_DIR=/var/backups/kenlod node server/backup.js
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { DatabaseSync, backup } from 'node:sqlite';
import { config } from './config.js';

const dir = process.env.BACKUP_DIR || path.join(config.dataDir, 'backups');
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const stamp = new Date().toISOString().slice(0, 10);
const dbCopy = path.join(dir, `kenlod-${stamp}.db`);
const gz = `${dbCopy}.gz`;

const db = new DatabaseSync(path.join(config.dataDir, 'kenlod.db'), { readOnly: true });
await backup(db, dbCopy);
db.close();
await pipeline(fs.createReadStream(dbCopy), zlib.createGzip(), fs.createWriteStream(gz, { mode: 0o600 }));
fs.rmSync(dbCopy);

for (const f of fs.readdirSync(dir)) {
  const p = path.join(dir, f);
  if (Date.now() - fs.statSync(p).mtimeMs > 7 * 86400e3) fs.rmSync(p);
}

if (config.s3) {
  const { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectCommand } = await import('@aws-sdk/client-s3');
  const { bucket, endpoint, accessKey, secretKey } = config.s3;
  const client = new S3Client({ region: 'us-east-1', endpoint, credentials: { accessKeyId: accessKey, secretAccessKey: secretKey } });
  await client.send(new PutObjectCommand({ Bucket: bucket, Key: `backups/${path.basename(gz)}`, Body: fs.readFileSync(gz), ACL: 'private' }));
  const listed = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: 'backups/' }));
  for (const obj of listed.Contents || []) {
    if (Date.now() - new Date(obj.LastModified).getTime() > 30 * 86400e3) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: obj.Key }));
    }
  }
}
console.log(`backup ok: ${gz}${config.s3 ? ' (+ bucket)' : ''}`);
