import { readFileSync, writeFileSync, copyFileSync, renameSync, unlinkSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { LttError, USER } from './store.js';
import { checkAllowedDir, NAME } from './workers.js';

export async function readRoster({ cwd, workspace, allowedDirs } = {}) {
  const dir = cwd || (Array.isArray(allowedDirs) && allowedDirs.length > 0 ? allowedDirs[0] : null);
  if (!dir) throw new LttError('invalid', 'cwd or allowedDirs is required');
  checkAllowedDir(dir, allowedDirs);

  const lttPath = join(resolve(dir), '.ltt.json');
  if (!existsSync(lttPath)) {
    throw new LttError('not_found', `no .ltt.json found in ${dir}`);
  }

  let file;
  try {
    const raw = readFileSync(lttPath, 'utf8');
    file = JSON.parse(raw);
  } catch (err) {
    throw new LttError('invalid', `failed to parse .ltt.json: ${err.message}`);
  }

  if (!file || typeof file !== 'object' || Array.isArray(file)) {
    throw new LttError('invalid', 'invalid .ltt.json: root must be an object');
  }

  if (workspace && file.workspace && file.workspace !== workspace) {
    throw new LttError('invalid', `workspace mismatch: expected ${workspace}, found ${file.workspace}`);
  }

  const isMulti = file.agents && typeof file.agents === 'object' && !Array.isArray(file.agents);
  const agents = [];

  if (isMulti) {
    for (const [agentName, agentData] of Object.entries(file.agents)) {
      const data = agentData && typeof agentData === 'object' ? agentData : {};
      agents.push({
        agent: agentName,
        role: typeof data.role === 'string' ? data.role : '',
        owns: Array.isArray(data.owns) ? data.owns.filter(s => typeof s === 'string') : [],
      });
    }
    return {
      path: lttPath,
      format: 'multi',
      workspace: file.workspace || workspace || '',
      agents,
    };
  }

  if (file.agent && typeof file.agent === 'string') {
    agents.push({
      agent: file.agent,
      role: typeof file.role === 'string' ? file.role : '',
      owns: Array.isArray(file.owns) ? file.owns.filter(s => typeof s === 'string') : [],
    });
    return {
      path: lttPath,
      format: 'single',
      workspace: file.workspace || workspace || '',
      agents,
    };
  }

  throw new LttError('invalid', 'invalid .ltt.json: must specify agent or agents map');
}

export async function writeRoster({ cwd, workspace, agents, allowedDirs } = {}) {
  const dir = cwd || (Array.isArray(allowedDirs) && allowedDirs.length > 0 ? allowedDirs[0] : null);
  if (!dir) throw new LttError('invalid', 'cwd or allowedDirs is required');
  checkAllowedDir(dir, allowedDirs);

  const lttPath = join(resolve(dir), '.ltt.json');
  if (!existsSync(lttPath)) {
    throw new LttError('not_found', `no existing .ltt.json found in ${dir}`);
  }

  if (!Array.isArray(agents) || agents.length === 0) {
    throw new LttError('invalid', 'agents must be a non-empty array');
  }

  const seen = new Set();
  for (const a of agents) {
    if (!a || typeof a !== 'object') throw new LttError('invalid', 'agent entry must be an object');
    if (typeof a.agent !== 'string' || !NAME.test(a.agent) || a.agent.toLowerCase() === USER) {
      throw new LttError('invalid', `invalid agent name: "${a.agent}"`);
    }
    if (seen.has(a.agent.toLowerCase())) {
      throw new LttError('invalid', `duplicate agent name: "${a.agent}"`);
    }
    seen.add(a.agent.toLowerCase());
    if (a.role !== undefined && typeof a.role !== 'string') {
      throw new LttError('invalid', `role for ${a.agent} must be a string`);
    }
    if (a.owns !== undefined) {
      if (!Array.isArray(a.owns) || a.owns.some(item => typeof item !== 'string' || item.trim() === '')) {
        throw new LttError('invalid', `owns for ${a.agent} must be an array of strings`);
      }
    }
  }

  let existing;
  try {
    const raw = readFileSync(lttPath, 'utf8');
    existing = JSON.parse(raw);
  } catch (err) {
    throw new LttError('invalid', `failed to parse existing .ltt.json: ${err.message}`);
  }

  if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
    throw new LttError('invalid', 'invalid existing .ltt.json');
  }

  if (workspace && existing.workspace && existing.workspace !== workspace) {
    throw new LttError('invalid', `workspace mismatch: expected ${existing.workspace}, received ${workspace}`);
  }

  const isMulti = existing.agents && typeof existing.agents === 'object' && !Array.isArray(existing.agents);

  if (isMulti) {
    const newAgentsMap = {};
    for (const a of agents) {
      const prev = existing.agents[a.agent] && typeof existing.agents[a.agent] === 'object'
        ? existing.agents[a.agent]
        : {};
      newAgentsMap[a.agent] = {
        ...prev,
        role: typeof a.role === 'string' ? a.role : '',
        owns: Array.isArray(a.owns) ? a.owns : [],
      };
    }
    existing.agents = newAgentsMap;
  } else if (agents.length === 1 && existing.agent) {
    existing.agent = agents[0].agent;
    existing.role = typeof agents[0].role === 'string' ? agents[0].role : '';
    existing.owns = Array.isArray(agents[0].owns) ? agents[0].owns : [];
  } else {
    // Convert single to multi map, removing top-level agent/role/owns
    delete existing.agent;
    delete existing.role;
    delete existing.owns;
    const newAgentsMap = {};
    for (const a of agents) {
      newAgentsMap[a.agent] = {
        role: typeof a.role === 'string' ? a.role : '',
        owns: Array.isArray(a.owns) ? a.owns : [],
      };
    }
    existing.agents = newAgentsMap;
  }

  // Backup existing file
  const bakPath = `${lttPath}.bak`;
  try {
    copyFileSync(lttPath, bakPath);
  } catch (err) {
    throw new LttError('invalid', `failed to create backup .ltt.json.bak: ${err.message}`);
  }

  // Atomic write
  const tmpPath = `${lttPath}.tmp.${process.pid}.${Date.now()}`;
  try {
    writeFileSync(tmpPath, JSON.stringify(existing, null, 2) + '\n', 'utf8');
    renameSync(tmpPath, lttPath);
  } catch (err) {
    try { unlinkSync(tmpPath); } catch {}
    throw err;
  }

  return { ok: true, path: lttPath, count: agents.length };
}
