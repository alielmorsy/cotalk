// Main entry point for cotalk dashboard.
// Uses HttpOnly session cookie auth for all daemon requests.
// U6: Esc closes drawer/modal, / focuses search, 1-6 switch views when not typing.

import { el, badge, formatClock } from './dom.js';
import * as api from './api.js';
import {
  state,
  applyTheme,
  loadLastWorkspace,
  saveLastWorkspace,
  getCurrentWorkspaceData
} from './state.js';
import { renderInbox } from './view-inbox.js';
import { renderRequests } from './view-requests.js';
import { renderBoard } from './view-board.js';
import { renderPeers, startWorkersPolling, stopWorkersPolling } from './view-peers.js';
import { renderEvents } from './view-events.js';
import { renderSettings } from './view-settings.js';
import { usageChips } from './usage.js';
import { closeModal, isModalOpen } from './modal.js';
import { closeDrawer, isDrawerOpen } from './drawer.js';
import { playChime, showDesktopNotification } from './notify.js';
import { clearToasts } from './toast.js';

// 1. Register 401 unauthorized handler
api.onUnauthorized(renderUnauthorized);

// 2. Initialize color theme from preferences
applyTheme(state.theme);

const root = document.getElementById('app');

// 3. Debounced refresh scheduler
let refreshTimer = null;
export function scheduleRefresh(delayMs = 300) {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, delayMs);
}

// Quota takes ~5s to query, so it never blocks refresh(): fetch it in the background, at most once a minute
let usageAt = 0;
function loadUsage(fresh = false) {
  usageAt = Date.now();
  api.fetchUsage(fresh).then((u) => { state.usage = u; renderApp(); }).catch(() => {});
}

// 4. Fetch state and update UI (MUST FIX 4: pending refresh flag so mid-fetch refreshes are not dropped)
let isRefreshing = false;
let pendingRefresh = false;

export async function refresh() {
  if (isRefreshing) {
    pendingRefresh = true;
    return;
  }
  isRefreshing = true;

  try {
    const data = await api.fetchState();
    const workspaces = data.workspaces || [];
    state.workspaces = workspaces;

    if (!state.currentWorkspace && workspaces.length > 0) {
      const lastWs = loadLastWorkspace();
      const foundLast = lastWs && workspaces.some(w => w.workspace === lastWs);
      state.currentWorkspace = foundLast ? lastWs : workspaces[0].workspace;
    } else if (workspaces.length > 0 && !workspaces.some(w => w.workspace === state.currentWorkspace)) {
      state.currentWorkspace = workspaces[0].workspace;
    }

    state.lastUpdated = Date.now();
    if (Date.now() - usageAt > 60_000) loadUsage();
    renderApp();
  } catch (err) {
    if (err.status === 401) {
      renderUnauthorized();
    } else {
      console.error('State refresh failed:', err);
    }
  } finally {
    isRefreshing = false;
    if (pendingRefresh) {
      pendingRefresh = false;
      scheduleRefresh(50);
    }
  }
}

// 5. App layout rendering
function renderApp() {
  if (state.workspaces.length === 0) {
    root.replaceChildren(el('div', { class: 'empty-screen' },
      el('h1', null, 'cotalk'),
      el('div', { class: 'empty-box mt-4' },
        el('div', { class: 'empty-title' }, 'No Workspaces Found'),
        el('div', { class: 'empty-desc' }, 'Start an agent session in a directory with .cotalk.json.')
      )
    ));
    return;
  }

  // Preserve currently focused element and text selection
  const focused = document.activeElement;
  const focusedRid = focused && focused.dataset ? focused.dataset.rid : null;
  const focusedId = focused ? focused.id : null;
  const selStart = focused ? focused.selectionStart : null;
  const selEnd = focused ? focused.selectionEnd : null;

  const currentWsData = getCurrentWorkspaceData();

  // Header Component (CUT: single theme control in Settings, no toggle here)
  const connBadge = badge(state.connectionStatus, state.connectionStatus === 'live' ? 'live' : 'down');

  const wsOptions = state.workspaces.map(w =>
    el('option', { value: w.workspace, selected: w.workspace === state.currentWorkspace }, w.workspace)
  );

  const wsSelect = el('select', {
    class: 'input-select header-ws-select',
    value: state.currentWorkspace,
    onchange: (e) => {
      state.currentWorkspace = e.target.value;
      saveLastWorkspace(e.target.value);
      state.selectedRequestIds.clear();
      state.requestsHistoryOffset = 0;
      state.requestsHistory = [];
      state.workersLoaded = false;
      renderApp();
    },
  }, ...wsOptions);

  const header = el('header', { class: 'app-header' },
    el('div', { class: 'header-left' },
      el('span', { class: 'header-logo' }, 'cotalk'),
      connBadge,
      wsSelect
    ),
    el('div', { class: 'header-right' },
      ...usageChips(state.usage, () => loadUsage(true)),
      el('span', { class: 'header-time muted' }, `Updated ${formatClock(state.lastUpdated)}`)
    )
  );

  // Sidebar Component
  const waitingCount = (currentWsData && currentWsData.user && currentWsData.user.incoming
    ? currentWsData.user.incoming.filter(r => r.status === 'open' || r.status === 'claimed').length
    : 0);
  const requestsCount = (currentWsData && currentWsData.requests ? currentWsData.requests.length : 0);
  const boardCount = (currentWsData && currentWsData.board ? currentWsData.board.length : 0);
  const peersCount = (currentWsData && currentWsData.peers ? currentWsData.peers.length : 0);
  const eventsCount = (currentWsData && currentWsData.events ? currentWsData.events.length : 0);

  const navItem = (id, label, icon, countBadgeText, keyNumber) => {
    const isActive = state.activeView === id;
    const badgeEl = countBadgeText ? el('span', { class: `nav-badge ${id === 'inbox' && waitingCount > 0 ? 'nav-badge-alert' : ''}` }, countBadgeText) : null;
    const keyHint = el('kbd', { class: 'nav-key-hint' }, String(keyNumber));

    return el('button', {
      type: 'button',
      class: `nav-link ${isActive ? 'active' : ''}`,
      onclick: () => {
        switchView(id);
      },
    },
      el('span', { class: 'nav-icon' }, icon),
      el('span', { class: 'nav-label' }, label),
      badgeEl,
      keyHint
    );
  };

  const nav = el('nav', { class: 'app-sidebar' },
    el('div', { class: 'sidebar-nav' },
      navItem('inbox', 'Inbox', '📥', waitingCount > 0 ? String(waitingCount) : '', 1),
      navItem('requests', 'Requests', '📋', String(requestsCount), 2),
      navItem('board', 'Board', '📌', String(boardCount), 3),
      navItem('peers', 'Peers & Workers', '👥', String(peersCount), 4),
      navItem('events', 'Events', '📜', String(eventsCount), 5),
      navItem('settings', 'Settings', '⚙️', '', 6)
    )
  );

  // Main View Content
  let mainContent;
  switch (state.activeView) {
    case 'inbox':
      mainContent = renderInbox(currentWsData, scheduleRefresh);
      break;
    case 'requests':
      mainContent = renderRequests(currentWsData, scheduleRefresh);
      break;
    case 'board':
      mainContent = renderBoard(currentWsData, scheduleRefresh);
      break;
    case 'peers':
      mainContent = renderPeers(currentWsData, scheduleRefresh);
      break;
    case 'events':
      mainContent = renderEvents(currentWsData);
      break;
    case 'settings':
      mainContent = renderSettings(currentWsData, scheduleRefresh);
      break;
    default:
      mainContent = renderInbox(currentWsData, scheduleRefresh);
  }

  const main = el('main', { class: 'app-main' }, mainContent);

  const layout = el('div', { class: 'app-layout' },
    header,
    el('div', { class: 'app-body' },
      nav,
      main
    )
  );

  root.replaceChildren(layout);

  // Restore focus and cursor positions
  if (focusedRid) {
    const again = root.querySelector(`textarea[data-rid="${focusedRid}"]`);
    if (again) {
      again.focus();
      if (selStart !== null && selEnd !== null) {
        try { again.setSelectionRange(selStart, selEnd); } catch {}
      }
    }
  } else if (focusedId) {
    const elById = document.getElementById(focusedId);
    if (elById) {
      elById.focus();
      if (selStart !== null && selEnd !== null) {
        try { elById.setSelectionRange(selStart, selEnd); } catch {}
      }
    }
  }
}

function switchView(viewId) {
  if (state.activeView === viewId) return;
  state.activeView = viewId;
  if (viewId === 'peers') {
    startWorkersPolling(() => renderApp());
  } else {
    stopWorkersPolling();
  }
  renderApp();
}

function renderUnauthorized() {
  clearToasts();
  root.replaceChildren(el('div', { class: 'empty-screen' },
    el('h1', null, 'cotalk'),
    el('div', { class: 'empty-box error-box mt-4' },
      el('div', { class: 'empty-title' }, 'Not Signed In'),
      el('div', { class: 'empty-desc' }, 'Run `cotalk dashboard` and open the link it prints.')
    )
  ));
}

// 6. Setup SSE connection for live updates
function connectSSE() {
  const es = new EventSource('/events');

  es.onopen = () => {
    state.connectionStatus = 'live';
    renderApp();
    scheduleRefresh();
  };

  es.onmessage = (event) => {
    try {
      const ev = JSON.parse(event.data);
      // ALSO FIX: chime/notification only when ev.actor !== 'user', ev.target === 'user', current workspace, and document.hidden
      if (
        ev &&
        ev.actor !== 'user' &&
        ev.target === 'user' &&
        (!ev.workspace || ev.workspace === state.currentWorkspace) &&
        document.hidden
      ) {
        if (state.sound) playChime();
        if (state.notify) showDesktopNotification('cotalk', ev.summary || 'A request is waiting for you.');
      }
    } catch {}
    scheduleRefresh(300);
  };

  es.onerror = () => {
    state.connectionStatus = 'disconnected';
    renderApp();
  };
}

// 7. Keyboard Navigation (U6)
window.addEventListener('keydown', (e) => {
  // Esc closes drawer or modal
  if (e.key === 'Escape') {
    if (isModalOpen()) {
      closeModal();
      e.preventDefault();
      return;
    }
    if (isDrawerOpen()) {
      closeDrawer();
      e.preventDefault();
      return;
    }
  }

  // ALSO FIX: skip 1-6 and / while a modal or drawer is open
  if (isModalOpen() || isDrawerOpen()) return;

  const activeTag = document.activeElement ? document.activeElement.tagName.toLowerCase() : '';
  const isInputActive = activeTag === 'input' || activeTag === 'textarea' || activeTag === 'select';

  // / focuses search input if not typing
  if (e.key === '/' && !isInputActive) {
    const searchInput = document.getElementById('request-search-input') ||
      document.getElementById('board-search-input') ||
      document.getElementById('events-search-input') ||
      document.querySelector('.search-bar');
    if (searchInput) {
      e.preventDefault();
      searchInput.focus();
      return;
    }
  }

  // 1-6 switch views when not typing
  if (!isInputActive && !e.ctrlKey && !e.metaKey && !e.altKey) {
    const views = ['inbox', 'requests', 'board', 'peers', 'events', 'settings'];
    const num = parseInt(e.key, 10);
    if (num >= 1 && num <= 6) {
      e.preventDefault();
      switchView(views[num - 1]);
    }
  }
});

// 8. Startup & periodic polling fallback (30s)
refresh();
connectSSE();
setInterval(refresh, 30000);
