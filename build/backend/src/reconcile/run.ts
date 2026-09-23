/**
 * One reconciliation pass (spec §4.3, §2.5):
 *
 *  1. Smartnode: wallet initialised and not masquerading, node registered — otherwise
 *     "waiting" and nothing else is touched (no DAPPMANAGER or keymanager call).
 *  2. The node's Rocket Pool keys (node/status minipools, megapool/status validators) and
 *     each key's fee recipient (rules.ts).
 *  3. The installed consensus clients (DAPPMANAGER listPackages) and the chosen one.
 *  4. Import each Rocket Pool key that is missing in the chosen client, only when
 *      - the key is on the "approved to load" list (approved.ts): created by this node
 *        through the backend, or confirmed by the owner. Other missing keys are listed in
 *        `awaitingApproval`; the owner may have moved those validators to another machine
 *        on purpose, and loading them here too would get them slashed.
 *      - the key is not loaded in ANY installed AVADO consensus client. If any installed
 *        client's key list cannot be read, or an unknown validator package is installed,
 *        nothing is imported.
 *  5. Set the fee recipient of each Rocket Pool key loaded in the chosen client (approved
 *     or not: a loaded key is never removed and always gets the right fee recipient).
 *
 * Never deletes a key, never touches a key that is not a Rocket Pool key of this node,
 * never throws: every failure ends up in the returned status.
 */
import type { ApprovedRead } from "./approved";
import type { ClientId, ClientInfo, InstalledPackage } from "./clients";
import { selectClient } from "./clients";
import { shortKey } from "./hex";
import type { Keymanager } from "./keymanager";
import type { KeystoreProblem, LoadedKeystore } from "./keystores";
import { feeRecipientFor, parseFeeRecipientInfo, wantedKeys, type FeeRecipientRule, type KeyKind } from "./rules";

export const STATUS_VERSION = 1;

/** Import attempts per key before the loop stops retrying it on its own (a run request resets them). */
export const MAX_IMPORT_ATTEMPTS = 3;
/** Imports per run; the rest follow in the next run. */
export const MAX_IMPORTS_PER_RUN = 20;

export type ReconcileState = "ok" | "waiting" | "attention" | "error";

export type KeyState =
  | "loaded" // in the chosen client
  | "imported" // imported in this run
  | "elsewhere" // loaded in another consensus client: not imported
  | "awaiting-approval" // missing, and not approved to load: the owner decides
  | "import-blocked" // not imported because not every client could be checked
  | "missing-keystore" // no keystore in the data dir
  | "import-failed"
  | "retry-limit" // import failed MAX_IMPORT_ATTEMPTS times; waits for a run request
  | "deferred" // over MAX_IMPORTS_PER_RUN; next run
  | "no-client"; // no chosen client

export type FeeState = "ok" | "fixed" | "failed" | "no-address" | "not-loaded";

export interface KeyStatus {
  pubkey: string;
  kind: KeyKind;
  ref: string;
  state: KeyState;
  /** For "elsewhere": the package the key is loaded in. */
  loadedIn?: string;
  feeRecipient: {
    rule: FeeRecipientRule;
    expected: string | null;
    /** What the client had before this run (null: none set for the key). */
    found?: string | null;
    state: FeeState;
  };
  error?: string;
}

export interface ReconcileStatus {
  version: number;
  state: ReconcileState;
  /** One plain-language line for the UI. */
  message: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  trigger: "startup" | "timer" | "request";
  nextRunAt?: string;
  client: { id: ClientId; name: string; package: string } | null;
  /** CONSENSUSCLIENT as set in the package. */
  configuredClient: string | null;
  /** How the client was chosen, in plain language. */
  clientChoice: { source: "setting" | "only-installed" | "none"; why: string } | null;
  /** Rocket Pool keys missing in the client that wait for the owner's approval (96 hex, no 0x). */
  awaitingApproval: string[];
  /** Other installed clients whose key lists were checked. */
  otherClients: Array<{ id: ClientId; name: string; package: string; checked: boolean; error?: string }>;
  unknownValidatorPackages: string[];
  keys: {
    total: number;
    /** Loaded in the chosen client after this run. */
    inSync: number;
    imported: number;
    /** e.g. "3/3" */
    summary: string;
  };
  feeRecipients: { total: number; ok: number; fixed: number; failed: number };
  fee: {
    isInSmoothingPool: boolean;
    isInOptOutCooldown: boolean;
    smoothingPoolAddress: string | null;
    feeDistributorAddress: string | null;
    megapoolAddress: string | null;
  } | null;
  validators: KeyStatus[];
  errors: string[];
}

export interface SmartnodeReader {
  /** GET a Smartnode route. Resolves to the parsed body; throws with a readable message. */
  get(route: string, query?: Record<string, string>): Promise<unknown>;
}

export interface RunDeps {
  smartnode: SmartnodeReader;
  listPackages(): Promise<InstalledPackage[]>;
  keymanagerFor(client: ClientInfo): Keymanager;
  loadKeystore(pubkey: string, client: ClientId): Promise<LoadedKeystore | KeystoreProblem>;
  /** The "approved to load" list, read on every run. */
  readApproved(): Promise<ApprovedRead>;
  /** CONSENSUSCLIENT from the package settings. */
  configuredClient: string | undefined;
  /** Failed import attempts per pubkey, kept by the loop between runs. */
  importAttempts: Map<string, number>;
  trigger: ReconcileStatus["trigger"];
  now?: () => Date;
  log?: (level: "info" | "warn" | "error", msg: string) => void;
}

const msgOf = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);
const obj = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

export async function runReconcile(deps: RunDeps): Promise<ReconcileStatus> {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => {});
  const started = now();
  const status: ReconcileStatus = {
    version: STATUS_VERSION,
    state: "ok",
    message: "",
    startedAt: started.toISOString(),
    finishedAt: "",
    durationMs: 0,
    trigger: deps.trigger,
    client: null,
    configuredClient: deps.configuredClient?.trim() || null,
    clientChoice: null,
    awaitingApproval: [],
    otherClients: [],
    unknownValidatorPackages: [],
    keys: { total: 0, inSync: 0, imported: 0, summary: "0/0" },
    feeRecipients: { total: 0, ok: 0, fixed: 0, failed: 0 },
    fee: null,
    validators: [],
    errors: [],
  };
  const finish = (state: ReconcileState, message: string): ReconcileStatus => {
    status.state = state;
    status.message = message;
    const end = now();
    status.finishedAt = end.toISOString();
    status.durationMs = end.getTime() - started.getTime();
    return status;
  };

  try {
    return await reconcile(deps, status, finish, log);
  } catch (e) {
    // Defensive: reconcile() handles its own failures; this is for the unexpected.
    status.errors.push(`Unexpected error: ${msgOf(e)}`);
    return finish("error", "The key check stopped with an unexpected error.");
  }
}

async function reconcile(
  deps: RunDeps,
  status: ReconcileStatus,
  finish: (state: ReconcileState, message: string) => ReconcileStatus,
  log: NonNullable<RunDeps["log"]>,
): Promise<ReconcileStatus> {
  // 1. Smartnode: wallet and registration
  let wallet: Record<string, unknown>;
  try {
    wallet = obj(await deps.smartnode.get("wallet/status"));
  } catch (e) {
    status.errors.push(msgOf(e));
    return finish("waiting", "Waiting for the Rocket Pool daemon.");
  }
  if (wallet.walletInitialized !== true) return finish("waiting", "No Rocket Pool wallet yet.");
  if (wallet.isMasquerading === true) return finish("waiting", "The wallet is in masquerade (read-only) mode; keys are not managed.");

  let nodeStatus: unknown;
  try {
    nodeStatus = await deps.smartnode.get("node/status");
  } catch (e) {
    const m = msgOf(e);
    status.errors.push(m);
    if (/sync/i.test(m)) return finish("waiting", "Waiting for the Ethereum clients to sync.");
    return finish("error", "Could not read the node status from the Rocket Pool daemon.");
  }
  if (obj(nodeStatus).registered !== true) return finish("waiting", "The node is not registered with Rocket Pool yet.");

  let megapoolStatus: unknown = undefined;
  if (obj(nodeStatus).megapoolDeployed === true) {
    try {
      megapoolStatus = await deps.smartnode.get("megapool/status");
    } catch (e) {
      status.errors.push(`megapool/status: ${msgOf(e)}`);
      return finish("error", "Could not read the megapool validators from the Rocket Pool daemon.");
    }
  }

  // 2. Keys and fee recipients
  const info = parseFeeRecipientInfo(nodeStatus);
  status.fee = { ...info };
  const wanted = wantedKeys(nodeStatus, megapoolStatus);
  status.keys.total = wanted.length;
  status.keys.summary = `0/${wanted.length}`;
  status.validators = wanted.map((k) => {
    const target = feeRecipientFor(k.kind, info);
    return {
      pubkey: k.pubkey,
      kind: k.kind,
      ref: k.ref,
      state: "no-client",
      feeRecipient: { rule: target.rule, expected: target.address, state: "not-loaded" },
    };
  });
  status.feeRecipients.total = wanted.length;

  // 3. Consensus clients
  let packages: InstalledPackage[];
  try {
    packages = await deps.listPackages();
  } catch (e) {
    status.errors.push(`DAPPMANAGER: ${msgOf(e)}`);
    return finish("error", "Could not ask the DAPPMANAGER which consensus client is installed.");
  }
  const sel = selectClient(packages, deps.configuredClient);
  status.unknownValidatorPackages = sel.unknownValidatorPackages;
  status.clientChoice = { source: sel.source, why: sel.why };
  if (!sel.chosen) {
    status.errors.push(sel.reason ?? "No consensus client selected.");
    return finish(wanted.length === 0 ? "attention" : "error", sel.reason ?? "No consensus client selected.");
  }
  const chosen = sel.chosen;
  status.client = { id: chosen.id, name: chosen.name, package: chosen.packageName };

  const chosenKm = deps.keymanagerFor(chosen);
  let loaded: Set<string>;
  try {
    loaded = await chosenKm.listKeystores();
  } catch (e) {
    status.errors.push(`${chosen.name} keymanager: ${msgOf(e)}`);
    return finish("error", `Could not read the validator keys from ${chosen.name}. Is it running?`);
  }
  // Remote (web3signer) keys sign too. AVADO packages do not use them and not every client
  // answers this route, so a failure here is noted but does not block anything by itself.
  try {
    for (const pk of await chosenKm.listRemoteKeys()) loaded.add(pk);
  } catch {
    /* not supported by every client/proxy */
  }

  // Keys loaded in every other installed client (the §2.5 double-signing guard).
  const elsewhere = new Map<string, string>();
  const blockReasons: string[] = [];
  for (const other of sel.installed) {
    if (other.id === chosen.id) continue;
    const entry: ReconcileStatus["otherClients"][number] = { id: other.id, name: other.name, package: other.packageName, checked: false };
    status.otherClients.push(entry);
    const km = deps.keymanagerFor(other);
    try {
      for (const pk of await km.listKeystores()) if (!elsewhere.has(pk)) elsewhere.set(pk, other.packageName);
      entry.checked = true;
    } catch (e) {
      entry.error = msgOf(e);
      blockReasons.push(`the keys in ${other.name} (${other.packageName}) could not be checked: ${entry.error}`);
      continue;
    }
    try {
      for (const pk of await km.listRemoteKeys()) if (!elsewhere.has(pk)) elsewhere.set(pk, other.packageName);
    } catch {
      /* see above */
    }
  }
  for (const p of sel.unknownValidatorPackages) {
    blockReasons.push(`${p} is installed and may hold validator keys this app cannot check`);
  }

  // 4. Imports
  let approved: Set<string>;
  try {
    const a = await deps.readApproved();
    approved = a.keys;
    if (a.error) status.errors.push(a.error);
  } catch (e) {
    approved = new Set();
    status.errors.push(`The approved-keys list could not be read: ${msgOf(e)}`);
  }
  let importsThisRun = 0;
  let deferred = false;
  for (const v of status.validators) {
    if (loaded.has(v.pubkey)) {
      v.state = "loaded";
      continue;
    }
    const where = elsewhere.get(v.pubkey);
    if (where) {
      v.state = "elsewhere";
      v.loadedIn = where;
      v.error = `Loaded in ${where}; not imported into ${chosen.name}.`;
      continue;
    }
    if (!approved.has(v.pubkey)) {
      // Only offer keys that could actually be loaded.
      const ks = await deps.loadKeystore(v.pubkey, chosen.id);
      if ("problem" in ks) {
        v.state = "missing-keystore";
        v.error = keystoreError(ks);
      } else {
        v.state = "awaiting-approval";
        status.awaitingApproval.push(v.pubkey);
      }
      continue;
    }
    if (blockReasons.length > 0) {
      v.state = "import-blocked";
      continue;
    }
    const attempts = deps.importAttempts.get(v.pubkey) ?? 0;
    if (attempts >= MAX_IMPORT_ATTEMPTS) {
      v.state = "retry-limit";
      v.error = `Import failed ${attempts} times; press "Check now" to try again.`;
      continue;
    }
    if (importsThisRun >= MAX_IMPORTS_PER_RUN) {
      v.state = "deferred";
      deferred = true;
      continue;
    }
    const ks = await deps.loadKeystore(v.pubkey, chosen.id);
    if ("problem" in ks) {
      v.state = "missing-keystore";
      v.error = keystoreError(ks);
      continue;
    }
    importsThisRun++;
    try {
      const r = await chosenKm.importKeystore(ks.keystoreJson, ks.password);
      if (r.status === "imported" || r.status === "duplicate") {
        v.state = "imported";
        loaded.add(v.pubkey);
        deps.importAttempts.delete(v.pubkey);
        status.keys.imported++;
        log("info", `reconcile: imported ${shortKey(v.pubkey)} into ${chosen.name} (${r.status})`);
      } else {
        throw new Error(`${chosen.name} answered "${r.status}"${r.message ? `: ${r.message}` : ""}`);
      }
    } catch (e) {
      deps.importAttempts.set(v.pubkey, attempts + 1);
      v.state = "import-failed";
      v.error = `Import into ${chosen.name} failed: ${msgOf(e)}`;
      log("warn", `reconcile: import of ${shortKey(v.pubkey)} into ${chosen.name} failed (attempt ${attempts + 1})`);
    }
  }
  if (blockReasons.length > 0 && status.validators.some((v) => v.state === "import-blocked")) {
    for (const r of blockReasons) status.errors.push(`Keys were not imported: ${r}.`);
  }

  // 5. Fee recipients of the Rocket Pool keys loaded in the chosen client
  for (const v of status.validators) {
    if (!loaded.has(v.pubkey)) continue;
    const fr = v.feeRecipient;
    if (!fr.expected) {
      fr.state = "no-address";
      status.feeRecipients.failed++;
      v.error = joinErr(v.error, `The Rocket Pool daemon reported no ${fr.rule} address.`);
      continue;
    }
    try {
      fr.found = await chosenKm.getFeeRecipient(v.pubkey);
      if (fr.found === fr.expected) {
        fr.state = "ok";
        status.feeRecipients.ok++;
        continue;
      }
      await chosenKm.setFeeRecipient(v.pubkey, fr.expected);
      fr.state = "fixed";
      status.feeRecipients.fixed++;
      log("info", `reconcile: fee recipient of ${shortKey(v.pubkey)} set to ${fr.expected} (${fr.rule})`);
    } catch (e) {
      fr.state = "failed";
      status.feeRecipients.failed++;
      v.error = joinErr(v.error, `Setting the fee recipient failed: ${msgOf(e)}`);
    }
  }

  status.keys.inSync = status.validators.filter((v) => loaded.has(v.pubkey)).length;
  status.keys.summary = `${status.keys.inSync}/${status.keys.total}`;
  if (deferred) status.errors.push("More keys to import; the next check continues.");

  const allLoaded = status.keys.inSync === status.keys.total;
  const feeOk = status.feeRecipients.failed === 0 && status.validators.every((v) => v.feeRecipient.state !== "not-loaded");
  const summary = `Validator keys in sync with ${chosen.name}: ${status.keys.summary}.`;
  const n = status.awaitingApproval.length;
  if (n > 0) {
    return finish(
      "attention",
      `${summary} ${n} validator key${n === 1 ? " is" : "s are"} not loaded and wait${n === 1 ? "s" : ""} for your approval.`,
    );
  }
  if (allLoaded && feeOk && status.errors.length === 0) {
    const fixed = status.feeRecipients.fixed ? ` Fee recipient corrected for ${status.feeRecipients.fixed}.` : "";
    return finish("ok", summary + fixed);
  }
  return finish("attention", summary + " Some keys need attention.");
}

function keystoreError(ks: KeystoreProblem): string {
  return ks.problem === "missing"
    ? "No keystore for this key in the Rocket Pool data folder."
    : `The keystore for this key cannot be used (${ks.detail}).`;
}

function joinErr(a: string | undefined, b: string): string {
  return a ? `${a} ${b}` : b;
}
