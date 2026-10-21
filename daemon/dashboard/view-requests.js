// View: Requests (History, Filtering, Bulk Actions, Reassign, Compose, Drawer)
import { el, badge, formatDate, formatAgo } from './dom.js';
import { state, getAllAgentsInCurrentWorkspace } from './state.js';
import * as api from './api.js';
import { openModal, closeModal, confirmAction } from './modal.js';
import { openDrawer, closeDrawer } from './drawer.js';
import { showToast } from './toast.js';

// Deduplicated request cancel helper (CUT)
export function triggerCancelRequest(r, onRefresh) {
  confirmAction({
    title: `Cancel Request #${r.id}`,
    message: `Are you sure you want to cancel request #${r.id} "${r.title}"?`,
    confirmText: 'Cancel Request',
    confirmClass: 'btn-danger',
    onConfirm: async () => {
      await api.cancelRequest({ workspace: state.currentWorkspace, id: r.id });
      showToast(`Request #${r.id} cancelled.`, 'ok');
      if (onRefresh) onRefresh();
    },
  });
}

function mapStatusForApi(status) {
  if (status === 'resolved') return 'done,answered';
  if (status === 'closed') return 'rejected,cancelled';
  if (status === 'all') return undefined;
  return status;
}

export function renderRequests(wsData, onRefresh) {
  const agents = getAllAgentsInCurrentWorkspace();
  const container = el('div', { class: 'view-container' });

  // Top header with Compose button
  const topHeader = el('div', { class: 'view-header' },
    el('div', null,
      el('h2', null, 'Requests'),
      el('p', { class: 'view-desc' }, 'Complete request history across open, claimed, and resolved tasks and questions.')
    ),
    el('div', { class: 'header-actions' },
      el('button', {
        type: 'button',
        class: 'btn primary',
        onclick: () => openComposeModal(fetchHistoryAndRender),
      }, '+ New Request')
    )
  );

  // Filters Bar with IDs for focus preservation (MUST FIX 2)
  const searchInput = el('input', {
    type: 'search',
    id: 'request-search-input',
    class: 'input-text search-bar',
    placeholder: 'Search requests... (Press / to focus)',
    value: state.filters.query,
    oninput: (e) => {
      state.filters.query = e.target.value;
      renderTableContent();
    },
  });

  const statusSelect = el('select', {
    id: 'request-status-select',
    class: 'input-select',
    value: state.filters.status,
    onchange: (e) => {
      state.filters.status = e.target.value;
      state.requestsHistoryOffset = 0;
      fetchHistoryAndRender();
    },
  },
    el('option', { value: 'all' }, 'Status: All'),
    el('option', { value: 'open' }, 'Status: Open'),
    el('option', { value: 'claimed' }, 'Status: Claimed'),
    el('option', { value: 'resolved' }, 'Status: Resolved (Done/Answered)'),
    el('option', { value: 'closed' }, 'Status: Closed (Rejected/Cancelled)')
  );

  const kindSelect = el('select', {
    id: 'request-kind-select',
    class: 'input-select',
    value: state.filters.kind,
    onchange: (e) => {
      state.filters.kind = e.target.value;
      state.requestsHistoryOffset = 0;
      fetchHistoryAndRender();
    },
  },
    el('option', { value: 'all' }, 'Kind: All'),
    el('option', { value: 'task' }, 'Kind: Task'),
    el('option', { value: 'question' }, 'Kind: Question')
  );

  const fromSelect = el('select', {
    id: 'request-from-select',
    class: 'input-select',
    value: state.filters.from,
    onchange: (e) => {
      state.filters.from = e.target.value;
      state.requestsHistoryOffset = 0;
      fetchHistoryAndRender();
    },
  },
    el('option', { value: 'all' }, 'From: All'),
    ...agents.map(a => el('option', { value: a }, `From: ${a}`))
  );

  const toSelect = el('select', {
    id: 'request-to-select',
    class: 'input-select',
    value: state.filters.to,
    onchange: (e) => {
      state.filters.to = e.target.value;
      state.requestsHistoryOffset = 0;
      fetchHistoryAndRender();
    },
  },
    el('option', { value: 'all' }, 'To: All'),
    ...agents.map(a => el('option', { value: a }, `To: ${a}`))
  );

  const filterBar = el('div', { class: 'filter-bar' },
    searchInput,
    statusSelect,
    kindSelect,
    fromSelect,
    toSelect
  );

  // Bulk actions bar
  const bulkBar = el('div', { class: 'bulk-bar hidden' });

  function updateBulkBar() {
    const count = state.selectedRequestIds.size;
    if (count > 0) {
      bulkBar.classList.remove('hidden');
      bulkBar.replaceChildren(
        el('span', { class: 'bulk-count' }, `${count} request${count > 1 ? 's' : ''} selected`),
        el('button', {
          type: 'button',
          class: 'btn btn-danger btn-sm',
          onclick: () => {
            const ids = [...state.selectedRequestIds];
            confirmAction({
              title: 'Bulk Cancel Requests',
              message: `Are you sure you want to cancel ${ids.length} request(s): #${ids.join(', #')}?`,
              confirmText: 'Cancel Requests',
              confirmClass: 'btn-danger',
              onConfirm: async () => {
                const res = await api.cancelRequests({
                  workspace: state.currentWorkspace,
                  ids,
                });
                state.selectedRequestIds.clear();
                let msg = `Cancelled ${res.cancelled ? res.cancelled.length : ids.length} request(s).`;
                // ALSO FIX: show skipped ids + reasons in toast
                if (res.skipped && res.skipped.length > 0) {
                  const skippedStr = res.skipped.map(s => `#${s.id} (${s.reason})`).join(', ');
                  msg += ` Skipped: ${skippedStr}`;
                  showToast(msg, 'info');
                } else {
                  showToast(msg, 'ok');
                }
                fetchHistoryAndRender();
              },
            });
          },
        }, 'Cancel Selected'),
        el('button', {
          type: 'button',
          class: 'btn btn-sm',
          onclick: () => {
            state.selectedRequestIds.clear();
            renderTableContent();
          },
        }, 'Clear Selection')
      );
    } else {
      bulkBar.classList.add('hidden');
      bulkBar.replaceChildren();
    }
  }

  const tableWrapper = el('div', { class: 'table-container' });

  // MUST FIX 5: Wire fetchHistory for full history & pagination
  async function fetchHistoryAndRender(append = false) {
    if (state.requestsHistoryLoading) return;
    state.requestsHistoryLoading = true;

    try {
      const data = await api.fetchHistory({
        workspace: state.currentWorkspace,
        status: mapStatusForApi(state.filters.status),
        kind: state.filters.kind !== 'all' ? state.filters.kind : undefined,
        from: state.filters.from !== 'all' ? state.filters.from : undefined,
        to: state.filters.to !== 'all' ? state.filters.to : undefined,
        limit: 50,
        offset: state.requestsHistoryOffset,
      });

      const list = data.requests || [];
      state.requestsHistoryTotal = data.total || list.length;
      if (append) {
        state.requestsHistory = [...state.requestsHistory, ...list];
      } else {
        state.requestsHistory = list;
      }
    } catch {
      // Fallback to open requests from wsData if history route fails
      if (!append) {
        state.requestsHistory = (wsData && wsData.requests) || [];
        state.requestsHistoryTotal = state.requestsHistory.length;
      }
    } finally {
      state.requestsHistoryLoading = false;
      renderTableContent();
    }
  }

  function renderTableContent() {
    updateBulkBar();
    const q = state.filters.query.trim().toLowerCase();
    const currentList = state.requestsHistory.filter(r => {
      if (!q) return true;
      const inTitle = (r.title || '').toLowerCase().includes(q);
      const inBody = (r.body || '').toLowerCase().includes(q);
      const inId = String(r.id).includes(q) || ('#' + r.id).includes(q);
      const inAgent = (r.from || '').toLowerCase().includes(q) || (r.to || '').toLowerCase().includes(q);
      return inTitle || inBody || inId || inAgent;
    });

    if (currentList.length === 0) {
      tableWrapper.replaceChildren(el('div', { class: 'empty-box' },
        el('div', { class: 'empty-title' }, 'No matching requests'),
        el('div', { class: 'empty-desc' }, 'Try clearing filters or search keywords.')
      ));
      return;
    }

    const selectAllCheckbox = el('input', {
      type: 'checkbox',
      checked: currentList.length > 0 && currentList.every(r => state.selectedRequestIds.has(r.id)),
      onchange: (e) => {
        if (e.target.checked) {
          for (const r of currentList) state.selectedRequestIds.add(r.id);
        } else {
          for (const r of currentList) state.selectedRequestIds.delete(r.id);
        }
        renderTableContent();
      },
    });

    const rows = currentList.map(r => {
      const isSelected = state.selectedRequestIds.has(r.id);
      const isTerminal = r.status === 'done' || r.status === 'answered' || r.status === 'rejected' || r.status === 'cancelled';

      let tr;
      const rowCheckbox = el('input', {
        type: 'checkbox',
        checked: isSelected,
        disabled: isTerminal,
        onclick: (e) => e.stopPropagation(),
        onchange: (e) => {
          // ALSO FIX: update row highlight + select-all state
          if (e.target.checked) {
            state.selectedRequestIds.add(r.id);
            if (tr) tr.classList.add('row-selected');
          } else {
            state.selectedRequestIds.delete(r.id);
            if (tr) tr.classList.remove('row-selected');
          }
          selectAllCheckbox.checked = currentList.length > 0 && currentList.every(req => state.selectedRequestIds.has(req.id));
          updateBulkBar();
        },
      });

      const reassignBtn = el('button', {
        type: 'button',
        class: 'btn-sm',
        title: 'Reassign to another agent',
        disabled: isTerminal,
        onclick: (e) => {
          e.stopPropagation();
          openReassignModal(r, fetchHistoryAndRender);
        },
      }, 'Reassign');

      const cancelBtn = el('button', {
        type: 'button',
        class: 'btn-sm btn-danger',
        title: 'Cancel request',
        disabled: isTerminal,
        onclick: (e) => {
          e.stopPropagation();
          triggerCancelRequest(r, fetchHistoryAndRender);
        },
      }, 'Cancel');

      tr = el('tr', {
        class: 'clickable-row' + (isSelected ? ' row-selected' : ''),
        onclick: () => openRequestDrawer(r, fetchHistoryAndRender),
      },
        el('td', { class: 'td-cb', onclick: (e) => e.stopPropagation() }, rowCheckbox),
        el('td', { class: 'mono font-bold' }, `#${r.id}`),
        el('td', null, badge(r.kind)),
        el('td', { class: 'mono nowrap' }, `${r.from} → ${r.to}${r.claimed_by ? ` (${r.claimed_by})` : ''}`),
        el('td', { class: 'td-title', title: r.title }, r.title),
        el('td', null, badge(r.status)),
        el('td', { class: 'muted nowrap text-xs', title: formatDate(r.updated_at || r.created_at) }, formatAgo(r.updated_at || r.created_at)),
        el('td', { class: 'td-actions', onclick: (e) => e.stopPropagation() }, reassignBtn, cancelBtn)
      );

      return tr;
    });

    const tbl = el('table', { class: 'data-table' },
      el('thead', null,
        el('tr', null,
          el('th', { class: 'th-cb' }, selectAllCheckbox),
          el('th', null, 'ID'),
          el('th', null, 'Kind'),
          el('th', null, 'Route'),
          el('th', null, 'Title'),
          el('th', null, 'Status'),
          el('th', null, 'Updated'),
          el('th', null, 'Actions')
        )
      ),
      el('tbody', null, ...rows)
    );

    const elements = [tbl];

    // Pagination: "Load More" button if more records exist
    if (state.requestsHistory.length < state.requestsHistoryTotal) {
      const loadMoreBtn = el('button', {
        type: 'button',
        class: 'btn w-full mt-2',
        onclick: () => {
          state.requestsHistoryOffset += 50;
          fetchHistoryAndRender(true);
        },
      }, `Load More (${state.requestsHistory.length} of ${state.requestsHistoryTotal})`);
      elements.push(el('div', { class: 'p-3' }, loadMoreBtn));
    }

    tableWrapper.replaceChildren(...elements);
  }

  // Initial load
  if (state.requestsHistory.length === 0) {
    fetchHistoryAndRender();
  } else {
    renderTableContent();
  }

  container.append(topHeader, filterBar, bulkBar, tableWrapper);
  return container;
}

function openRequestDrawer(r, onRefresh) {
  const isTerminal = r.status === 'done' || r.status === 'answered' || r.status === 'rejected' || r.status === 'cancelled';

  const content = el('div', { class: 'drawer-content' },
    el('div', { class: 'drawer-grid' },
      el('div', { class: 'prop-item' }, el('span', { class: 'prop-label' }, 'Request ID'), el('span', { class: 'mono font-bold' }, `#${r.id}`)),
      el('div', { class: 'prop-item' }, el('span', { class: 'prop-label' }, 'Kind'), badge(r.kind)),
      el('div', { class: 'prop-item' }, el('span', { class: 'prop-label' }, 'Status'), badge(r.status)),
      el('div', { class: 'prop-item' }, el('span', { class: 'prop-label' }, 'From Agent'), el('span', { class: 'mono' }, r.from)),
      el('div', { class: 'prop-item' }, el('span', { class: 'prop-label' }, 'To Agent'), el('span', { class: 'mono' }, r.to)),
      el('div', { class: 'prop-item' }, el('span', { class: 'prop-label' }, 'Claimed By'), el('span', { class: 'mono' }, r.claimed_by || '—')),
      el('div', { class: 'prop-item' }, el('span', { class: 'prop-label' }, 'Created'), el('span', { class: 'muted text-xs' }, formatDate(r.created_at))),
      el('div', { class: 'prop-item' }, el('span', { class: 'prop-label' }, 'Updated'), el('span', { class: 'muted text-xs' }, formatDate(r.updated_at || r.created_at)))
    ),
    el('div', { class: 'drawer-section' },
      el('h4', null, 'Title'),
      el('div', { class: 'drawer-text font-bold' }, r.title)
    ),
    r.body ? el('div', { class: 'drawer-section' },
      el('h4', null, 'Body'),
      el('div', { class: 'drawer-pre' }, r.body)
    ) : null,
    r.refs && r.refs.length ? el('div', { class: 'drawer-section' },
      el('h4', null, 'References'),
      el('div', { class: 'refs-tags' }, ...r.refs.map(ref => el('span', { class: 'badge' }, ref)))
    ) : null,
    r.response ? el('div', { class: 'drawer-section' },
      el('h4', null, 'Response'),
      el('div', { class: 'drawer-pre drawer-response' }, r.response)
    ) : null
  );

  const actions = [];
  if (!isTerminal) {
    actions.push(
      el('button', {
        type: 'button',
        class: 'btn',
        onclick: () => {
          closeDrawer();
          openReassignModal(r, onRefresh);
        },
      }, 'Reassign'),
      el('button', {
        type: 'button',
        class: 'btn btn-danger',
        onclick: () => {
          closeDrawer();
          triggerCancelRequest(r, onRefresh);
        },
      }, 'Cancel Request')
    );
  }

  openDrawer({
    title: `Request #${r.id}`,
    badgeEl: badge(r.status),
    content,
    actions,
  });
}

function openReassignModal(r, onRefresh) {
  const agents = getAllAgentsInCurrentWorkspace().filter(a => a !== r.to && a !== 'user');
  if (agents.length === 0) {
    showToast('No other available agents to reassign to.', 'bad');
    return;
  }

  const toSelect = el('select', { class: 'input-select w-full' },
    ...agents.map(a => el('option', { value: a }, a))
  );

  const form = el('form', { class: 'form-box' },
    el('label', { class: 'form-label' }, 'Current Target:'),
    el('div', { class: 'mono mb-2' }, `${r.to} ${r.claimed_by ? `(claimed by ${r.claimed_by})` : ''}`),
    el('label', { class: 'form-label' }, 'Reassign To:'),
    toSelect
  );

  const cancelBtn = el('button', {
    type: 'button',
    class: 'btn',
    onclick: () => closeModal(),
  }, 'Cancel');

  const submitBtn = el('button', {
    type: 'button',
    class: 'btn primary',
    onclick: async () => {
      const newTo = toSelect.value;
      if (!newTo) return;
      submitBtn.disabled = true;
      try {
        await api.reassignRequest({
          workspace: state.currentWorkspace,
          id: r.id,
          to: newTo,
        });
        closeModal();
        showToast(`Request #${r.id} reassigned to ${newTo}.`, 'ok');
        if (onRefresh) onRefresh();
      } catch (err) {
        submitBtn.disabled = false;
        showToast(`Reassign failed: ${err.message}`, 'bad');
      }
    },
  }, 'Reassign');

  openModal({
    title: `Reassign Request #${r.id}`,
    content: form,
    actions: [cancelBtn, submitBtn],
  });
}

function openComposeModal(onRefresh) {
  const agents = getAllAgentsInCurrentWorkspace().filter(a => a !== 'user');
  if (!agents.includes('*')) agents.push('*');

  const toSelect = el('select', { class: 'input-select w-full' },
    ...agents.map(a => el('option', { value: a }, a === '*' ? '* (Broadcast to all)' : a))
  );

  const kindSelect = el('select', { class: 'input-select w-full' },
    el('option', { value: 'task' }, 'Task'),
    el('option', { value: 'question' }, 'Question')
  );

  const titleInput = el('input', {
    type: 'text',
    class: 'input-text w-full',
    placeholder: 'Brief summary of the request',
    required: true,
  });

  const bodyTextarea = el('textarea', {
    class: 'input-textarea w-full',
    rows: 4,
    placeholder: 'Detailed instructions or question context...',
  });

  const refsInput = el('input', {
    type: 'text',
    class: 'input-text w-full',
    placeholder: 'Comma-separated references (e.g. lead.dashboard.overview, #24)',
  });

  const form = el('form', { class: 'form-box' },
    el('div', { class: 'form-row' },
      el('div', { class: 'form-col' }, el('label', { class: 'form-label' }, 'Target Agent (To)'), toSelect),
      el('div', { class: 'form-col' }, el('label', { class: 'form-label' }, 'Kind'), kindSelect)
    ),
    el('div', { class: 'form-group' },
      el('label', { class: 'form-label' }, 'Title *'),
      titleInput
    ),
    el('div', { class: 'form-group' },
      el('label', { class: 'form-label' }, 'Details / Body'),
      bodyTextarea
    ),
    el('div', { class: 'form-group' },
      el('label', { class: 'form-label' }, 'Refs (optional)'),
      refsInput
    )
  );

  const cancelBtn = el('button', {
    type: 'button',
    class: 'btn',
    onclick: () => closeModal(),
  }, 'Cancel');

  const submitBtn = el('button', {
    type: 'button',
    class: 'btn primary',
    onclick: async () => {
      const title = titleInput.value.trim();
      if (!title) {
        titleInput.focus();
        showToast('Please enter a request title.', 'bad');
        return;
      }
      submitBtn.disabled = true;
      try {
        const refs = refsInput.value.split(',').map(s => s.trim()).filter(Boolean);
        await api.createRequest({
          workspace: state.currentWorkspace,
          to: toSelect.value,
          kind: kindSelect.value,
          title,
          body: bodyTextarea.value.trim(),
          refs,
        });
        closeModal();
        showToast('Request created successfully.', 'ok');
        if (onRefresh) onRefresh();
      } catch (err) {
        submitBtn.disabled = false;
        showToast(`Failed to create request: ${err.message}`, 'bad');
      }
    },
  }, 'Send Request');

  openModal({
    title: 'Compose Request',
    content: form,
    actions: [cancelBtn, submitBtn],
  });
}
