// Modal dialog component. Text-only DOM rendering.
// U6: Esc closes drawer/modal.
import { el } from './dom.js';

let activeBackdrop = null;
let currentOnClose = null;

export function openModal({ title, content, actions = [], onClose = null }) {
  closeModal();

  currentOnClose = onClose;

  const header = el('div', { class: 'modal-head' },
    el('h3', null, title),
    el('button', {
      type: 'button',
      class: 'btn-icon',
      title: 'Close (Esc)',
      onclick: () => closeModal(),
    }, '✕')
  );

  const body = el('div', { class: 'modal-body' }, content);

  const footer = actions.length
    ? el('div', { class: 'modal-foot' }, ...actions)
    : null;

  const card = el('div', { class: 'modal-card', role: 'dialog', 'aria-modal': 'true' },
    header,
    body,
    footer
  );

  activeBackdrop = el('div', {
    class: 'modal-backdrop',
    onclick: (e) => {
      if (e.target === activeBackdrop) closeModal();
    },
  }, card);

  document.body.append(activeBackdrop);

  // Focus first input or button
  const focusable = card.querySelector('input, select, textarea, button.primary, button');
  if (focusable) focusable.focus();
}

export function closeModal() {
  if (activeBackdrop) {
    if (activeBackdrop.parentNode) activeBackdrop.remove();
    activeBackdrop = null;
    if (typeof currentOnClose === 'function') {
      const cb = currentOnClose;
      currentOnClose = null;
      cb();
    }
  }
}

export function isModalOpen() {
  return Boolean(activeBackdrop);
}

// Confirmation helper
export function confirmAction({ title, message, confirmText = 'Confirm', confirmClass = 'primary', onConfirm }) {
  const msgEl = el('p', { class: 'modal-message' }, message);
  const cancelBtn = el('button', {
    type: 'button',
    class: 'btn',
    onclick: () => closeModal(),
  }, 'Cancel');

  const okBtn = el('button', {
    type: 'button',
    class: `btn ${confirmClass}`,
    onclick: async () => {
      okBtn.disabled = true;
      try {
        await onConfirm();
        closeModal();
      } catch (err) {
        okBtn.disabled = false;
        if (err.status === 401) {
          closeModal();
        } else {
          msgEl.textContent = `Error: ${err.message}`;
          msgEl.classList.add('text-danger');
        }
      }
    },
  }, confirmText);

  openModal({
    title,
    content: msgEl,
    actions: [cancelBtn, okBtn],
  });
}
