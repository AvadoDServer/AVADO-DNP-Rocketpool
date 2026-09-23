import { readFile } from "node:fs/promises";
import path from "node:path";

interface TokenEntry {
  token?: unknown;
  scope?: unknown;
}

/**
 * Reads the Smartnode API token at call time from <dataDir>/api-tokens.json
 * (format {"tokens":[{"token":"rpsn_…","comment":"…","scope":"write"}]}).
 * A write-scope token is preferred. Returns null when there is no usable token yet.
 * The token is never logged or returned to the browser.
 */
export async function readApiToken(dataDir: string): Promise<string | null> {
  let raw: string;
  try {
    raw = await readFile(path.join(dataDir, "api-tokens.json"), "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const tokens = (parsed as { tokens?: unknown })?.tokens;
  if (!Array.isArray(tokens)) return null;
  const valid = (tokens as TokenEntry[]).filter(
    (t): t is { token: string; scope?: unknown } =>
      typeof t?.token === "string" && /^rpsn_[0-9a-f]{64}$/i.test(t.token),
  );
  const write = valid.find((t) => t.scope === "write");
  return (write ?? valid[0])?.token ?? null;
}
