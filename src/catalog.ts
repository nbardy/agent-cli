import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Shared provider/model registry loader.
 *
 * Single source of truth: `catalog.jsonc` at repo root.
 * Both agent-cli-tool and unleashd (via vendor/agent-cli-tool/catalog.jsonc) load this file.
 * Harness argv logic (harnesses/*) stays separate — this file only owns *what* models exist.
 */

function stripJsonc(text: string): string {
  return text.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

export interface CatalogReasoning {
  levels: string[];
  defaultEffort?: string;
}

export interface CatalogModel {
  id: string;
  displayName: string;
  isDefault: boolean;
  reasoning?: CatalogReasoning;
}

export interface CatalogProvider {
  id: string;
  displayName: string;
  shortName: string;
  defaultModelId: string;
  supportsDynamicModels: boolean;
  models: CatalogModel[];
}

export interface Catalog {
  revision: string;
  providers: CatalogProvider[];
}

// stripJsonc is imported from shared/src/utils/jsonc.ts — see comment above.

function findCatalogPath(): string {
  const candidates: string[] = [];

  // CJS: __dirname -> .../src or .../dist
  try {
    // @ts-ignore - __dirname exists in CJS builds
    if (typeof __dirname !== 'undefined') {
      const dir = __dirname as string;
      candidates.push(join(dir, '../catalog.jsonc'));
      candidates.push(join(dir, '../../catalog.jsonc'));
      candidates.push(join(dir, 'catalog.jsonc'));
      candidates.push(join(dir, '../src/catalog.jsonc'));
    }
  } catch {
    // ignore
  }

  // cwd fallbacks (when running via tsx from repo root)
  candidates.push(join(process.cwd(), 'catalog.jsonc'));
  candidates.push(join(process.cwd(), 'vendor/agent-cli-tool/catalog.jsonc'));
  candidates.push(join(process.cwd(), '../agent-cli-tool/catalog.jsonc'));

  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  throw new Error(`catalog.jsonc not found. Tried:\n${candidates.join('\n')}`);
}

let cached: Catalog | null = null;

export function loadCatalog(): Catalog {
  if (cached) return cached;
  const path = findCatalogPath();
  const raw = readFileSync(path, 'utf-8');
  const json = stripJsonc(raw);
  const parsed = JSON.parse(json) as Catalog;
  // Minimal validation: ensure revision and providers exist
  if (!parsed.revision || !Array.isArray(parsed.providers)) {
    throw new Error(`Invalid catalog at ${path}: missing revision/providers`);
  }
  cached = parsed;
  return cached;
}

export function getProvider(providerId: string): CatalogProvider | undefined {
  return loadCatalog().providers.find((p) => p.id === providerId);
}

export function listModels(providerId: string): CatalogModel[] {
  return getProvider(providerId)?.models ?? [];
}

export function isModelInCatalog(providerId: string, modelId: string): boolean {
  return listModels(providerId).some((m) => m.id === modelId);
}
