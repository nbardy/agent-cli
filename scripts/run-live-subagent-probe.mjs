#!/usr/bin/env node

import { spawnSync } from 'node:child_process';

const env = {
  ...process.env,
  AGENT_CLI_LIVE_SUBAGENTS: '1',
};

const testRun = spawnSync(
  process.execPath,
  ['--experimental-strip-types', '--test', 'test/live-subagents.test.ts'],
  {
    stdio: 'inherit',
    env,
  }
);

process.exit(testRun.status ?? 1);
