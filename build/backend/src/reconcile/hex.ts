/** Pubkey and address helpers. Everything is compared in one canonical form: lower case, no 0x. */

const PUBKEY_RE = /^[0-9a-f]{96}$/;
const ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const ZERO_ADDRESS = "0x" + "0".repeat(40);

/** A BLS pubkey as 96 lower-case hex characters without 0x, or null when it is not one. */
export function normalizePubkey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let v = value.trim().toLowerCase();
  if (v.startsWith("0x")) v = v.slice(2);
  return PUBKEY_RE.test(v) ? v : null;
}

/** The pubkey as the keymanager API and the keystore file names write it (0x prefix). */
export function prefixed(pubkey: string): string {
  return "0x" + pubkey;
}

/** A non-zero Ethereum address in lower case with 0x, or null. */
export function normalizeAddress(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  if (!ADDRESS_RE.test(v) || v === ZERO_ADDRESS) return null;
  return v;
}

/** Short form for messages: 0x1234…abcd. */
export function shortKey(pubkey: string): string {
  return `0x${pubkey.slice(0, 8)}…${pubkey.slice(-4)}`;
}
