import assert from 'node:assert/strict';
import test from 'node:test';

import { buildModeExtraArgs } from '../src/mode-args.ts';

/**
 * Codex's own `--search` is parsed BEFORE the subcommand: `codex --search exec`
 * works, `codex exec --search` is rejected with "unexpected argument". Since
 * agent-cli appends caller extraArgs after `exec`, --search is unreachable that
 * way, and the equivalent is the config override `-c tools.web_search=true`.
 *
 * `tools.web_search` is a real key, not a guess: `codex exec --strict-config -c
 * tools.web_search=true` is accepted, while a bogus key under the same flag is
 * rejected with "unknown configuration field". That control matters, because
 * codex silently ignores unknown -c keys without --strict-config -- so a typo
 * here would look exactly like working web search.
 */

test('codex web search is off unless asked for', () => {
  const args = buildModeExtraArgs('codex', 'conversation', true, '/tmp', false, false);
  assert.ok(!args.includes('tools.web_search=true'));
});

test('codex web search rides a config override, never a bare --search', () => {
  const args = buildModeExtraArgs('codex', 'conversation', true, '/tmp', false, true);
  assert.deepEqual([...args], ['-c', 'tools.web_search=true', '--json']);
  assert.ok(!args.includes('--search'), '--search after `exec` is rejected by codex');
});

test('web search composes with the narrow sandbox', () => {
  const args = buildModeExtraArgs('codex', 'conversation', false, '/tmp', true, true);
  assert.deepEqual([...args], ['-s', 'workspace-write', '-c', 'tools.web_search=true', '--json']);
});

test('single-shot mode carries it too', () => {
  const args = buildModeExtraArgs('codex', 'single-shot', false, '/tmp', true, true);
  assert.deepEqual([...args], ['-s', 'workspace-write', '-c', 'tools.web_search=true']);
});

test('other harnesses are unaffected by the codex flag', () => {
  for (const harness of ['claude', 'muse', 'gemini', 'opencode'] as const) {
    const args = buildModeExtraArgs(harness, 'conversation', true, '/tmp', false, true);
    assert.ok(!args.includes('tools.web_search=true'), `${harness} must not get codex config`);
  }
});
