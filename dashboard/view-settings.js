// View: Settings (Browser Preferences, Roster Editor, Daemon Settings, Danger Zone)
// MUST FIX 1: Form values preserved in module state so live refreshes never wipe inputs mid-typing.
import { el } from './dom.js';
import { state, applyTheme, getRegisteredCwdsInCurrentWorkspace } from './state.js';
import * as api from './api.js';
import { playChime, requestNotificationPermission } from './notify.js';
import { showToast } from './toast.js';

// Module-level form cache to protect inputs across live refreshes (MUST FIX 1)
let cachedWorkspace = '';
let rosterCwd = '';
let rosterText = '';
let rosterPath = '';
let rosterLoaded = false;
let rosterLoading = false;

let daemonSettings = null;
let daemonSettingsLoaded = false;
let daemonSettingsLoading = false;

let cachedActiveVal = null;
let cachedActiveUnit = 'm';
let cachedIdleVal = null;
let cachedIdleUnit = 'm';
let cachedRetDays = null;
let cachedRetMin = null;

let dangerTypedText = '';

export function renderSettings(wsData, onRefresh) {
  // If workspace changed, reset caches
  if (state.currentWorkspace !== cachedWorkspace) {
    cachedWorkspace = state.currentWorkspace;
    rosterCwd = '';
    rosterText = '';
    rosterPath = '';
    rosterLoaded = false;
    rosterLoading = false;
    daemonSettings = null;
    daemonSettingsLoaded = false;
    daemonSettingsLoading = false;
    cachedActiveVal = null;
    cachedActiveUnit = 'm';
    cachedIdleVal = null;
    cachedIdleUnit = 'm';
    cachedRetDays = null;
    cachedRetMin = null;
    dangerTypedText = '';
  }

  const container = el('div', { class: 'view-container' });

  const topHeader = el('div', { class: 'view-header' },
    el('div', null,
      el('h2', null, 'Settings'),
      el('p', { class: 'view-desc' }, 'Browser preferences, agent roster configuration, and daemon settings.')
    )
  );

  // 1. Browser Preferences Card (CUT: single theme control here)
  const themeSelect = el('select', {
    id: 'settings-theme-select',
    class: 'input-select',
    value: state.theme,
    onchange: (e) => {
      applyTheme(e.target.value);
      showToast(`Theme changed to ${e.target.value}.`, 'ok');
    },
  },
    el('option', { value: 'system' }, 'System Default'),
    el('option', { value: 'light' }, 'Light Theme'),
    el('option', { value: 'dark' }, 'Dark Theme')
  );

  const soundCheckbox = el('input', {
    type: 'checkbox',
    id: 'settings-sound-checkbox',
    checked: state.sound,
    onchange: (e) => {
      state.sound = e.target.checked;
      if (e.target.checked) playChime();
    },
  });

  const testChimeBtn = el('button', {
    type: 'button',
    class: 'btn-sm',
    onclick: () => playChime(),
  }, 'Test Sound');

  const notifyCheckbox = el('input', {
    type: 'checkbox',
    id: 'settings-notify-checkbox',
    checked: state.notify,
    onchange: async (e) => {
      if (e.target.checked) {
        const perm = await requestNotificationPermission();
        if (perm === 'granted') {
          state.notify = true;
          showToast('Desktop notifications enabled.', 'ok');
        } else {
          e.target.checked = false;
          state.notify = false;
          showToast('Notification permission was not granted.', 'bad');
        }
      } else {
        state.notify = false;
      }
    },
  });

  const prefsCard = el('div', { class: 'settings-card' },
    el('h3', { class: 'settings-card-title' }, 'Browser Preferences'),
    el('div', { class: 'form-group' },
      el('label', { class: 'form-label' }, 'Color Theme'),
      themeSelect
    ),
    el('div', { class: 'form-group' },
      el('label', { class: 'form-checkbox-label' },
        soundCheckbox,
        el('span', { class: 'ml-2' }, 'Sound Chime on new tasks/questions for you')
      ),
      el('div', { class: 'mt-2' }, testChimeBtn)
    ),
    el('div', { class: 'form-group' },
      el('label', { class: 'form-checkbox-label' },
        notifyCheckbox,
        el('span', { class: 'ml-2' }, 'Desktop Notifications when something is waiting on you')
      )
    )
  );

  // 2. Agent Roster Editor (.cotalk.json)
  const rosterCard = el('div', { class: 'settings-card mt-6' },
    el('h3', { class: 'settings-card-title' }, 'Agent Roster (.cotalk.json)'),
    el('p', { class: 'settings-card-desc' }, 'View and edit the team roster definition for this workspace.')
  );

  const rosterContent = el('div', { class: 'mt-4' });
  rosterCard.append(rosterContent);

  function renderRosterForm() {
    const cwds = getRegisteredCwdsInCurrentWorkspace();
    if (!rosterCwd && cwds.length > 0) rosterCwd = cwds[0];

    // ALSO FIX: CWD dropdown for roster when multiple exist
    let cwdSelector = null;
    if (cwds.length > 1) {
      cwdSelector = el('div', { class: 'form-group' },
        el('label', { class: 'form-label' }, 'Roster Directory:'),
        el('select', {
          id: 'settings-roster-cwd-select',
          class: 'input-select w-full',
          value: rosterCwd,
          onchange: (e) => {
            rosterCwd = e.target.value;
            rosterLoaded = false;
            fetchRosterData();
          },
        }, ...cwds.map(c => el('option', { value: c }, c)))
      );
    }

    const textarea = el('textarea', {
      id: 'settings-roster-textarea',
      class: 'input-textarea font-mono text-xs w-full',
      rows: 8,
      oninput: (e) => {
        rosterText = e.target.value;
      },
    });
    textarea.value = rosterText;

    const statusEl = el('span', { class: 'action-status' });

    const saveRosterBtn = el('button', {
      type: 'button',
      class: 'btn primary',
      onclick: async () => {
        let parsed;
        try {
          parsed = JSON.parse(textarea.value);
          if (!Array.isArray(parsed)) throw new Error('Roster agents must be a JSON array');
        } catch (err) {
          showToast(`JSON Syntax Error: ${err.message}`, 'bad');
          return;
        }

        saveRosterBtn.disabled = true;
        statusEl.textContent = 'saving...';
        try {
          await api.saveRoster({
            workspace: state.currentWorkspace,
            cwd: rosterCwd,
            agents: parsed,
          });
          statusEl.textContent = 'saved!';
          showToast('Roster saved successfully.', 'ok');
          if (onRefresh) onRefresh();
        } catch (err) {
          statusEl.textContent = `error: ${err.message}`;
          showToast(`Save roster failed: ${err.message}`, 'bad');
        } finally {
          saveRosterBtn.disabled = false;
        }
      },
    }, 'Save Roster');

    rosterContent.replaceChildren(
      cwdSelector,
      el('div', { class: 'mb-2 text-xs muted mono' }, `File: ${rosterPath || '.cotalk.json'}`),
      el('div', { class: 'form-group' },
        el('label', { class: 'form-label' }, 'Roster JSON Definition:'),
        textarea
      ),
      el('div', { class: 'flex-row gap-2' },
        saveRosterBtn,
        statusEl
      )
    );
  }

  async function fetchRosterData() {
    if (rosterLoading) return;
    rosterLoading = true;
    rosterContent.replaceChildren(el('div', { class: 'loading-box' }, 'Loading roster...'));
    try {
      const cwds = getRegisteredCwdsInCurrentWorkspace();
      if (!rosterCwd && cwds.length > 0) rosterCwd = cwds[0];
      const data = await api.fetchRoster({
        workspace: state.currentWorkspace,
        cwd: rosterCwd || undefined,
      });

      rosterPath = data.path || '.cotalk.json';
      rosterText = JSON.stringify(data.agents || [], null, 2);
      rosterLoaded = true;
      renderRosterForm();
    } catch (err) {
      rosterContent.replaceChildren(el('div', { class: 'error-box' },
        `Unable to load roster: ${err.message}`
      ));
    } finally {
      rosterLoading = false;
    }
  }

  if (rosterLoaded) {
    renderRosterForm();
  } else {
    fetchRosterData();
  }

  // 3. Daemon Runtime Settings (~/.cotalk/config.json)
  const daemonCard = el('div', { class: 'settings-card mt-6' },
    el('h3', { class: 'settings-card-title' }, 'Daemon Runtime Settings'),
    el('p', { class: 'settings-card-desc' }, 'Configure agent activity thresholds and event retention rules.')
  );

  const daemonContent = el('div', { class: 'mt-4' });
  daemonCard.append(daemonContent);

  function initSettingsCache(s) {
    if (cachedActiveVal === null) {
      const act = s.activeMs ?? 120000;
      if (act >= 60000 && act % 60000 === 0) {
        cachedActiveVal = act / 60000;
        cachedActiveUnit = 'm';
      } else {
        cachedActiveVal = Math.round(act / 1000);
        cachedActiveUnit = 's';
      }
    }
    if (cachedIdleVal === null) {
      const idl = s.idleMs ?? 1800000;
      if (idl >= 3600000 && idl % 3600000 === 0) {
        cachedIdleVal = idl / 3600000;
        cachedIdleUnit = 'h';
      } else {
        cachedIdleVal = Math.round(idl / 60000);
        cachedIdleUnit = 'm';
      }
    }
    if (cachedRetDays === null) {
      cachedRetDays = s.eventRetentionDays ?? 7;
    }
    if (cachedRetMin === null) {
      cachedRetMin = s.eventRetentionKeepMin ?? 200;
    }
  }

  function renderDaemonSettingsForm() {
    const s = daemonSettings || {};
    initSettingsCache(s);

    const activeValInput = el('input', {
      type: 'number',
      id: 'settings-active-val',
      class: 'input-text',
      value: cachedActiveVal,
      min: cachedActiveUnit === 'm' ? 0.5 : 30,
      max: cachedActiveUnit === 'm' ? 60 : 3600,
      step: cachedActiveUnit === 'm' ? 0.5 : 1,
      oninput: (e) => { cachedActiveVal = Number(e.target.value); },
    });

    const activeUnitSelect = el('select', {
      id: 'settings-active-unit',
      class: 'input-select',
      value: cachedActiveUnit,
      onchange: (e) => {
        const newUnit = e.target.value;
        if (newUnit !== cachedActiveUnit && cachedActiveVal !== null) {
          if (newUnit === 'm') {
            cachedActiveVal = Math.round((cachedActiveVal / 60) * 10) / 10;
          } else {
            cachedActiveVal = Math.round(cachedActiveVal * 60);
          }
          activeValInput.value = cachedActiveVal;
        }
        cachedActiveUnit = newUnit;
        activeValInput.min = newUnit === 'm' ? 0.5 : 30;
        activeValInput.max = newUnit === 'm' ? 60 : 3600;
        activeValInput.step = newUnit === 'm' ? 0.5 : 1;
      },
    },
      el('option', { value: 's' }, 'seconds (s)'),
      el('option', { value: 'm' }, 'minutes (m)')
    );

    const idleValInput = el('input', {
      type: 'number',
      id: 'settings-idle-val',
      class: 'input-text',
      value: cachedIdleVal,
      min: cachedIdleUnit === 'h' ? 0.2 : 10,
      max: cachedIdleUnit === 'h' ? 24 : 1440,
      step: cachedIdleUnit === 'h' ? 0.1 : 1,
      oninput: (e) => { cachedIdleVal = Number(e.target.value); },
    });

    const idleUnitSelect = el('select', {
      id: 'settings-idle-unit',
      class: 'input-select',
      value: cachedIdleUnit,
      onchange: (e) => {
        const newUnit = e.target.value;
        if (newUnit !== cachedIdleUnit && cachedIdleVal !== null) {
          if (newUnit === 'h') {
            cachedIdleVal = Math.round((cachedIdleVal / 60) * 10) / 10;
          } else {
            cachedIdleVal = Math.round(cachedIdleVal * 60);
          }
          idleValInput.value = cachedIdleVal;
        }
        cachedIdleUnit = newUnit;
        idleValInput.min = newUnit === 'h' ? 0.2 : 10;
        idleValInput.max = newUnit === 'h' ? 24 : 1440;
        idleValInput.step = newUnit === 'h' ? 0.1 : 1;
      },
    },
      el('option', { value: 'm' }, 'minutes (m)'),
      el('option', { value: 'h' }, 'hours (h)')
    );

    const retDaysInput = el('input', {
      type: 'number',
      id: 'settings-ret-days',
      class: 'input-text',
      value: cachedRetDays,
      min: 1,
      max: 365,
      oninput: (e) => { cachedRetDays = Number(e.target.value); },
    });

    const retMinInput = el('input', {
      type: 'number',
      id: 'settings-ret-min',
      class: 'input-text',
      value: cachedRetMin,
      min: 10,
      max: 10000,
      oninput: (e) => { cachedRetMin = Number(e.target.value); },
    });

    const saveSettingsBtn = el('button', {
      type: 'button',
      class: 'btn primary',
      onclick: async () => {
        const activeMs = cachedActiveUnit === 'm'
          ? Math.round(Number(activeValInput.value) * 60000)
          : Math.round(Number(activeValInput.value) * 1000);

        const idleMs = cachedIdleUnit === 'h'
          ? Math.round(Number(idleValInput.value) * 3600000)
          : Math.round(Number(idleValInput.value) * 60000);

        const retDays = Math.round(Number(retDaysInput.value));
        const retMin = Math.round(Number(retMinInput.value));

        if (isNaN(activeMs) || activeMs < 30000 || activeMs > 3600000) {
          showToast('Active threshold must be between 30 s and 60 min.', 'bad');
          return;
        }
        if (isNaN(idleMs) || idleMs < 600000 || idleMs > 86400000) {
          showToast('Idle threshold must be between 10 min and 24 h.', 'bad');
          return;
        }
        if (idleMs <= activeMs) {
          showToast('Idle threshold must be greater than active threshold.', 'bad');
          return;
        }
        if (isNaN(retDays) || retDays < 1 || retDays > 365) {
          showToast('Event retention must be between 1 and 365 days.', 'bad');
          return;
        }
        if (isNaN(retMin) || retMin < 10 || retMin > 10000) {
          showToast('Minimum events kept must be between 10 and 10000.', 'bad');
          return;
        }

        saveSettingsBtn.disabled = true;
        try {
          await api.saveSettings({
            settings: {
              activeMs,
              idleMs,
              eventRetentionDays: retDays,
              eventRetentionKeepMin: retMin,
            },
          });
          showToast('Daemon settings saved and applied.', 'ok');
        } catch (err) {
          showToast(`Failed to save settings: ${err.message}`, 'bad');
        } finally {
          saveSettingsBtn.disabled = false;
        }
      },
    }, 'Save Daemon Settings');

    daemonContent.replaceChildren(
      el('div', { class: 'form-row' },
        el('div', { class: 'form-col' },
          el('label', { class: 'form-label' }, 'Active Threshold'),
          el('div', { class: 'input-group' }, activeValInput, activeUnitSelect),
          el('p', { class: 'input-range' }, 'Allowed: 30 s–60 min'),
          el('p', { class: 'input-hint' }, 'Peer considered active if seen within this period')
        ),
        el('div', { class: 'form-col' },
          el('label', { class: 'form-label' }, 'Idle Threshold'),
          el('div', { class: 'input-group' }, idleValInput, idleUnitSelect),
          el('p', { class: 'input-range' }, 'Allowed: 10 min–24 h'),
          el('p', { class: 'input-hint' }, 'Peer considered idle before being marked offline')
        )
      ),
      el('div', { class: 'form-row mt-4' },
        el('div', { class: 'form-col' },
          el('label', { class: 'form-label' }, 'Event Retention (Days)'),
          retDaysInput,
          el('p', { class: 'input-range' }, 'Allowed: 1–365 days'),
          el('p', { class: 'input-hint' }, 'Days to retain completed audit events')
        ),
        el('div', { class: 'form-col' },
          el('label', { class: 'form-label' }, 'Minimum Events Kept'),
          retMinInput,
          el('p', { class: 'input-range' }, 'Allowed: 10–10000 events'),
          el('p', { class: 'input-hint' }, 'Always retain at least this many recent events')
        )
      ),
      el('div', { class: 'mt-4' }, saveSettingsBtn)
    );
  }

  async function fetchSettingsData() {
    if (daemonSettingsLoading) return;
    daemonSettingsLoading = true;
    daemonContent.replaceChildren(el('div', { class: 'loading-box' }, 'Loading settings...'));
    try {
      const data = await api.fetchSettings();
      daemonSettings = (data && data.settings) || {};
      daemonSettingsLoaded = true;
      renderDaemonSettingsForm();
    } catch (err) {
      daemonContent.replaceChildren(el('div', { class: 'error-box' },
        `Unable to load daemon settings: ${err.message}`
      ));
    } finally {
      daemonSettingsLoading = false;
    }
  }

  if (daemonSettingsLoaded) {
    renderDaemonSettingsForm();
  } else {
    fetchSettingsData();
  }

  // 4. Danger Zone (U4: typed workspace name confirmation preserved across renders)
  const currentWs = state.currentWorkspace;
  const typedInput = el('input', {
    type: 'text',
    id: 'settings-danger-typed-input',
    class: 'input-text',
    placeholder: `Type "${currentWs}" to enable clear`,
    value: dangerTypedText,
    oninput: (e) => {
      dangerTypedText = e.target.value;
      clearBtn.disabled = dangerTypedText.trim() !== currentWs;
    },
  });

  const clearBtn = el('button', {
    type: 'button',
    class: 'btn btn-danger',
    disabled: dangerTypedText.trim() !== currentWs,
    onclick: async () => {
      clearBtn.disabled = true;
      try {
        await api.clearWorkspace({ workspace: currentWs });
        showToast(`Workspace "${currentWs}" cleared.`, 'ok');
        dangerTypedText = '';
        typedInput.value = '';
        if (onRefresh) onRefresh();
      } catch (err) {
        clearBtn.disabled = false;
        showToast(`Failed to clear workspace: ${err.message}`, 'bad');
      }
    },
  }, 'Permanently Clear Workspace');

  const dangerCard = el('div', { class: 'settings-card danger-card mt-8' },
    el('h3', { class: 'settings-card-title text-bad' }, 'Danger Zone'),
    el('p', { class: 'settings-card-desc' },
      `Clearing the workspace deletes all registered peers, board entries, requests, and event history for "${currentWs}". This cannot be undone.`
    ),
    el('div', { class: 'danger-confirm-box mt-4' },
      el('label', { class: 'form-label font-bold' }, `To confirm, type "${currentWs}" below:`),
      typedInput,
      el('div', { class: 'mt-3' }, clearBtn)
    )
  );

  container.append(topHeader, prefsCard, rosterCard, daemonCard, dangerCard);
  return container;
}
