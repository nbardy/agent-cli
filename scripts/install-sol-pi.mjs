#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

// A separate pinned runtime avoids replacing an owner's interactive Pi install.
const version = '1.1.0';
const revision = 'aed9f1362beb5ce3f4b87d79e7320329c6a39d75';
const root = resolve(process.argv[2] || join(homedir(), '.local/share/unleashd/sol-pi'));
const binDir = resolve(process.argv[3] || join(homedir(), '.local/bin'));
const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi/agent');
const configFile = join(agentDir, 'sol-pi.json');
const flags = ['actionFusion', 'observationPack', 'evidencePreservingReducer', 'onlineContextCompact'];
if (existsSync(configFile)) {
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  if (!flags.every(key => config[key] === true)) {
    throw new Error(`Existing ${configFile} does not enable all SoL-Pi mechanisms; reconcile it before installing. It was not changed.`);
  }
}
mkdirSync(root, { recursive: true });
const run = (command, args, options = {}) => execFileSync(command, args, { stdio: 'inherit', ...options });
run('npm', ['install', '--prefix', root, '--ignore-scripts', '--no-audit', '--no-fund', ...['pi-coding-agent', 'pi-agent-core', 'pi-ai', 'pi-tui', 'pi-telemetry', 'pi-mcp', 'pi-codemode', 'chord'].map(name => `@earendil-works/${name}@${version}`)]);
run('npm', ['audit', '--prefix', root, '--omit=dev', '--audit-level=high']);
const source = join(root, 'SoL-Pi');
if (!existsSync(source)) run('git', ['clone', '--branch', 'pi-1.1.0-compat', 'https://github.com/xiaofuce/SoL-Pi.git', source]);
const head = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (head !== revision) throw new Error(`SoL-Pi checkout ${head} differs from pinned ${revision}; no checkout was overwritten.`);
// Runtime source imports Pi's public APIs via the native loader; avoid npm
// auto-installing a second/latest Pi from SoL-Pi's wildcard peer dependencies.
const cli = join(root, 'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js');
run(process.execPath, [cli, '--version'], { env: { ...process.env, PI_CODING_AGENT_DIR: agentDir } });
mkdirSync(agentDir, { recursive: true, mode: 0o700 });
if (!existsSync(configFile)) writeFileSync(configFile, JSON.stringify({ version: 1, ...Object.fromEntries(flags.map(key => [key, true])), cacheWriteReadRatio: 12.5 }, null, 2) + '\n', { mode: 0o600 });
run(process.execPath, [join(source, 'scripts/check-sol-pi-config.mjs'), '--config', configFile, '--require-all-enabled']);
mkdirSync(binDir, { recursive: true });
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
writeFileSync(join(binDir, 'sol-pi'), `#!/bin/sh\nexport UNLEASHD_SOL_PI_EXTENSION=${quote(join(source, 'src/sol-pi/index.ts'))}\nexec ${quote(process.execPath)} ${quote(cli)} --extension ${quote(join(source, 'src/sol-pi/index.ts'))} "$@"\n`, { mode: 0o755 });
console.log(`Installed sol-pi (${version}, ${revision}) in ${binDir}. Add it to PATH, then run sol-pi /login to configure model access.`);
