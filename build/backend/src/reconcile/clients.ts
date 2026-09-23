/**
 * The AVADO consensus-client packages that run a validator client on mainnet, and how the
 * backend reaches their keymanager API. Every package already serves the standard
 * keymanager API under `:9999/keymanager/` and adds its own bearer token server side
 * (~/Documents/AVADO-reports/nimbus.md §3, lighthouse.md §2, teku-prysm-beacon.md §1, §2.4):
 *
 *  - Nimbus and Lighthouse: the Deno server.ts on 9999 → the client's keymanager
 *  - Teku: the monitor on 9999 → https://teku.my.ava.do:5052
 *  - Prysm: the validator package (eth2validator)'s monitor on 9999 → the Prysm
 *    validator client on :7500. The prysm-beacon-chain package holds no keys.
 *
 * The hostnames are the DAppNode aliases of the mainnet packages (dependents.md). Only
 * mainnet is supported.
 */
import { WampError, type WampCaller } from "./wamp";

export type ClientId = "nimbus" | "teku" | "lighthouse" | "prysm";

export interface ClientInfo {
  id: ClientId;
  /** Name for the UI. */
  name: string;
  /** The package that holds the validator keys. */
  packageName: string;
  /** Keymanager base URL; the standard paths (/eth/v1/keystores, …) are appended. */
  keymanagerUrl: string;
}

export const CLIENTS: readonly ClientInfo[] = Object.freeze([
  { id: "nimbus", name: "Nimbus", packageName: "nimbus.avado.dnp.dappnode.eth", keymanagerUrl: "http://nimbus.my.ava.do:9999/keymanager" },
  { id: "teku", name: "Teku", packageName: "teku.avado.dnp.dappnode.eth", keymanagerUrl: "http://teku.my.ava.do:9999/keymanager" },
  { id: "lighthouse", name: "Lighthouse", packageName: "lighthouse.avado.dnp.dappnode.eth", keymanagerUrl: "http://lighthouse.my.ava.do:9999/keymanager" },
  { id: "prysm", name: "Prysm", packageName: "eth2validator.avado.dnp.dappnode.eth", keymanagerUrl: "http://eth2validator.my.ava.do:9999/keymanager" },
] as ClientInfo[]);

/** Packages whose names look like a consensus client but hold no validator keys. */
const KNOWN_KEYLESS = new Set(["prysm-beacon-chain-mainnet.avado.dnp.dappnode.eth"]);

/** Testnet variants cannot sign for mainnet validators. */
const TESTNET_RE = /-(holesky|prater|goerli|gnosis|hoodi|sepolia|testnet)\b/;
/** Anything that may run a validator client of its own (Obol/Charon bundles Nimbus/Teku VCs). */
const VALIDATOR_LIKE_RE = /teku|nimbus|lighthouse|prysm|lodestar|grandine|eth2validator|web3signer|vouch|obol|charon|stader|ssv/;

/**
 * The first Teku package version whose monitor no longer logs the full keymanager request
 * on an error (AVADO-DNP-Teku build/monitor/server.ts logged `error.config`, i.e. the
 * keystore and its password). Must match the Teku release carrying that log fix. Keys are
 * never imported automatically into an older (or unknown-version) Teku.
 */
export const TEKU_SAFE_IMPORT_VERSION = "0.0.76";

function parseVersion(v: string | null | undefined): number[] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec((v ?? "").trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** a >= b for x.y.z versions; false when either is not x.y.z (e.g. an IPFS hash install). */
export function versionAtLeast(a: string | null | undefined, b: string): boolean {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! > y[i]!;
  return true;
}

/** Whether keys may be imported automatically into this client package version. */
export function importAllowed(client: ClientInfo, version: string | null | undefined): { allowed: boolean; reason?: string } {
  if (client.id !== "teku" || versionAtLeast(version, TEKU_SAFE_IMPORT_VERSION)) return { allowed: true };
  return {
    allowed: false,
    reason: `Update Teku before loading keys: the installed Teku package (${version ?? "unknown version"}) is older than ${TEKU_SAFE_IMPORT_VERSION}, which can write a failed key import, password included, to its log.`,
  };
}

export const DAPPMANAGER_LIST_PACKAGES = "listPackages.dappmanager.dnp.dappnode.eth";

export interface InstalledPackage {
  name: string;
  running: boolean;
  /** Package version as the DAPPMANAGER reports it (image tag), or null. */
  version?: string | null;
}

/**
 * DAPPMANAGER listPackages over WAMP. Each procedure returns a JSON string holding
 * `{success, message, result}`; `result` is used only when `success === true`.
 * One entry per container: a package counts as running if any of its containers runs.
 * Throws on any failure: a failed list never means "nothing installed".
 */
export async function listInstalledPackages(wamp: WampCaller, timeoutMs = 60_000): Promise<InstalledPackage[]> {
  const raw = await wamp.call(DAPPMANAGER_LIST_PACKAGES, undefined, undefined, timeoutMs);
  let env: unknown = raw;
  if (typeof raw === "string") {
    try {
      env = JSON.parse(raw);
    } catch {
      throw new WampError("listPackages: the reply is not JSON", "rejected");
    }
  }
  const { success, message, result } = (env ?? {}) as { success?: unknown; message?: unknown; result?: unknown };
  if (success !== true) {
    throw new WampError(`listPackages failed${typeof message === "string" ? `: ${message}` : ""}`, "rejected");
  }
  if (!Array.isArray(result)) throw new WampError("listPackages: the result is not a list", "rejected");
  const byName = new Map<string, InstalledPackage>();
  for (const p of result as Array<{ name?: unknown; running?: unknown; version?: unknown }>) {
    if (typeof p?.name !== "string") continue;
    const prev = byName.get(p.name);
    byName.set(p.name, {
      name: p.name,
      running: (prev?.running ?? false) || p.running === true,
      version: prev?.version ?? (typeof p.version === "string" && p.version ? p.version : null),
    });
  }
  return [...byName.values()];
}

export interface ClientSelection {
  /** The client Rocket Pool keys go into, or null. */
  chosen: ClientInfo | null;
  /** Every installed known client, the chosen one included. */
  installed: ClientInfo[];
  /** Installed packages that look like a validator client we do not know (mainnet only). */
  unknownValidatorPackages: string[];
  /** How the client was chosen: the CONSENSUSCLIENT setting, or the only installed client. */
  source: "setting" | "only-installed" | "none";
  /** Plain-language explanation of the choice (or of why there is none). */
  why: string;
  /** Why there is no chosen client. */
  reason?: string;
}

export function parseClientId(value: string | undefined): ClientId | null {
  const v = (value ?? "").trim().toLowerCase();
  return CLIENTS.some((c) => c.id === v) ? (v as ClientId) : null;
}

/**
 * Picks the client for Rocket Pool keys:
 *  - the package's CONSENSUSCLIENT setting, if that client is installed
 *  - if CONSENSUSCLIENT names a client that is not installed: none (never a different one)
 *  - if CONSENSUSCLIENT is missing or unknown: the only installed client, if exactly one
 */
export function selectClient(packages: InstalledPackage[], configured: string | undefined): ClientSelection {
  const names = new Set(packages.map((p) => p.name));
  const installed = CLIENTS.filter((c) => names.has(c.packageName));
  const known = new Set(CLIENTS.map((c) => c.packageName));
  const unknownValidatorPackages = packages
    .map((p) => p.name)
    .filter((n) => !known.has(n) && !KNOWN_KEYLESS.has(n) && VALIDATOR_LIKE_RE.test(n) && !TESTNET_RE.test(n))
    .sort();

  const configuredId = parseClientId(configured);
  if (configuredId) {
    const chosen = installed.find((c) => c.id === configuredId) ?? null;
    const info = CLIENTS.find((c) => c.id === configuredId)!;
    if (chosen) {
      return {
        chosen,
        installed,
        unknownValidatorPackages,
        source: "setting",
        why: `The Rocket Pool package setting CONSENSUSCLIENT is "${configuredId}".`,
      };
    }
    const reason = `Rocket Pool is set to use ${info.name} (CONSENSUSCLIENT=${configuredId}), but the ${info.name} package (${info.packageName}) is not installed.`;
    return { chosen: null, installed, unknownValidatorPackages, source: "none", why: reason, reason };
  }
  const unset = configured?.trim() ? `CONSENSUSCLIENT "${configured.trim()}" is not a known client` : "CONSENSUSCLIENT is not set";
  if (installed.length === 1) {
    return {
      chosen: installed[0],
      installed,
      unknownValidatorPackages,
      source: "only-installed",
      why: `${unset}; ${installed[0].name} is the only installed consensus client.`,
    };
  }
  const reason =
    installed.length === 0
      ? "No consensus client with a validator (Nimbus, Teku, Lighthouse or Prysm) is installed."
      : `Several consensus clients are installed (${installed.map((c) => c.name).join(", ")}) and ${unset}.`;
  return {
    chosen: null,
    installed,
    unknownValidatorPackages,
    source: "none",
    why: reason,
    reason,
  };
}
