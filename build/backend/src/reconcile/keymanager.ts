/**
 * Standard Ethereum keymanager API through an AVADO package's `:9999/keymanager` proxy.
 *
 * Proxy quirks (AVADO-Client-UI src/api/http.ts, keymanager.ts):
 *  - Every non-GET request carries a JSON body: the Deno proxy (Nimbus, Lighthouse)
 *    JSON-parses the body of every non-GET request and fails a bodiless one.
 *  - Query strings are dropped by the proxies, so none are used.
 *  - Prysm reports statuses in upper case; they are compared in lower case.
 *  - The Prysm monitor answers every upstream error with 500 "failed".
 *
 * Keystores and passwords are sent in the request body only; they are never logged or
 * kept in an error message.
 */
import { normalizeAddress, normalizePubkey, prefixed } from "./hex";

export type FetchLike = typeof fetch;

export class KeymanagerError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface ImportResult {
  status: "imported" | "duplicate" | "error" | string;
  message?: string;
}

export interface Keymanager {
  /** Pubkeys of the local keystores loaded in the validator client. */
  listKeystores(): Promise<Set<string>>;
  /** Pubkeys of remote (web3signer) keys. */
  listRemoteKeys(): Promise<Set<string>>;
  importKeystore(keystoreJson: string, password: string): Promise<ImportResult>;
  /** The key's fee recipient, or null when the client has none for it (404). */
  getFeeRecipient(pubkey: string): Promise<string | null>;
  setFeeRecipient(pubkey: string, address: string): Promise<void>;
}

export interface KeymanagerOptions {
  baseUrl: string;
  fetch?: FetchLike;
  timeoutMs?: number;
  /** Importing an scrypt keystore takes a few seconds. */
  importTimeoutMs?: number;
}

const MAX_DETAIL = 200;

function detailOf(text: string): string {
  let d = text.trim();
  try {
    const j = JSON.parse(text) as { message?: unknown; error?: unknown };
    if (typeof j?.message === "string") d = j.message;
    else if (typeof j?.error === "string") d = j.error;
  } catch {
    /* plain text */
  }
  return d.slice(0, MAX_DETAIL);
}

export function createKeymanager(opts: KeymanagerOptions): Keymanager {
  const base = opts.baseUrl.replace(/\/+$/, "");
  const doFetch: FetchLike = opts.fetch ?? ((...a) => globalThis.fetch(...a));
  const timeoutMs = opts.timeoutMs ?? 20_000;

  async function request(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    ro: { timeoutMs?: number; accept404?: boolean } = {},
  ): Promise<{ status: number; data: unknown }> {
    const headers: Record<string, string> = { Accept: "application/json" };
    let payload: string | undefined;
    if (method !== "GET") {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body ?? {});
    }
    const signal = AbortSignal.timeout(ro.timeoutMs ?? timeoutMs);
    let res: Response;
    let text: string;
    try {
      res = await doFetch(`${base}${path}`, { method, headers, body: payload, signal, redirect: "error" });
      text = await res.text();
    } catch {
      throw new KeymanagerError(signal.aborted ? "no answer in time" : "not reachable");
    }
    if (ro.accept404 && res.status === 404) return { status: 404, data: undefined };
    if (!res.ok) throw new KeymanagerError(`HTTP ${res.status}${text ? `: ${detailOf(text)}` : ""}`, res.status);
    let data: unknown;
    try {
      data = text === "" ? undefined : JSON.parse(text);
    } catch {
      throw new KeymanagerError("the answer is not JSON", res.status);
    }
    return { status: res.status, data };
  }

  const dataOf = (body: unknown): unknown =>
    typeof body === "object" && body !== null && "data" in body ? (body as { data: unknown }).data : undefined;

  async function listPubkeys(path: string): Promise<Set<string>> {
    const { data } = await request("GET", path);
    const list = dataOf(data);
    if (!Array.isArray(list)) throw new KeymanagerError("the key list has no data array");
    const out = new Set<string>();
    for (const k of list) {
      const pk = normalizePubkey((k as { validating_pubkey?: unknown; pubkey?: unknown })?.validating_pubkey ?? (k as { pubkey?: unknown })?.pubkey);
      if (pk) out.add(pk);
    }
    return out;
  }

  const feePath = (pubkey: string) => `/eth/v1/validator/${prefixed(pubkey)}/feerecipient`;

  return {
    listKeystores: () => listPubkeys("/eth/v1/keystores"),
    listRemoteKeys: () => listPubkeys("/eth/v1/remotekeys"),

    async importKeystore(keystoreJson, password) {
      const { data } = await request(
        "POST",
        "/eth/v1/keystores",
        { keystores: [keystoreJson], passwords: [password] },
        { timeoutMs: opts.importTimeoutMs ?? 120_000 },
      );
      const list = dataOf(data);
      if (!Array.isArray(list) || list.length !== 1) throw new KeymanagerError("the import answer has no result for the key");
      const r = (list[0] ?? {}) as { status?: unknown; message?: unknown };
      return {
        status: typeof r.status === "string" ? r.status.toLowerCase() : "unknown",
        message: typeof r.message === "string" ? r.message.slice(0, MAX_DETAIL) : undefined,
      };
    },

    async getFeeRecipient(pubkey) {
      const { status, data } = await request("GET", feePath(pubkey), undefined, { accept404: true });
      if (status === 404) return null;
      const d = dataOf(data) as { ethaddress?: unknown } | undefined;
      if (d?.ethaddress === undefined) throw new KeymanagerError("the fee recipient answer has no ethaddress");
      return normalizeAddress(d.ethaddress);
    },

    async setFeeRecipient(pubkey, address) {
      await request("POST", feePath(pubkey), { ethaddress: address });
    },
  };
}
