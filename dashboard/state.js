// Central state management.
// U7: All localStorage reads/writes are wrapped in try/catch; page works if unavailable.

const LAST_WS_KEY = 'cotalk_last_workspace';
const THEME_KEY = 'cotalk_dashboard_theme';

export function loadLastWorkspace() {
  try {
    return localStorage.getItem(LAST_WS_KEY) || '';
  } catch {
    return '';
  }
}

export function saveLastWorkspace(ws) {
  try {
    if (ws) localStorage.setItem(LAST_WS_KEY, ws);
  } catch {}
}

export function loadTheme() {
  try {
    return localStorage.getItem(THEME_KEY) || 'system';
  } catch {
    return 'system';
  }
}

export function saveTheme(theme) {
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {}
}

export const state = {
  currentWorkspace: '',
  workspaces: [],
  activeView: 'inbox',
  theme: loadTheme(),
  sound: false,
  notify: false,

  // Filters persisted across live re-renders (MUST FIX 2)
  filters: {
    status: 'all',
    kind: 'all',
    from: 'all',
    to: 'all',
    query: '',
  },
  boardFilters: {
    query: '',
    kind: 'all',
  },
  eventsFilters: {
    query: '',
    type: 'all',
  },

  // Requests History (MUST FIX 5)
  requestsHistory: [],
  requestsHistoryTotal: 0,
  requestsHistoryOffset: 0,
  requestsHistoryLoading: false,

  // Selected request IDs for bulk cancel
  selectedRequestIds: new Set(),

  // In-flight respond IDs (ALSO FIX)
  inFlightRespondIds: new Set(),

  // Response drafts per request ID
  drafts: new Map(),

  // Background workers cache (MUST FIX 6)
  workers: [],
  workersLoaded: false,

  // Quota of agy and claude (GET /api/usage); null until the first fetch
  usage: null,

  connectionStatus: 'connecting',
  lastUpdated: Date.now(),
};

export function applyTheme(theme) {
  state.theme = theme;
  saveTheme(theme);
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (theme === 'dark') {
    root.setAttribute('data-theme', 'dark');
  } else if (theme === 'light') {
    root.setAttribute('data-theme', 'light');
  } else {
    root.removeAttribute('data-theme');
  }
}

export function getCurrentWorkspaceData() {
  return state.workspaces.find(w => w.workspace === state.currentWorkspace) || null;
}

export function getAllAgentsInCurrentWorkspace() {
  const ws = getCurrentWorkspaceData();
  if (!ws) return [];
  const list = (ws.peers || []).map(p => p.agent);
  if (!list.includes('user')) list.push('user');
  return list;
}

export function getRegisteredCwdsInCurrentWorkspace() {
  const ws = getCurrentWorkspaceData();
  if (!ws) return [];
  const set = new Set();
  for (const p of ws.peers || []) {
    if (p.cwd) set.add(p.cwd);
  }
  return [...set];
}
