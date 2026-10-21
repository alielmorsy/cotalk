#!/usr/bin/env node
import { appendFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (process.env.FAKE_NPM_LOG) {
  appendFileSync(process.env.FAKE_NPM_LOG, JSON.stringify(args) + '\n');
}

if (args[0] === 'root' && args[1] === '-g') {
  console.log(process.env.FAKE_NPM_ROOT || process.cwd());
  process.exit(0);
}

if (args[0] === 'install' && args[1] === '-g') {
  if (process.env.FAKE_NPM_FAIL) {
    console.error('simulated npm install failure');
    process.exit(1);
  }
  process.exit(0);
}

process.exit(0);
