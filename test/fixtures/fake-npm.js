#!/usr/bin/env node
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
if (process.env.FAKE_NPM_LOG) {
  appendFileSync(process.env.FAKE_NPM_LOG, JSON.stringify(args) + '\n');
}

if (args[0] === 'root' && args[1] === '-g') {
  console.log(process.env.FAKE_NPM_ROOT || process.cwd());
  process.exit(0);
}

if (args[0] === 'view') {
  console.log(process.env.FAKE_NPM_LATEST || '0.0.0');
  process.exit(0);
}

if (args[0] === 'install' && args[1] === '-g') {
  if (process.env.FAKE_NPM_FAIL) {
    console.error('simulated npm install failure');
    process.exit(1);
  }
  // like a real install: <root>/<name>/package.json now has the requested version
  const spec = args.at(-1), at = spec.lastIndexOf('@');
  if (process.env.FAKE_NPM_ROOT && at > 0 && !process.env.FAKE_NPM_NOOP) {
    const dir = join(process.env.FAKE_NPM_ROOT, spec.slice(0, at));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: spec.slice(at + 1) }));
  }
  process.exit(0);
}

process.exit(0);
