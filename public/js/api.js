let csrf = '';
export const setCsrf = (token) => { csrf = token || ''; };
export const getCsrf = () => csrf;

export class ApiError extends Error {
  constructor(status, message, data) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

export async function api(method, url, body) {
  const headers = { 'X-Kenlod': '1', 'X-CSRF': csrf };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
  } catch {
    throw new ApiError(0, 'Connexion impossible. Vérifiez votre réseau.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error || `Erreur ${res.status}`, data);
  return data;
}

export const get = (url) => api('GET', url);
export const post = (url, body = {}) => api('POST', url, body);
export const put = (url, body) => api('PUT', url, body);
export const patch = (url, body) => api('PATCH', url, body);
export const del = (url, body) => api('DELETE', url, body);

// Uploads one file with progress reporting. Returns { promise, abort }.
export function uploadFile(file, { parentId, space }, onProgress) {
  const xhr = new XMLHttpRequest();
  const params = new URLSearchParams({ name: file.name });
  if (parentId) params.set('parentId', parentId);
  else params.set('space', space || 'me');
  const promise = new Promise((resolve, reject) => {
    xhr.open('POST', `/api/upload?${params}`);
    xhr.setRequestHeader('X-Kenlod', '1');
    xhr.setRequestHeader('X-CSRF', csrf);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch { /* not json */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new ApiError(xhr.status, data.error || `Erreur ${xhr.status}`));
    };
    xhr.onerror = () => reject(new ApiError(0, 'Connexion interrompue'));
    xhr.onabort = () => reject(new ApiError(0, 'Annulé'));
    const fd = new FormData();
    fd.append('file', file);
    xhr.send(fd);
  });
  return { promise, abort: () => xhr.abort() };
}
