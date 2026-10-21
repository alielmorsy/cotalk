// View: Inbox ("Waiting on you")
// High priority requests addressed to the human (`user`). Drafts preserved across live refreshes.
import { el, badge } from './dom.js';
import { state } from './state.js';
import * as api from './api.js';
import { showToast } from './toast.js';

export function renderInbox(wsData, onRefresh) {
  const incoming = (wsData && wsData.user && wsData.user.incoming) || [];
  const activeRequests = incoming.filter(r => r.status === 'open' || r.status === 'claimed');

  const container = el('div', { class: 'view-container' },
    el('div', { class: 'view-header' },
      el('div', null,
        el('h2', null, 'Inbox'),
        el('p', { class: 'view-desc' }, 'Requests waiting for your decision or answer.')
      ),
      el('span', { class: 'badge b-accent' }, `${activeRequests.length} pending`)
    )
  );

  if (activeRequests.length === 0) {
    container.append(el('div', { class: 'empty-box' },
      el('div', { class: 'empty-icon' }, '🎉'),
      el('div', { class: 'empty-title' }, 'Nothing waiting on you'),
      el('div', { class: 'empty-desc' }, 'All tasks and questions addressed to you are answered or resolved.')
    ));
    return container;
  }

  const listEl = el('div', { class: 'inbox-list' });

  for (const r of activeRequests) {
    const isInFlight = state.inFlightRespondIds.has(r.id);

    const box = el('textarea', {
      class: 'input-textarea',
      'data-rid': String(r.id),
      placeholder: r.kind === 'question' ? 'Type your answer here...' : 'Optional result note...',
      disabled: isInFlight,
    });

    box.value = state.drafts.get(r.id) || '';
    box.oninput = () => {
      state.drafts.set(r.id, box.value);
    };

    const statusEl = el('span', { class: 'action-status' }, isInFlight ? 'sending…' : '');
    const buttons = [];

    const makeButton = (label, action, primary = false, isDanger = false) => {
      let cls = 'btn';
      if (primary) cls += ' primary';
      if (isDanger) cls += ' btn-danger';

      const b = el('button', {
        type: 'button',
        class: cls,
        disabled: isInFlight,
      }, label);

      b.onclick = async () => {
        state.inFlightRespondIds.add(r.id);
        for (const btn of buttons) btn.disabled = true;
        box.disabled = true;
        statusEl.textContent = 'sending…';
        try {
          await api.respondRequest({
            workspace: state.currentWorkspace,
            id: r.id,
            action,
            response: box.value,
          });
          state.drafts.delete(r.id);
          showToast(`Request #${r.id} ${action === 'answer' ? 'answered' : action === 'done' ? 'completed' : 'rejected'}.`, 'ok');
          if (onRefresh) onRefresh();
        } catch (err) {
          if (err.status !== 401) {
            statusEl.textContent = `failed: ${err.message}`;
            for (const btn of buttons) btn.disabled = false;
            box.disabled = false;
            showToast(`Failed to ${action} #${r.id}: ${err.message}`, 'bad');
          }
        } finally {
          state.inFlightRespondIds.delete(r.id);
        }
      };
      return b;
    };

    if (r.kind === 'question') {
      buttons.push(makeButton('Answer', 'answer', true));
    } else {
      buttons.push(makeButton('Done', 'done', true));
    }
    buttons.push(makeButton('Reject', 'reject', false, true));

    const card = el('div', { class: 'inbox-card' },
      el('div', { class: 'inbox-head' },
        el('span', { class: 'mono font-bold' }, `#${r.id}`),
        badge(r.kind),
        badge(r.status),
        el('span', { class: 'muted' }, 'from'),
        el('span', { class: 'mono' }, r.from),
        el('strong', { class: 'inbox-title' }, r.title)
      ),
      r.body ? el('div', { class: 'inbox-body' }, r.body) : null,
      r.refs && r.refs.length ? el('div', { class: 'inbox-refs' },
        el('span', { class: 'muted text-xs' }, 'Refs: '),
        ...r.refs.map(ref => el('span', { class: 'badge' }, ref))
      ) : null,
      el('div', { class: 'inbox-reply-box' },
        box,
        el('div', { class: 'inbox-actions' },
          ...buttons,
          statusEl
        )
      )
    );

    listEl.append(card);
  }

  container.append(listEl);
  return container;
}
