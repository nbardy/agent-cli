import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { parseModelString } from '../src/model-string.ts';

// A single table guards spelling across consumers, model-local efforts and colon-bearing IDs.
test('model strings use catalog-local effort recognition and explicit harnesses', () => {
  for (const [spec,expected] of [
    ['claude:opus-5-5:high',{t:'seat',provider:'claude',model:'claude-opus-5-5',effort:{t:'given',value:'high'}}],
    ['claude:sonnet:high',{t:'seat',provider:'claude',model:'claude-sonnet-5-5',effort:{t:'given',value:'high'}}],
    ['claude:claude-sonnet-5-5',{t:'seat',provider:'claude',model:'claude-sonnet-5-5',effort:{t:'defaulted',value:'medium'}}],
    ['codex:gpt-6.1-sol:ultra',{t:'seat',provider:'codex',model:'gpt-6.1-sol',effort:{t:'given',value:'ultra'}}],
    ['opencode:openrouter/vendor/model:free',{t:'seat',provider:'opencode',model:'openrouter/vendor/model:free',effort:{t:'none'}}],
    ['opencode:openrouter/vendor/model:high',{t:'seat',provider:'opencode',model:'openrouter/vendor/model:high',effort:{t:'none'}}],
    ['gemini:gemini-2.5-pro',{t:'seat',provider:'gemini',model:'gemini-2.5-pro',effort:{t:'none'}}],
  ] as const) assert.deepEqual(parseModelString(spec),expected,spec);
  for (const spec of ['gpt-6.1-sol','wat:model','codex:','buddy:some-id','claude:opus-9-9','codex:gpt-6-luna:ultra','claude:claude-sonnet-5-5:ultra','codex:gpt-6.1-sol:banana']) {
    assert.equal(parseModelString(spec).t,'invalid',spec);
  }
});
test('the parser catalog is generated from the canonical registry',()=>{
  execFileSync(process.execPath,['scripts/gen-model-catalog.mjs','--check'],{cwd:new URL('..',import.meta.url)});
});
