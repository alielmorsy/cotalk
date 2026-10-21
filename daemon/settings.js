import { readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { CotalkError } from './store.js';
import { home } from '../lib/client.js';

export const SETTINGS_DEFAULTS = Object.freeze({
  activeMs: 120_000,
  idleMs: 1_800_000,
  eventRetentionDays: 7,
  eventRetentionKeepMin: 200,
});

export const SETTINGS_RANGES = Object.freeze({
  activeMs: { min: 30_000, max: 3_600_000 },
  idleMs: { min: 600_000, max: 86_400_000 },
  eventRetentionDays: { min: 1, max: 365 },
  eventRetentionKeepMin: { min: 10, max: 10_000 },
});

export const configFilePath = () => join(home(), 'config.json');

export function getSettingsDefaults() {
  return { ...SETTINGS_DEFAULTS };
}

export function validateSettings(settings, current = SETTINGS_DEFAULTS) {
  const errors = [];
  const merged = { ...current, ...settings };

  for (const [key, range] of Object.entries(SETTINGS_RANGES)) {
    const val = merged[key];
    if (typeof val !== 'number' || !Number.isFinite(val) || !Number.isInteger(val)) {
      errors.push(`${key} must be an integer`);
    } else if (val < range.min || val > range.max) {
      errors.push(`${key} must be between ${range.min} and ${range.max}`);
    }
  }

  if (typeof merged.idleMs === 'number' && typeof merged.activeMs === 'number') {
    if (merged.idleMs <= merged.activeMs) {
      errors.push('idleMs must be strictly greater than activeMs');
    }
  }

  return { valid: errors.length === 0, errors, merged };
}

export async function readSettings() {
  const file = configFilePath();
  let parsed = null;
  try {
    const raw = readFileSync(file, 'utf8');
    parsed = JSON.parse(raw);
  } catch {}

  const saved = parsed?.settings && typeof parsed.settings === 'object' ? parsed.settings : {};
  const result = { ...SETTINGS_DEFAULTS };

  for (const [key, range] of Object.entries(SETTINGS_RANGES)) {
    const val = saved[key];
    if (typeof val === 'number' && Number.isFinite(val) && Number.isInteger(val) && val >= range.min && val <= range.max) {
      result[key] = val;
    }
  }

  if (result.idleMs <= result.activeMs) {
    result.activeMs = SETTINGS_DEFAULTS.activeMs;
    result.idleMs = SETTINGS_DEFAULTS.idleMs;
  }

  return result;
}

export async function writeSettings(newSettings) {
  if (!newSettings || typeof newSettings !== 'object' || Array.isArray(newSettings)) {
    throw new CotalkError('invalid', 'settings must be an object');
  }

  const file = configFilePath();
  let existing = {};
  try {
    const raw = readFileSync(file, 'utf8');
    existing = JSON.parse(raw);
    if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
      throw new CotalkError('invalid', 'config.json root must be an object');
    }
  } catch (err) {
    if (err instanceof CotalkError) throw err;
    if (err.code !== 'ENOENT') {
      throw new CotalkError('invalid', `failed to read config.json: ${err.message}`);
    }
  }

  const currentSettings = existing.settings && typeof existing.settings === 'object'
    ? { ...SETTINGS_DEFAULTS, ...existing.settings }
    : { ...SETTINGS_DEFAULTS };

  const { valid, errors, merged } = validateSettings(newSettings, currentSettings);
  if (!valid) {
    throw new CotalkError('invalid', errors.join('; '));
  }

  const sanitized = {
    activeMs: merged.activeMs,
    idleMs: merged.idleMs,
    eventRetentionDays: merged.eventRetentionDays,
    eventRetentionKeepMin: merged.eventRetentionKeepMin,
  };

  existing.settings = sanitized;

  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  try {
    writeFileSync(tmp, JSON.stringify(existing, null, 2) + '\n', 'utf8');
    renameSync(tmp, file);
  } catch (err) {
    try { unlinkSync(tmp); } catch {}
    throw err;
  }

  return sanitized;
}
