#!/usr/bin/env node
// Test double for `agy -p /usage` / `claude -p /usage`: echoes how it was started (args, cwd, COTALK_* env names).
// FAKE_USAGE_OUT: print this text instead. FAKE_USAGE_DELAY_MS: wait before printing.
// FAKE_USAGE_FAIL=1: exit 3 with a stderr line. FAKE_USAGE_HANG=1: never exit.
const print = () => console.log(process.env.FAKE_USAGE_OUT ?? JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), cotalk: Object.keys(process.env).filter(k => k.startsWith('COTALK_')) }));
if (process.env.FAKE_USAGE_HANG) setInterval(() => {}, 1000);
else if (process.env.FAKE_USAGE_FAIL) { console.error('boom\nsecond line'); process.exit(3); }
else setTimeout(print, Number(process.env.FAKE_USAGE_DELAY_MS) || 0);
