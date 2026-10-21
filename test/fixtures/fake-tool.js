#!/usr/bin/env node
import { appendFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (process.env.FAKE_TOOL_LOG) {
  appendFileSync(process.env.FAKE_TOOL_LOG, JSON.stringify(args) + '\n');
}

if (args.includes('--version')) {
  console.log('1.0.0');
  process.exit(0);
}

if (args[0] === 'plugin') {
  if (args[1] === 'list') {
    console.log(process.env.FAKE_TOOL_PLUGINS || 'Installed plugins:\n  ❯ cotalk@cotalk\n');
    process.exit(0);
  }
  if (args[1] === 'marketplace' || args[1] === 'install') {
    if (process.env.FAKE_TOOL_FAIL) {
      console.error('simulated plugin failure');
      process.exit(1);
    }
    process.exit(0);
  }
}

if (args[0] === 'mcp') {
  if (args[1] === 'list') {
    console.log(process.env.FAKE_MCP_LIST ?? 'cotalk  http  enabled  http://127.0.0.1:7878/mcp');
    process.exit(0);
  }
  if (args[1] === 'add') {
    if (process.env.FAKE_TOOL_FAIL) {
      console.error('simulated mcp failure');
      process.exit(1);
    }
    process.exit(0);
  }
}

process.exit(0);
