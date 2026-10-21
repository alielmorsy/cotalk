// View: Board (Contracts, Decisions, Notes, Full Body Viewer, Deletion)
import { el, badge, formatDate, formatAgo } from './dom.js';
import { state } from './state.js';
import * as api from './api.js';
import { openDrawer, closeDrawer } from './drawer.js';
import { confirmAction } from './modal.js';
import { showToast } from './toast.js';

// Deduplicated board entry delete helper (CUT)
export function triggerDeleteEntry(item, onRefresh) {
  confirmAction({
    title: `Delete Board Entry "${item.key}"`,
    message: `Are you sure you want to permanently delete board entry "${item.key}"?`,
    confirmText: 'Delete Entry',
    confirmClass: 'btn-danger',
    onConfirm: async () => {
      await api.deleteEntry({ workspace: state.currentWorkspace, key: item.key });
      showToast(`Deleted board entry "${item.key}".`, 'ok');
      if (onRefresh) onRefresh();
    },
  });
}

export function renderBoard(wsData, onRefresh) {
  const board = (wsData && wsData.board) || [];
  const container = el('div', { class: 'view-container' });

  const topHeader = el('div', { class: 'view-header' },
    el('div', null,
      el('h2', null, 'Board'),
      el('p', { class: 'view-desc' }, 'Shared contracts, architectural decisions, and notes across agents.')
    ),
    el('span', { class: 'badge b-info' }, `${board.length} entries`)
  );

  // Filters with IDs and persistent state (MUST FIX 2)
  const searchInput = el('input', {
    type: 'search',
    id: 'board-search-input',
    class: 'input-text search-bar',
    placeholder: 'Filter by key, title, or author...',
    value: state.boardFilters.query,
    oninput: (e) => {
      state.boardFilters.query = e.target.value;
      renderTable();
    },
  });

  const kindSelect = el('select', {
    id: 'board-kind-select',
    class: 'input-select',
    value: state.boardFilters.kind,
    onchange: (e) => {
      state.boardFilters.kind = e.target.value;
      renderTable();
    },
  },
    el('option', { value: 'all' }, 'Kind: All'),
    el('option', { value: 'contract' }, 'Kind: Contract'),
    el('option', { value: 'decision' }, 'Kind: Decision'),
    el('option', { value: 'note' }, 'Kind: Note')
  );

  const filterBar = el('div', { class: 'filter-bar' },
    searchInput,
    kindSelect
  );

  const tableWrapper = el('div', { class: 'table-container' });

  function renderTable() {
    const q = state.boardFilters.query.toLowerCase().trim();
    const k = state.boardFilters.kind;

    const filtered = board.filter(e => {
      if (k !== 'all' && e.kind !== k) return false;
      if (q) {
        const inKey = (e.key || '').toLowerCase().includes(q);
        const inTitle = (e.title || '').toLowerCase().includes(q);
        const inAuthor = (e.author || '').toLowerCase().includes(q);
        if (!inKey && !inTitle && !inAuthor) return false;
      }
      return true;
    });

    if (filtered.length === 0) {
      tableWrapper.replaceChildren(el('div', { class: 'empty-box' },
        el('div', { class: 'empty-title' }, 'No board entries found'),
        el('div', { class: 'empty-desc' }, 'The board is empty or no entries match your search.')
      ));
      return;
    }

    const rows = filtered.map(item => {
      const deleteBtn = el('button', {
        type: 'button',
        class: 'btn-sm btn-danger',
        title: 'Delete board entry',
        onclick: (ev) => {
          ev.stopPropagation();
          triggerDeleteEntry(item, onRefresh);
        },
      }, 'Delete');

      return el('tr', {
        class: 'clickable-row',
        onclick: () => openEntryDrawer(item, onRefresh),
      },
        el('td', { class: 'mono font-bold' }, item.key),
        el('td', null, badge(item.kind)),
        el('td', { class: 'td-title' }, item.title),
        el('td', { class: 'mono text-xs' }, item.author),
        el('td', { class: 'muted text-xs' }, `v${item.version}`),
        el('td', { class: 'muted nowrap text-xs', title: formatDate(item.updated_at) }, formatAgo(item.updated_at)),
        el('td', { class: 'td-actions', onclick: (ev) => ev.stopPropagation() }, deleteBtn)
      );
    });

    const tbl = el('table', { class: 'data-table' },
      el('thead', null,
        el('tr', null,
          el('th', null, 'Key'),
          el('th', null, 'Kind'),
          el('th', null, 'Title'),
          el('th', null, 'Author'),
          el('th', null, 'Ver'),
          el('th', null, 'Updated'),
          el('th', null, 'Actions')
        )
      ),
      el('tbody', null, ...rows)
    );

    tableWrapper.replaceChildren(tbl);
  }

  renderTable();

  container.append(topHeader, filterBar, tableWrapper);
  return container;
}

async function openEntryDrawer(entryItem, onRefresh) {
  const bodyContainer = el('div', { class: 'drawer-pre' }, 'Loading full content...');

  const content = el('div', { class: 'drawer-content' },
    el('div', { class: 'drawer-grid' },
      el('div', { class: 'prop-item' }, el('span', { class: 'prop-label' }, 'Key'), el('span', { class: 'mono font-bold' }, entryItem.key)),
      el('div', { class: 'prop-item' }, el('span', { class: 'prop-label' }, 'Kind'), badge(entryItem.kind)),
      el('div', { class: 'prop-item' }, el('span', { class: 'prop-label' }, 'Author'), el('span', { class: 'mono' }, entryItem.author)),
      el('div', { class: 'prop-item' }, el('span', { class: 'prop-label' }, 'Version'), el('span', { class: 'muted' }, `v${entryItem.version}`)),
      el('div', { class: 'prop-item' }, el('span', { class: 'prop-label' }, 'Updated'), el('span', { class: 'muted text-xs' }, formatDate(entryItem.updated_at)))
    ),
    el('div', { class: 'drawer-section' },
      el('h4', null, 'Title'),
      el('div', { class: 'drawer-text font-bold' }, entryItem.title)
    ),
    el('div', { class: 'drawer-section' },
      el('h4', null, 'Content Body'),
      bodyContainer
    )
  );

  const actions = [
    el('button', {
      type: 'button',
      class: 'btn btn-danger',
      onclick: () => {
        closeDrawer();
        triggerDeleteEntry(entryItem, onRefresh);
      },
    }, 'Delete Entry')
  ];

  openDrawer({
    title: entryItem.key,
    badgeEl: badge(entryItem.kind),
    content,
    actions,
  });

  // Fetch full body via GET /api/entry
  try {
    const data = await api.fetchEntry({
      workspace: state.currentWorkspace,
      key: entryItem.key,
    });
    if (data && data.entry && data.entry.body) {
      bodyContainer.textContent = data.entry.body;
    } else if (entryItem.body) {
      bodyContainer.textContent = entryItem.body;
    } else {
      bodyContainer.textContent = '(Empty body)';
    }
  } catch (err) {
    if (entryItem.body) {
      bodyContainer.textContent = entryItem.body;
    } else {
      bodyContainer.textContent = `Failed to load body: ${err.message}`;
    }
  }
}
