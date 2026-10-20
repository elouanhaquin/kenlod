import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { config } from './config.js';

// Stored file bodies live either on local disk (dev, tests) or in an S3-compatible bucket
// (DigitalOcean Spaces in production). The bucket stays private: every download goes through
// the app, which checks permissions and sets safe headers.

const localPath = (key) => path.join(config.filesDir, key.slice(0, 2), key);

const local = {
  async put(key, srcPath) {
    const dest = localPath(key);
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    await fs.promises.rename(srcPath, dest);
  },
  async copy(srcKey, destKey) {
    const dest = localPath(destKey);
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    await fs.promises.copyFile(localPath(srcKey), dest);
  },
  async remove(key) {
    await fs.promises.rm(localPath(key), { force: true });
  },
  send(req, res, key) {
    res.sendFile(localPath(key), { dotfiles: 'allow' }, (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: 'Fichier introuvable' });
    });
  },
};

async function s3Backend() {
  const { S3Client, GetObjectCommand, DeleteObjectCommand, CopyObjectCommand } = await import('@aws-sdk/client-s3');
  const { Upload } = await import('@aws-sdk/lib-storage');
  const { bucket, endpoint, accessKey, secretKey, prefix } = config.s3;
  const client = new S3Client({
    region: 'us-east-1', endpoint, credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
  });
  const k = (key) => `${prefix}${key}`;
  return {
    async put(key, srcPath, mime) {
      const upload = new Upload({
        client,
        params: { Bucket: bucket, Key: k(key), Body: fs.createReadStream(srcPath), ContentType: mime, ACL: 'private' },
        queueSize: 2,
        partSize: 8 * 1024 * 1024,
      });
      await upload.done();
      await fs.promises.rm(srcPath, { force: true });
    },
    async copy(srcKey, destKey) {
      await client.send(new CopyObjectCommand({ Bucket: bucket, CopySource: `${bucket}/${k(srcKey)}`, Key: k(destKey), ACL: 'private' }));
    },
    async remove(key) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: k(key) }));
    },
    async send(req, res, key) {
      try {
        const range = /^bytes=\d*-\d*$/.test(req.headers.range || '') ? req.headers.range : undefined;
        const obj = await client.send(new GetObjectCommand({ Bucket: bucket, Key: k(key), Range: range }));
        res.status(obj.ContentRange ? 206 : 200);
        res.setHeader('Accept-Ranges', 'bytes');
        if (obj.ContentLength !== undefined) res.setHeader('Content-Length', obj.ContentLength);
        if (obj.ContentRange) res.setHeader('Content-Range', obj.ContentRange);
        if (req.method === 'HEAD') return res.end();
        await pipeline(obj.Body, res);
      } catch (err) {
        if (res.headersSent) return res.destroy();
        if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) return res.status(404).json({ error: 'Fichier introuvable' });
        if (err.$metadata?.httpStatusCode === 416) return res.status(416).end();
        if (err.code === 'ERR_STREAM_PREMATURE_CLOSE') return;
        console.error('storage read failed', key, err);
        res.status(502).json({ error: 'Stockage momentanément indisponible' });
      }
    },
    client,
  };
}

export const storage = config.s3 ? await s3Backend() : local;
export const storageKind = config.s3 ? 's3' : 'local';
