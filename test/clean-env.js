// Preloaded by `npm test`: identity env from an `cotalk run` / `cotalk worker` shell must not leak into tests.
for (const k of ['COTALK_AGENT', 'COTALK_ROLE', 'COTALK_OWNS', 'COTALK_WORKER', 'COTALK_WORKER_DETACHED', 'COTALK_TOOL', 'CLAUDECODE']) delete process.env[k];
