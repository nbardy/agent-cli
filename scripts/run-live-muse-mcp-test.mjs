#!/usr/bin/env node

import { spawnSync } from 'node:child_process';

// The build config excludes test/, so compile nothing: typecheck (covers
// src + test via tsconfig.json) then run the live test from source with
// strip-types, like the default test script does.
const env = {
  ...process.env,
  AGENT_CLI_LIVE_MUSE_MCP: '1',
};

const tsc = spawnSync('npx', ['tsc'], {
  stdio: 'inherit',
  env,
});

if ((tsc.status ?? 1) !== 0) {
  process.exit(tsc.status ?? 1);
}

const testRun = spawnSync(
  process.execPath,
  ['--experimental-strip-types', '--test', 'test/live-muse-mcp.test.ts'],
  {
    stdio: 'inherit',
    env,
  }
);

process.exit(testRun.status ?? 1);
