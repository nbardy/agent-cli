export function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function normalizeType(raw: string | undefined): string | undefined {
  return raw ? raw.replace(/-/g, '_').toLowerCase() : undefined;
}
