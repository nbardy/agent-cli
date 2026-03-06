#!/usr/bin/env node

import { spawnSync } from 'node:child_process';

const env = {
  ...process.env,
  AGENT_CLI_LIVE_GEMINI: '1',
};

const tsc = spawnSync('npx', ['tsc'], {
  stdio: 'inherit',
  env,
});

if ((tsc.status ?? 1) !== 0) {
  process.exit(tsc.status ?? 1);
}

const testRun = spawnSync(process.execPath, ['--test', 'dist/test/live-gemini.test.js'], {
  stdio: 'inherit',
  env,
});

process.exit(testRun.status ?? 1);
