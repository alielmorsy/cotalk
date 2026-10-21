import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readSettings, writeSettings, getSettingsDefaults, validateSettings, SETTINGS_DEFAULTS } from '../daemon/settings.js';
import { LttError } from '../daemon/store.js';

test('settings: defaults match expected specification', () => {
  const defaults = getSettingsDefaults();
  assert.equal(defaults.activeMs, 120_000);
  assert.equal(defaults.idleMs, 1_800_000);
  assert.equal(defaults.eventRetentionDays, 7);
  assert.equal(defaults.eventRetentionKeepMin, 200);
});

test('settings: validateSettings checks ranges and invariants', () => {
  assert.equal(validateSettings({}).valid, true);
  assert.equal(validateSettings({ activeMs: 60_000 }).valid, true);

  // Range lower/upper bounds
  assert.equal(validateSettings({ activeMs: 20_000 }).valid, false);
  assert.equal(validateSettings({ activeMs: 4_000_000 }).valid, false);
  assert.equal(validateSettings({ idleMs: 500_000 }).valid, false);
  assert.equal(validateSettings({ idleMs: 90_000_000 }).valid, false);
  assert.equal(validateSettings({ eventRetentionDays: 0 }).valid, false);
  assert.equal(validateSettings({ eventRetentionDays: 400 }).valid, false);
  assert.equal(validateSettings({ eventRetentionKeepMin: 5 }).valid, false);
  assert.equal(validateSettings({ eventRetentionKeepMin: 20_000 }).valid, false);

  // Invariant: idleMs > activeMs
  assert.equal(validateSettings({ activeMs: 700_000, idleMs: 650_000 }).valid, false);
  assert.equal(validateSettings({ activeMs: 700_000, idleMs: 700_000 }).valid, false);
  assert.equal(validateSettings({ activeMs: 700_000, idleMs: 800_000 }).valid, true);

  // Non-integer / non-number
  assert.equal(validateSettings({ activeMs: 'fast' }).valid, false);
  assert.equal(validateSettings({ activeMs: 60_000.5 }).valid, false);
});

test('settings: readSettings returns defaults when config.json missing or empty', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ltt-settings-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const origHome = process.env.LTT_HOME;
  process.env.LTT_HOME = dir;
  t.after(() => {
    if (origHome) process.env.LTT_HOME = origHome;
    else delete process.env.LTT_HOME;
  });

  const s = await readSettings();
  assert.deepEqual(s, SETTINGS_DEFAULTS);
});

test('settings: readSettings resets out-of-range hand-edited values to defaults', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ltt-settings-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const origHome = process.env.LTT_HOME;
  process.env.LTT_HOME = dir;
  t.after(() => {
    if (origHome) process.env.LTT_HOME = origHome;
    else delete process.env.LTT_HOME;
  });

  const configFile = join(dir, 'config.json');
  // idleMs is below 600,000 (flapping danger) and activeMs is out of bounds
  writeFileSync(configFile, JSON.stringify({
    settings: {
      activeMs: 10_000,
      idleMs: 50_000,
      eventRetentionDays: 1000,
      eventRetentionKeepMin: 1,
    },
  }, null, 2), 'utf8');

  const s = await readSettings();
  assert.equal(s.activeMs, SETTINGS_DEFAULTS.activeMs);
  assert.equal(s.idleMs, SETTINGS_DEFAULTS.idleMs);
  assert.equal(s.eventRetentionDays, SETTINGS_DEFAULTS.eventRetentionDays);
  assert.equal(s.eventRetentionKeepMin, SETTINGS_DEFAULTS.eventRetentionKeepMin);
});

test('settings: writeSettings persists valid settings and merges with existing', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ltt-settings-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const origHome = process.env.LTT_HOME;
  process.env.LTT_HOME = dir;
  t.after(() => {
    if (origHome) process.env.LTT_HOME = origHome;
    else delete process.env.LTT_HOME;
  });

  const updated = await writeSettings({ activeMs: 60_000, idleMs: 1_200_000 });
  assert.equal(updated.activeMs, 60_000);
  assert.equal(updated.idleMs, 1_200_000);
  assert.equal(updated.eventRetentionDays, 7);
  assert.equal(updated.eventRetentionKeepMin, 200);

  const readBack = await readSettings();
  assert.deepEqual(readBack, updated);
});

test('settings: writeSettings preserves unrelated keys and persists only known settings', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ltt-settings-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const origHome = process.env.LTT_HOME;
  process.env.LTT_HOME = dir;
  t.after(() => {
    if (origHome) process.env.LTT_HOME = origHome;
    else delete process.env.LTT_HOME;
  });

  const configFile = join(dir, 'config.json');
  writeFileSync(configFile, JSON.stringify({ prevStatusLine: 'custom-status', otherKey: 123 }, null, 2), 'utf8');

  await writeSettings({ eventRetentionDays: 14, unknownField: 'ignore-me' });

  const raw = JSON.parse(readFileSync(configFile, 'utf8'));
  assert.equal(raw.prevStatusLine, 'custom-status');
  assert.equal(raw.otherKey, 123);
  assert.equal(raw.settings.eventRetentionDays, 14);
  assert.equal(raw.settings.activeMs, 120_000);
  assert.equal(raw.settings.unknownField, undefined);
});

test('settings: writeSettings rejects corrupted config.json with invalid error instead of overwriting', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ltt-settings-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const origHome = process.env.LTT_HOME;
  process.env.LTT_HOME = dir;
  t.after(() => {
    if (origHome) process.env.LTT_HOME = origHome;
    else delete process.env.LTT_HOME;
  });

  const configFile = join(dir, 'config.json');
  writeFileSync(configFile, '{ corrupted json syntax', 'utf8');

  await assert.rejects(
    async () => writeSettings({ activeMs: 60_000 }),
    (err) => err instanceof LttError && err.code === 'invalid'
  );
  // Ensure corrupted file was NOT destroyed or overwritten
  assert.equal(readFileSync(configFile, 'utf8'), '{ corrupted json syntax');
});

test('settings: writeSettings rejects invalid input with LttError invalid', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ltt-settings-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const origHome = process.env.LTT_HOME;
  process.env.LTT_HOME = dir;
  t.after(() => {
    if (origHome) process.env.LTT_HOME = origHome;
    else delete process.env.LTT_HOME;
  });

  await assert.rejects(async () => writeSettings(null), (err) => err instanceof LttError && err.code === 'invalid');
  await assert.rejects(async () => writeSettings('invalid'), (err) => err instanceof LttError && err.code === 'invalid');
  await assert.rejects(async () => writeSettings({ activeMs: 10_000 }), (err) => err instanceof LttError && err.code === 'invalid');
  await assert.rejects(async () => writeSettings({ idleMs: 500_000 }), (err) => err instanceof LttError && err.code === 'invalid');
  await assert.rejects(async () => writeSettings({ activeMs: 900_000, idleMs: 700_000 }), (err) => err instanceof LttError && err.code === 'invalid');
});
