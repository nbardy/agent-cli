/**
 * Parent environment a stdio MCP server must inherit explicitly.
 *
 * Muse and Cursor start MCP servers with a scrubbed environment (Cursor:
 * exactly HOME, LOGNAME, PATH, SHELL, TERM, USER — measured 2026-09-24), so
 * anything the parent relies on must be written into the server entry or the
 * child silently runs against defaults. BUDDIES_HOME is the one that matters:
 * without it a Buddy MCP server opens the LIVE ~/.buddies store even when the
 * caller pointed the whole process tree at an isolated one.
 */
export function forwardedMcpEnv(): Record<string, string> {
  const buddiesHome = process.env.BUDDIES_HOME?.trim();
  return buddiesHome ? { BUDDIES_HOME: buddiesHome } : {};
}
