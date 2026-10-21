// View: Events (Audit Stream of Workspace Activity)
import { el, badge, formatClock, formatDate } from './dom.js';
import { state } from './state.js';

export function renderEvents(wsData) {
  const events = (wsData && wsData.events) || [];
  const container = el('div', { class: 'view-container' });

  const topHeader = el('div', { class: 'view-header' },
    el('div', null,
      el('h2', null, 'Recent Events'),
      el('p', { class: 'view-desc' }, 'Live audit log of workspace activity and handoffs.')
    ),
    el('span', { class: 'badge b-accent' }, `${events.length} events`)
  );

  // Filters with IDs and persistent state (MUST FIX 2)
  const searchInput = el('input', {
    type: 'search',
    id: 'events-search-input',
    class: 'input-text search-bar',
    placeholder: 'Filter events by summary, actor, or ref...',
    value: state.eventsFilters.query,
    oninput: (e) => {
      state.eventsFilters.query = e.target.value;
      renderTable();
    },
  });

  const typeSelect = el('select', {
    id: 'events-type-select',
    class: 'input-select',
    value: state.eventsFilters.type,
    onchange: (e) => {
      state.eventsFilters.type = e.target.value;
      renderTable();
    },
  },
    el('option', { value: 'all' }, 'All Event Types'),
    el('option', { value: 'task.new' }, 'task.new'),
    el('option', { value: 'question.new' }, 'question.new'),
    el('option', { value: 'request.updated' }, 'request.updated'),
    el('option', { value: 'request.claimed' }, 'request.claimed'),
    el('option', { value: 'entry.updated' }, 'entry.updated'),
    el('option', { value: 'agent.joined' }, 'agent.joined')
  );

  const filterBar = el('div', { class: 'filter-bar' },
    searchInput,
    typeSelect
  );

  const tableWrapper = el('div', { class: 'table-container' });

  function renderTable() {
    const q = state.eventsFilters.query.toLowerCase().trim();
    const t = state.eventsFilters.type;

    const filtered = events.filter(ev => {
      if (t !== 'all' && ev.type !== t) return false;
      if (q) {
        const inSumm = (ev.summary || '').toLowerCase().includes(q);
        const inActor = (ev.actor || '').toLowerCase().includes(q);
        const inTarget = (ev.target || '').toLowerCase().includes(q);
        const inRef = String(ev.ref_id || '').toLowerCase().includes(q);
        if (!inSumm && !inActor && !inTarget && !inRef) return false;
      }
      return true;
    });

    if (filtered.length === 0) {
      tableWrapper.replaceChildren(el('div', { class: 'empty-box' },
        el('div', { class: 'empty-title' }, 'No events found'),
        el('div', { class: 'empty-desc' }, 'Events will appear here as agents interact.')
      ));
      return;
    }

    const rows = filtered.map(ev => {
      return el('tr', null,
        el('td', { class: 'muted nowrap text-xs', title: formatDate(ev.created_at) }, formatClock(ev.created_at)),
        el('td', { class: 'mono text-xs' }, badge(ev.type)),
        el('td', { class: 'mono font-bold text-xs' }, ev.actor || '—'),
        el('td', { class: 'mono text-xs' }, ev.target || '—'),
        el('td', { class: 'td-summary' }, ev.summary)
      );
    });

    const tbl = el('table', { class: 'data-table' },
      el('thead', null,
        el('tr', null,
          el('th', null, 'Time'),
          el('th', null, 'Type'),
          el('th', null, 'Actor'),
          el('th', null, 'Target'),
          el('th', null, 'Summary')
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
