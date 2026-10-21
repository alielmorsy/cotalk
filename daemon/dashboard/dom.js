// Text-only DOM rendering and formatting utilities.

export function el(tag, props, ...children) {
  const node = document.createElement(tag);
  if (props) {
    for (const [key, val] of Object.entries(props)) {
      if (val === null || val === undefined) continue;
      if (key === 'value') {
        // Handled after child appending so <select> options exist first
        continue;
      } else if (key === 'style') {
        // Strict CSP: inline styles are blocked; use CSS classes instead
        continue;
      } else if (key === 'class') {
        node.className = val;
      } else if (key.startsWith('on') && typeof val === 'function') {
        const eventName = key.slice(2).toLowerCase();
        node.addEventListener(eventName, val);
      } else if (key === 'checked' || key === 'disabled' || key === 'selected') {
        node[key] = Boolean(val);
      } else {
        node.setAttribute(key, String(val));
      }
    }
  }

  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    if (child instanceof Node) {
      node.append(child);
    } else {
      node.append(document.createTextNode(String(child)));
    }
  }

  // Set value after children are appended so <select> and <option> matching works
  if (props && 'value' in props && props.value !== null && props.value !== undefined) {
    node.value = props.value;
  }

  return node;
}

export function badge(text, customVariant) {
  const variant = customVariant || String(text || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
  return el('span', { class: 'badge b-' + variant }, text || '-');
}

export function formatAgo(ms, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  const days = Math.round(s / 86400);
  if (days < 30) return `${days}d ago`;
  return new Date(ms).toLocaleDateString();
}

export function formatClock(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function formatDate(ms) {
  return new Date(ms).toLocaleString();
}

export function parseErrorCode(errorStr) {
  if (!errorStr) return { code: 'unknown', message: '' };
  const match = String(errorStr).match(/^([a-z0-9_]+):\s*(.*)$/i);
  if (match) {
    return { code: match[1], message: match[2] };
  }
  return { code: 'unknown', message: errorStr };
}

export function filterRequests(requests, { status = 'all', kind = 'all', from = 'all', to = 'all', query = '' } = {}) {
  const q = query.trim().toLowerCase();
  return requests.filter(r => {
    if (status !== 'all') {
      if (status === 'resolved') {
        if (r.status !== 'done' && r.status !== 'answered') return false;
      } else if (status === 'closed') {
        if (r.status !== 'rejected' && r.status !== 'cancelled') return false;
      } else if (r.status !== status) {
        return false;
      }
    }
    if (kind !== 'all' && r.kind !== kind) return false;
    if (from !== 'all' && r.from !== from) return false;
    if (to !== 'all' && r.to !== to) return false;
    if (q) {
      const inTitle = (r.title || '').toLowerCase().includes(q);
      const inBody = (r.body || '').toLowerCase().includes(q);
      const inId = String(r.id).includes(q) || ('#' + r.id).includes(q);
      const inAgent = (r.from || '').toLowerCase().includes(q) || (r.to || '').toLowerCase().includes(q);
      if (!inTitle && !inBody && !inId && !inAgent) return false;
    }
    return true;
  });
}
