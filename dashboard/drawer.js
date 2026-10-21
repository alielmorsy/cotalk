// Detail drawer component. Slide-over panel. Text-only DOM rendering.
// U6: Esc closes drawer/modal.
import { el } from './dom.js';

let activeDrawerEl = null;
let currentOnClose = null;

export function openDrawer({ title, badgeEl, content, actions = [], onClose = null }) {
  closeDrawer();

  currentOnClose = onClose;

  const header = el('div', { class: 'drawer-head' },
    el('div', { class: 'drawer-title-box' },
      el('h3', null, title),
      badgeEl || null
    ),
    el('button', {
      type: 'button',
      class: 'btn-icon',
      title: 'Close (Esc)',
      onclick: () => closeDrawer(),
    }, '✕')
  );

  const body = el('div', { class: 'drawer-body' }, content);

  const footer = actions.length
    ? el('div', { class: 'drawer-foot' }, ...actions)
    : null;

  const panel = el('div', { class: 'drawer-panel' },
    header,
    body,
    footer
  );

  activeDrawerEl = el('div', {
    class: 'drawer-backdrop',
    onclick: (e) => {
      if (e.target === activeDrawerEl) closeDrawer();
    },
  }, panel);

  document.body.append(activeDrawerEl);
}

export function closeDrawer() {
  if (activeDrawerEl) {
    if (activeDrawerEl.parentNode) activeDrawerEl.remove();
    activeDrawerEl = null;
    if (typeof currentOnClose === 'function') {
      const cb = currentOnClose;
      currentOnClose = null;
      cb();
    }
  }
}

export function isDrawerOpen() {
  return Boolean(activeDrawerEl);
}
