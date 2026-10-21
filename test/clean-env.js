// Preloaded by `npm test`: identity env from an `ltt run` / `ltt worker` shell must not leak into tests.
for (const k of ['LTT_AGENT', 'LTT_ROLE', 'LTT_OWNS', 'LTT_WORKER', 'LTT_WORKER_DETACHED', 'LTT_TOOL', 'CLAUDECODE']) delete process.env[k];
