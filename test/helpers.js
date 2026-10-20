import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Starts a throwaway server on a random port with its own data directory.
export async function startServer(env = {}) {
  const port = 3900 + Math.floor(Math.random() * 900);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kenlod-test-'));
  const proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], {
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, NODE_ENV: 'test', ...env },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve) => proc.stdout.on('data', (d) => String(d).includes('écoute') && resolve()));
  return {
    base: `http://127.0.0.1:${port}`,
    host: `127.0.0.1:${port}`,
    dataDir,
    async stop() {
      const exited = new Promise((resolve) => proc.once('exit', resolve));
      proc.kill();
      await exited;
      fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    },
  };
}

export class Client {
  cookies = {};
  csrf = '';
  constructor(server) { this.server = server; }
  get cookieHeader() { return Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; '); }
  async req(method, url, body, { raw = false, headers = {} } = {}) {
    const h = { 'X-Kenlod': '1', 'X-CSRF': this.csrf, Cookie: this.cookieHeader, ...headers };
    let payload = body;
    if (body && !(body instanceof FormData)) {
      h['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(this.server.base + url, { method, headers: h, body: payload });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      this.cookies[pair.slice(0, i)] = pair.slice(i + 1);
    }
    const data = raw ? await res.text() : await res.json().catch(() => null);
    return { status: res.status, data, headers: res.headers };
  }
  async register(email, name) {
    const r = await this.req('POST', '/api/auth/register', { email, name, password: 'correct-horse-battery' });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    this.csrf = r.data.csrf;
    this.user = r.data.user;
    return this;
  }
  async upload(name, content, query = '') {
    const fd = new FormData();
    fd.append('file', new Blob([content]), 'x');
    return this.req('POST', `/api/upload?name=${encodeURIComponent(name)}${query}`, fd);
  }
}

export const until = async (fn, timeout = 4000) => {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 50));
  }
};
