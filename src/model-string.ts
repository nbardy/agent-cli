import { MODEL_CATALOG } from './model-catalog.generated.ts';

export type ModelString = {
  t: 'seat';
  provider: string;
  model: string;
  effort: { t: 'given' | 'defaulted'; value: string } | { t: 'none' };
};
export type ModelStringError = {
  t: 'invalid';
  reason: 'harness' | 'model' | 'syntax';
  spec: string;
  why: string;
};

/** Oompa spelling, without its implicit Codex harness. Only a catalog-known suffix is effort.
 * A model may drop the harness name it repeats: `claude:opus-5-5` is `claude:claude-opus-5-5`
 * when the catalog has exactly that id. That is a spelling rule, not a guessed alias.
 * Pattern: parse-dont-validate (docs/patterns.md#parse-dont-validate)
 * Colon-bearing IDs stay intact; unknown closed-catalog models are errors, never guessed aliases.
 * Guard: test/model-string.test.ts (including model-specific effort and catalog freshness).
 */
export function parseModelString(spec: string): ModelString | ModelStringError {
  const invalid = (reason: ModelStringError['reason'], why: string): ModelStringError => ({
    t: 'invalid', reason, spec, why,
  });
  const colon = spec.indexOf(':');
  if (colon < 1 || colon === spec.length - 1 || spec.trim() !== spec)
    return invalid('syntax', 'Expected harness:model[:effort]; a harness is required.');
  const provider = spec.slice(0, colon);
  const rest = spec.slice(colon + 1);
  const catalog = MODEL_CATALOG.find(p => p.id === provider);
  if (!catalog) return invalid('harness', `Unknown harness "${provider}".`);
  const modelOf = (id: string) => {
    const named = Object.hasOwn(catalog.aliases, id)
      ? (catalog.aliases as Record<string, string>)[id]
      : id;
    return (
      catalog.models.find(m => m.id === named) ??
      catalog.models.find(m => m.id === `${provider}-${named}`)
    );
  };
  const last = rest.lastIndexOf(':');
  const prefix = last < 0 ? undefined : modelOf(rest.slice(0, last));
  const suffix = rest.slice(last + 1);
  const given = prefix?.reasoning?.levels.includes(suffix) === true;
  const modelId = given ? rest.slice(0, last) : rest;
  const model = given ? prefix : modelOf(modelId);
  if (!model && (!catalog.dynamic || !modelId.includes('/') || /\s/.test(modelId)))
    return invalid('model', `Unknown model "${modelId}" for ${provider}.`);
  return {
    t: 'seat', provider, model: model?.id ?? modelId,
    effort: given
      ? { t: 'given', value: suffix }
      : model?.reasoning
        ? { t: 'defaulted', value: model.reasoning.defaultEffort }
        : { t: 'none' },
  };
}
