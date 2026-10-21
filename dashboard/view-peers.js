// View: Peers & Background Workers (Roster, Process Control, Logs)
import { el, badge, formatDate, formatAgo } from './dom.js';
import { state, getRegisteredCwdsInCurrentWorkspace } from './state.js';
import * as api from './api.js';
import { openModal, closeModal, confirmAction } from './modal.js';
import { showToast } from './toast.js';

let workersPollTimer = null;

// `tool` values sent at registration by hooks/session-start.js, hooks/agy.js, hooks/codex.js, bin/worker.js
const TOOL_LABELS = { claude: 'Claude Code', agy: 'Antigravity', 'agy-worker': 'Antigravity (worker)', codex: 'Codex' };
export const toolLabel = (tool) => TOOL_LABELS[tool] || tool || 'unknown';

export async function fetchWorkersForWorkspace(onDone) {
  try {
    const data = await api.fetchWorkers({ workspace: state.currentWorkspace });
    state.workers = (data && data.workers) || [];
    state.workersLoaded = true;
    if (onDone) onDone();
  } catch {
    state.workersLoaded = true;
  }
}

export function startWorkersPolling(onUpdate) {
  stopWorkersPolling();
  fetchWorkersForWorkspace(onUpdate);
  workersPollTimer = setInterval(() => {
    if (state.activeView === 'peers') {
      fetchWorkersForWorkspace(onUpdate);
    }
  }, 10000);
}

export function stopWorkersPolling() {
  if (workersPollTimer) {
    clearInterval(workersPollTimer);
    workersPollTimer = null;
  }
}

export function renderPeers(wsData, onRefresh) {
  const peers = (wsData && wsData.peers) || [];
  const container = el('div', { class: 'view-container' });

  // 1. Peers Section Header
  const peersHeader = el('div', { class: 'view-header' },
    el('div', null,
      el('h2', null, 'Peers & Workers'),
      el('p', { class: 'view-desc' }, 'Registered agents and background worker process controls.')
    ),
    el('span', { class: 'badge b-ok' }, `${peers.length} agents`)
  );

  // Peers Table
  const peersTableWrapper = el('div', { class: 'table-container mb-6' });

  if (peers.length === 0) {
    peersTableWrapper.append(el('div', { class: 'empty-box' },
      el('div', { class: 'empty-title' }, 'No registered peers'),
      el('div', { class: 'empty-desc' }, 'Start an agent session in this workspace to see peers.')
    ));
  } else {
    const rows = peers.map(p => {
      const isUser = p.agent === 'user';
      const isOffline = p.status === 'offline';

      const forgetBtn = el('button', {
        type: 'button',
        class: 'btn-sm btn-danger',
        title: 'Forget this peer from workspace',
        disabled: isUser,
        onclick: () => {
          const mustForce = !isOffline;
          confirmAction({
            title: `Forget Peer "${p.agent}"`,
            message: mustForce
              ? `Agent "${p.agent}" is currently ${p.status}. Forcing removal will unclaim its tasks. Proceed?`
              : `Are you sure you want to forget offline agent "${p.agent}" from this workspace?`,
            confirmText: 'Forget Peer',
            confirmClass: 'btn-danger',
            onConfirm: async () => {
              await api.forgetPeer({
                workspace: state.currentWorkspace,
                agent: p.agent,
                force: mustForce,
              });
              showToast(`Agent "${p.agent}" forgotten.`, 'ok');
              if (onRefresh) onRefresh();
            },
          });
        },
      }, 'Forget');

      return el('tr', null,
        el('td', { class: 'mono font-bold' }, p.agent),
        el('td', { class: p.role ? '' : 'muted text-xs' }, p.role || '—'),
        el('td', null, badge(p.status)),
        el('td', { class: p.tool ? '' : 'muted text-xs', title: p.tool || 'registered without a tool' }, toolLabel(p.tool)),
        el('td', { class: 'mono text-xs td-owns', title: (p.owns || []).join(', ') },
          (p.owns && p.owns.length) ? p.owns.join(', ') : '—'
        ),
        el('td', { class: 'muted nowrap text-xs', title: formatDate(p.last_seen) }, formatAgo(p.last_seen)),
        el('td', { class: 'td-actions' }, forgetBtn)
      );
    });

    const tbl = el('table', { class: 'data-table' },
      el('thead', null,
        el('tr', null,
          el('th', null, 'Agent'),
          el('th', null, 'Role'),
          el('th', null, 'Status'),
          el('th', null, 'App'),
          el('th', null, 'Owned Paths'),
          el('th', null, 'Last Seen'),
          el('th', null, 'Actions')
        )
      ),
      el('tbody', null, ...rows)
    );

    peersTableWrapper.append(tbl);
  }

  // 2. Workers Section Header
  const workersHeader = el('div', { class: 'section-header mt-8' },
    el('div', null,
      el('h3', null, 'Background Workers'),
      el('p', { class: 'section-desc' }, 'Manage detached agent processes running via cotalk worker.')
    ),
    el('div', { class: 'header-actions' },
      el('button', {
        type: 'button',
        class: 'btn primary',
        onclick: () => openStartWorkerModal(onRefresh),
      }, '+ Start Worker')
    )
  );

  const workersTableWrapper = el('div', { class: 'table-container' });

  // MUST FIX 6: Render from state.workers directly without flickering loading screen
  function renderWorkersTable() {
    const workers = state.workers || [];

    if (!state.workersLoaded) {
      workersTableWrapper.replaceChildren(el('div', { class: 'loading-box' }, 'Checking background workers...'));
      fetchWorkersForWorkspace(() => renderWorkersTable());
      return;
    }

    if (workers.length === 0) {
      workersTableWrapper.replaceChildren(el('div', { class: 'empty-box' },
        el('div', { class: 'empty-title' }, 'No active background workers'),
        el('div', { class: 'empty-desc' }, 'Click "+ Start Worker" to launch a detached agent process.')
      ));
      return;
    }

    const rows = workers.map(w => {
      const stopBtn = el('button', {
        type: 'button',
        class: 'btn-sm btn-danger',
        title: 'Stop worker process',
        onclick: () => {
          confirmAction({
            title: `Stop Worker "${w.name}"`,
            message: `Are you sure you want to stop background worker "${w.name}" (PID: ${w.pid || 'unknown'})?`,
            confirmText: 'Stop Worker',
            confirmClass: 'btn-danger',
            onConfirm: async () => {
              const res = await api.stopWorker({
                workspace: state.currentWorkspace,
                name: w.name,
                force: false,
              });
              if (res && res.warning) {
                showToast(`Worker "${w.name}" stopped (${res.warning}).`, 'info');
              } else {
                showToast(`Worker "${w.name}" stopped.`, 'ok');
              }
              fetchWorkersForWorkspace(() => renderWorkersTable());
            },
          });
        },
      }, 'Stop');

      const logBtn = el('button', {
        type: 'button',
        class: 'btn-sm',
        title: 'View worker log',
        onclick: () => openWorkerLogModal(w.name),
      }, 'Tail Log');

      return el('tr', null,
        el('td', { class: 'mono font-bold' }, w.name),
        el('td', { class: 'mono text-xs' }, w.pid ? String(w.pid) : '—'),
        el('td', { class: 'mono text-xs' }, w.role || '—'),
        el('td', { class: 'mono text-xs', title: w.cwd }, w.cwd || '—'),
        el('td', null, badge(w.alive ? 'running' : 'stopped', w.alive ? 'ok' : 'bad')),
        el('td', { class: 'muted text-xs' }, w.startedAt ? formatAgo(w.startedAt) : '—'),
        el('td', { class: 'td-actions' }, logBtn, stopBtn)
      );
    });

    const tbl = el('table', { class: 'data-table' },
      el('thead', null,
        el('tr', null,
          el('th', null, 'Worker'),
          el('th', null, 'PID'),
          el('th', null, 'Role'),
          el('th', null, 'CWD'),
          el('th', null, 'Status'),
          el('th', null, 'Started'),
          el('th', null, 'Actions')
        )
      ),
      el('tbody', null, ...rows)
    );

    workersTableWrapper.replaceChildren(tbl);
  }

  renderWorkersTable();

  container.append(peersHeader, peersTableWrapper, workersHeader, workersTableWrapper);
  return container;
}

function openStartWorkerModal(onRefresh) {
  const cwds = getRegisteredCwdsInCurrentWorkspace();
  const nameInput = el('input', {
    type: 'text',
    class: 'input-text w-full',
    placeholder: 'Worker agent name (e.g. tester, review)',
    required: true,
  });

  const roleInput = el('input', {
    type: 'text',
    class: 'input-text w-full',
    placeholder: 'Worker role description',
  });

  const ownsInput = el('input', {
    type: 'text',
    class: 'input-text w-full',
    placeholder: 'Comma-separated owned paths (e.g. test/**, docs/**)',
  });

  // U5: cwd is a dropdown of the workspace's registered cwds
  const cwdSelect = el('select', { class: 'input-select w-full' },
    cwds.length > 0
      ? cwds.map(d => el('option', { value: d }, d))
      : el('option', { value: '' }, '(No registered agent directories)')
  );

  // U5: yolo checkbox shows a red warning
  const yoloWarning = el('div', {
    class: 'warning-box mt-2 text-danger hidden',
  }, '⚠️ Warning: --yolo auto-approves every tool and edits files completely unattended.');

  const yoloCheckbox = el('input', {
    type: 'checkbox',
    id: 'worker-yolo-cb',
    onchange: (e) => {
      yoloWarning.classList.toggle('hidden', !e.target.checked);
    },
  });

  const form = el('form', { class: 'form-box' },
    el('div', { class: 'form-group' },
      el('label', { class: 'form-label' }, 'Worker Name *'),
      nameInput
    ),
    el('div', { class: 'form-group' },
      el('label', { class: 'form-label' }, 'Role Description'),
      roleInput
    ),
    el('div', { class: 'form-group' },
      el('label', { class: 'form-label' }, 'Owned Paths'),
      ownsInput
    ),
    el('div', { class: 'form-group' },
      el('label', { class: 'form-label' }, 'Working Directory (CWD) *'),
      cwdSelect
    ),
    el('div', { class: 'form-group' },
      el('label', { class: 'form-checkbox-label' },
        yoloCheckbox,
        el('span', { class: 'ml-2' }, 'Run with --yolo mode (unattended execution)')
      ),
      yoloWarning
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
      const name = nameInput.value.trim();
      const cwd = cwdSelect.value;
      if (!name) {
        nameInput.focus();
        showToast('Please enter a worker name.', 'bad');
        return;
      }
      if (!cwd) {
        showToast('A registered workspace directory is required.', 'bad');
        return;
      }

      submitBtn.disabled = true;
      try {
        const owns = ownsInput.value.split(',').map(s => s.trim()).filter(Boolean);
        await api.startWorker({
          workspace: state.currentWorkspace,
          name,
          role: roleInput.value.trim() || undefined,
          owns: owns.length ? owns : undefined,
          cwd,
          yolo: yoloCheckbox.checked,
        });
        closeModal();
        showToast(`Worker "${name}" spawned successfully.`, 'ok');
        fetchWorkersForWorkspace(() => {
          if (onRefresh) onRefresh();
        });
      } catch (err) {
        submitBtn.disabled = false;
        showToast(`Failed to start worker: ${err.message}`, 'bad');
      }
    },
  }, 'Start Worker');

  openModal({
    title: 'Start Background Worker',
    content: form,
    actions: [cancelBtn, submitBtn],
  });
}

function openWorkerLogModal(workerName) {
  const logBox = el('div', { class: 'log-tail-box' }, 'Loading log...');
  let timer = null;

  async function fetchLog() {
    try {
      const data = await api.fetchWorkerLog({
        workspace: state.currentWorkspace,
        name: workerName,
        lines: 100,
      });
      const lines = (data && data.lines) || [];
      if (lines.length === 0) {
        logBox.textContent = '(Log file is currently empty)';
      } else {
        logBox.textContent = lines.join('\n');
        logBox.scrollTop = logBox.scrollHeight;
      }
    } catch (err) {
      logBox.textContent = `Error fetching log: ${err.message}`;
    }
  }

  fetchLog();
  timer = setInterval(fetchLog, 2500);

  const closeBtn = el('button', {
    type: 'button',
    class: 'btn',
    onclick: () => {
      clearInterval(timer);
      closeModal();
    },
  }, 'Close');

  const refreshBtn = el('button', {
    type: 'button',
    class: 'btn',
    onclick: () => fetchLog(),
  }, 'Refresh Now');

  openModal({
    title: `Worker Log: ${workerName}`,
    content: logBox,
    actions: [refreshBtn, closeBtn],
    onClose: () => clearInterval(timer),
  });
}
