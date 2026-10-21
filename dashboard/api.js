// API client for let-them-talk daemon.
// Uses HttpOnly session cookie auth for browser requests.
import { setUnauthorized } from './toast.js';

let unauthorizedHandler = null;

export function onUnauthorized(fn) {
  unauthorizedHandler = fn;
}

async function request(path, options = {}) {
  const headers = {
    ...(options.headers || {}),
  };

  if (options.body && typeof options.body === 'object') {
    headers['content-type'] = 'application/json';
    options.body = JSON.stringify(options.body);
  }

  const res = await fetch(path, {
    ...options,
    headers,
  });

  if (res.status === 401) {
    setUnauthorized(true);
    if (typeof unauthorizedHandler === 'function') {
      unauthorizedHandler();
    }
  } else if (res.ok) {
    setUnauthorized(false);
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = data.error || `HTTP ${res.status}`;
    const err = new Error(message);
    err.status = res.status;
    err.data = data;
    throw err;
  }

  return data;
}

export async function fetchState() {
  return request('/api/state');
}

export async function fetchUsage(fresh = false) {
  return request(fresh ? '/api/usage?fresh=1' : '/api/usage');
}

export async function fetchHistory({ workspace, status, kind, from, to, limit = 50, offset = 0 }) {
  const params = new URLSearchParams({ workspace, limit: String(limit), offset: String(offset) });
  if (status && status !== 'all') params.set('status', status);
  if (kind && kind !== 'all') params.set('kind', kind);
  if (from && from !== 'all') params.set('from', from);
  if (to && to !== 'all') params.set('to', to);
  return request(`/api/requests/history?${params}`);
}

export async function createRequest({ workspace, to, kind, title, body, refs }) {
  return request('/api/request', {
    method: 'POST',
    body: { workspace, to, kind, title, body, refs },
  });
}

export async function respondRequest({ workspace, id, action, response }) {
  return request('/api/respond', {
    method: 'POST',
    body: { workspace, id, action, response },
  });
}

export async function cancelRequest({ workspace, id }) {
  return request('/api/cancel', {
    method: 'POST',
    body: { workspace, id },
  });
}

export async function cancelRequests({ workspace, ids }) {
  return request('/api/requests/cancel', {
    method: 'POST',
    body: { workspace, ids },
  });
}

export async function reassignRequest({ workspace, id, to }) {
  return request('/api/requests/reassign', {
    method: 'POST',
    body: { workspace, id, to },
  });
}

export async function fetchEntry({ workspace, key }) {
  const params = new URLSearchParams({ workspace, key });
  return request(`/api/entry?${params}`);
}

export async function deleteEntry({ workspace, key }) {
  return request('/api/entry/delete', {
    method: 'POST',
    body: { workspace, key },
  });
}

export async function forgetPeer({ workspace, agent, force = false }) {
  return request('/api/peers/forget', {
    method: 'POST',
    body: { workspace, agent, force },
  });
}

export async function clearWorkspace({ workspace }) {
  return request('/api/workspace/clear', {
    method: 'POST',
    body: { workspace },
  });
}

export async function fetchWorkers({ workspace }) {
  const params = new URLSearchParams({ workspace });
  return request(`/api/workers?${params}`);
}

export async function startWorker({ workspace, name, role, owns, cwd, yolo = false }) {
  return request('/api/workers/start', {
    method: 'POST',
    body: { workspace, name, role, owns, cwd, yolo },
  });
}

export async function stopWorker({ workspace, name, force = false }) {
  return request('/api/workers/stop', {
    method: 'POST',
    body: { workspace, name, force },
  });
}

export async function fetchWorkerLog({ workspace, name, lines = 100 }) {
  const params = new URLSearchParams({ workspace, name, lines: String(lines) });
  return request(`/api/workers/log?${params}`);
}

export async function fetchRoster({ workspace, cwd }) {
  const params = new URLSearchParams({ workspace });
  if (cwd) params.set('cwd', cwd);
  return request(`/api/roster?${params}`);
}

export async function saveRoster({ workspace, cwd, agents }) {
  return request('/api/roster', {
    method: 'POST',
    body: { workspace, cwd, agents },
  });
}

export async function fetchSettings() {
  return request('/api/settings');
}

export async function saveSettings({ settings }) {
  return request('/api/settings', {
    method: 'POST',
    body: { settings },
  });
}
