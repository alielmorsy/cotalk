// Toast notification component. Text-only DOM rendering.
import { el } from './dom.js';

let container = null;
let isUnauthorized = false;

export function setUnauthorized(val = true) {
  isUnauthorized = val;
  if (val && container) {
    container.replaceChildren();
  }
}

function ensureContainer() {
  if (!container || !document.body.contains(container)) {
    container = el('div', { class: 'toast-container' });
    document.body.append(container);
  }
  return container;
}

export function showToast(message, type = 'info', durationMs = 4000) {
  if (isUnauthorized) return () => {};
  const c = ensureContainer();
  const item = el('div', { class: `toast toast-${type}` },
    el('span', { class: 'toast-msg' }, message),
    el('button', {
      type: 'button',
      class: 'toast-close',
      onclick: () => dismiss(),
    }, '×')
  );

  let timer = setTimeout(dismiss, durationMs);

  function dismiss() {
    clearTimeout(timer);
    item.classList.add('toast-exit');
    setTimeout(() => {
      if (item.parentNode) item.remove();
    }, 200);
  }

  c.append(item);
  return dismiss;
}

export function clearToasts() {
  if (container) container.replaceChildren();
}
