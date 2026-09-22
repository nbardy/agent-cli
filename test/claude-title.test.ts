import assert from 'node:assert/strict';
import test from 'node:test';

import { createClaudeParser } from '../src/parsers/claude.ts';

/**
 * Claude records provider-generated conversation labels as ai-title
 * (auto, re-emitted per turn) and custom-title (user-set via /rename or
 * --name) lines. Shapes captured from ~/.claude/projects/<slug>/*.jsonl.
 * Before this, the parser dropped them (`return []`), so the sidebar could
 * only derive labels from the first user message — including the raw
 * `<!-- unleashd:buddy-context-v2 -->` envelope on buddy-spawned turns.
 */

test('claude ai-title line becomes a session.title event', () => {
  const events = createClaudeParser()({
    type: 'ai-title',
    aiTitle: 'Channels and task overlap',
  });
  assert.deepEqual(events, [
    { type: 'session.title', title: 'Channels and task overlap', source: 'ai' },
  ]);
});

test('claude custom-title line becomes a session.title event', () => {
  const events = createClaudeParser()({
    type: 'custom-title',
    customTitle: 'My demo thread',
  });
  assert.deepEqual(events, [
    { type: 'session.title', title: 'My demo thread', source: 'custom' },
  ]);
});

test('blank titles emit nothing rather than an empty label', () => {
  const parser = createClaudeParser();
  assert.deepEqual(parser({ type: 'ai-title', aiTitle: '   ' }), []);
  assert.deepEqual(parser({ type: 'custom-title', customTitle: '' }), []);
  assert.deepEqual(parser({ type: 'ai-title' }), []);
});
