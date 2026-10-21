import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { home as homeDir, port as portNum } from '../lib/client.js';
import { openStore } from './store.js';
import { createServer } from './server.js';
import { createMcpHandler } from './mcp.js';
import * as workers from './workers.js';
import * as roster from './roster.js';
import * as settings from './settings.js';
import * as usage from './usage.js';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const home = homeDir();
const port = portNum();
mkdirSync(home, { recursive: true });

const tokenPath = join(home, 'token');
let token = '';
try { token = readFileSync(tokenPath, 'utf8').trim(); } catch {}
if (!token) {
  token = randomBytes(24).toString('hex');
  // wx: concurrent starts can't write different tokens; the loser re-reads the winner's
  try { writeFileSync(tokenPath, token, { flag: 'wx', mode: 0o600 }); } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    token = readFileSync(tokenPath, 'utf8').trim();
    if (!token) throw new Error(`${tokenPath} is empty; delete it and restart`); // never serve with an empty token
  }
}

const initialSettings = await settings.readSettings().catch(() => settings.getSettingsDefaults());
const store = openStore(join(home, 'cotalk.db'));

const applySettings = (s) => {
  if (s?.activeMs || s?.idleMs) store.setThresholds({ activeMs: s.activeMs, idleMs: s.idleMs });
  const maxAgeMs = (s?.eventRetentionDays ?? 7) * 86_400_000;
  const keepMin = s?.eventRetentionKeepMin ?? 200;
  store.pruneEvents({ maxAgeMs, keepMin });
};
try { applySettings(initialSettings); } catch {}
const pruneTimer = setInterval(async () => {
  try { applySettings(await settings.readSettings()); } catch {}
}, 3_600_000);
pruneTimer.unref();

const shutdown = () => {
  clearInterval(pruneTimer);
  server.closeAllConnections();
  server.close();
  store.close();
  process.exit(0);
};
const { server } = createServer({
  store, token, port, version,
  workers, roster, settings, usage, applySettings,
  mcpFactory: (waitForEvent) => createMcpHandler(store, { waitForEvent, version }),
  onShutdown: () => setTimeout(shutdown, 50), // let the {ok: true} response flush first
});

server.on('error', (err) => {
  if (err.code !== 'EADDRINUSE') throw err;
  console.log(`cotalk already running on port ${port}`);
  store.close();
  process.exit(0);
});
server.listen(port, '127.0.0.1', () => console.log(`cotalk ${version} listening on http://127.0.0.1:${port}`));
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
