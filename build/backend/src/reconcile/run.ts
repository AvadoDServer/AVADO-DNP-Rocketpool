/**
 * One reconciliation pass (spec §4.3, §2.5):
 *
 *  1. Smartnode: wallet initialised and not masquerading, node registered — otherwise
 *     "waiting" and nothing else is touched (no DAPPMANAGER or keymanager call).
 *  2. The node's Rocket Pool keys (node/status minipools, megapool/status validators) and
 *     each key's fee recipient (rules.ts).
 *  3. The installed consensus clients (DAPPMANAGER listPackages), the chosen one, and the
 *     keys loaded in each of them.
 *  4. A Rocket Pool key loaded in two installed clients: state "error", a loud message, and
 *     no import at all in this run (it is never removed automatically).
 *  5. Import a Rocket Pool key that is missing in every installed client into the chosen
 *     client, only when ALL of these hold:
 *      - it has an unused approval (approved.ts): created by this node's deposit through
 *        the backend, or confirmed by the owner. Approvals are single-use: a key seen loaded
 *        uses its approval up, so a key the owner removes later waits for a new approval.
 *      - every installed client's key list was read, and no unknown validator package is
 *        installed
 *      - it has been absent from every installed client for SETTLE_MS (absence.ts), unless
 *        it is a deposit key that was never seen in any client
 *      - the chosen client's package is safe to import into (Teku: TEKU_SAFE_IMPORT_VERSION)
 *      - its import has not failed MAX_IMPORT_ATTEMPTS times since it was last approved
 *  6. Set the fee recipient of each Rocket Pool key in EVERY installed client whose list was
 *     read (no slashing risk; a key running in a non-chosen client earns rewards too).
 *
 * Never deletes a key, never touches a key that is not a Rocket Pool key of this node,
 * never throws: every failure ends up in the returned status.
 */
import { settlesAt, updateAbsence, type AbsenceMap, type Observation } from "./absence";
import { isUsable, type ApprovedEntry, type ApprovedRead } from "./approved";
import type { ClientId, ClientInfo, InstalledPackage } from "./clients";
import { importAllowed, selectClient } from "./clients";
import { shortKey } from "./hex";
import type { Keymanager } from "./keymanager";
import type { KeystoreProblem, LoadedKeystore } from "./keystores";
import { feeRecipientFor, parseFeeRecipientInfo, wantedKeys, type FeeRecipientRule, type KeyKind } from "./rules";

export const STATUS_VERSION = 2;

/** Failed import attempts per key before the loop stops; a new owner approval resets it. */
export const MAX_IMPORT_ATTEMPTS = 3;
/** Imports per run; the rest follow in the next run. */
export const MAX_IMPORTS_PER_RUN = 20;

export type ReconcileState = "ok" | "waiting" | "attention" | "error";

export type KeyState =
  | "loaded" // in the chosen client
  | "imported" // imported in this run
  | "loaded-twice" // in two installed clients at once: slashing danger
  | "elsewhere" // loaded in another installed client (not the chosen one)
  | "awaiting-approval" // missing, and no unused approval: the owner decides
  | "settling" // approved, waiting until it has been absent everywhere long enough
  | "import-blocked" // approved, but not every client could be checked (or a key is loaded twice)
  | "client-update-needed" // approved, but the chosen client package is too old to import into
  | "missing-keystore" // no usable keystore in the data dir
  | "import-failed"
  | "retry-limit" // import failed MAX_IMPORT_ATTEMPTS times; waits for a new approval
  | "deferred" // over MAX_IMPORTS_PER_RUN; next run
  | "no-client"; // missing, and no chosen client

export type FeeState = "ok" | "fixed" | "failed" | "no-address" | "not-loaded";

export interface KeyStatus {
  pubkey: string;
  kind: KeyKind;
  ref: string;
  state: KeyState;
  /** Packages the key is loaded in after this run. */
  loadedIn: string[];
  /** For "settling": when the key may be imported. */
  settlesAt?: string;
  feeRecipient: {
    rule: FeeRecipientRule;
    expected: string | null;
    /** Worst result over the clients the key is loaded in. */
    state: FeeState;
    clients: Array<{ package: string; found?: string | null; state: FeeState; error?: string }>;
  };
  error?: string;
}

export interface ClientReport {
  id: ClientId;
  name: string;
  package: string;
  version: string | null;
  chosen: boolean;
  /** The key list was read. */
  checked: boolean;
  error?: string;
  /** Rocket Pool keys loaded in it after this run. */
  rocketPoolKeys: number;
  feeRecipients: { ok: number; fixed: number; failed: number };
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
  /** Rocket Pool keys missing in every client that wait for the owner's approval (96 hex, no 0x). */
  awaitingApproval: string[];
  /**
   * Why approved keys cannot be loaded right now (an unreadable client, an unknown validator
   * package, a key loaded twice, an old Teku). Show it next to the approval prompt.
   */
  importBlockedReasons: string[];
  /** Keys loaded in two installed clients at once. */
  loadedTwice: Array<{ pubkey: string; packages: string[] }>;
  /** Every installed known client, the chosen one included. */
  clients: ClientReport[];
  unknownValidatorPackages: string[];
  keys: {
    total: number;
    /** Loaded in the chosen client after this run. */
    inSync: number;
    imported: number;
    /** e.g. "3/3" */
    summary: string;
  };
  /** Per key, over all clients it is loaded in. */
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

export interface ImportAttempts {
  count: number;
  lastFailAt: string;
}

export interface RunDeps {
  smartnode: SmartnodeReader;
  listPackages(): Promise<InstalledPackage[]>;
  keymanagerFor(client: ClientInfo): Keymanager;
  loadKeystore(pubkey: string, client: ClientId): Promise<LoadedKeystore | KeystoreProblem>;
  /** The "approved to load" list, read on every run. */
  readApproved(): Promise<ApprovedRead>;
  /** Marks the approvals of these keys as used (they were seen loaded). */
  consumeApprovals(pubkeys: string[]): Promise<void>;
  /** Persisted absence observations (settling delay). */
  readAbsence(): Promise<AbsenceMap>;
  writeAbsence(map: AbsenceMap): Promise<void>;
  /** CONSENSUSCLIENT from the package settings. */
  configuredClient: string | undefined;
  /** Failed import attempts per pubkey, kept by the loop between runs. */
  importAttempts: Map<string, ImportAttempts>;
  trigger: ReconcileStatus["trigger"];
  now?: () => Date;
  log?: (level: "info" | "warn" | "error", msg: string) => void;
}

const msgOf = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);
const obj = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

const FEE_RANK: Record<FeeState, number> = { "not-loaded": 0, ok: 1, fixed: 2, "no-address": 3, failed: 4 };

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
    importBlockedReasons: [],
    loadedTwice: [],
    clients: [],
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
    return await reconcile(deps, status, finish, now, log);
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
  now: () => Date,
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
      loadedIn: [],
      feeRecipient: { rule: target.rule, expected: target.address, state: "not-loaded", clients: [] },
    };
  });
  status.feeRecipients.total = wanted.length;

  // 3. Consensus clients and the keys loaded in each
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
  const chosen = sel.chosen;
  if (chosen) status.client = { id: chosen.id, name: chosen.name, package: chosen.packageName };
  else status.errors.push(sel.reason ?? "No consensus client selected.");

  const versionOf = (c: ClientInfo) => packages.find((p) => p.name === c.packageName)?.version ?? null;
  const kms = new Map<ClientId, Keymanager>();
  const loadedBy = new Map<ClientId, Set<string>>(); // readable clients only
  const blockReasons: string[] = [];
  for (const c of sel.installed) {
    const report: ClientReport = {
      id: c.id,
      name: c.name,
      package: c.packageName,
      version: versionOf(c),
      chosen: c.id === chosen?.id,
      checked: false,
      rocketPoolKeys: 0,
      feeRecipients: { ok: 0, fixed: 0, failed: 0 },
    };
    status.clients.push(report);
    const km = deps.keymanagerFor(c);
    kms.set(c.id, km);
    let keys: Set<string>;
    try {
      keys = await km.listKeystores();
      report.checked = true;
    } catch (e) {
      report.error = msgOf(e);
      blockReasons.push(`the keys in ${c.name} (${c.packageName}) could not be checked (${report.error}); is it running?`);
      continue;
    }
    // Remote (web3signer) keys sign too; not every client/proxy answers this route.
    try {
      for (const pk of await km.listRemoteKeys()) keys.add(pk);
    } catch {
      /* not supported everywhere */
    }
    loadedBy.set(c.id, keys);
  }
  for (const p of sel.unknownValidatorPackages) {
    blockReasons.push(`${p} is installed and may run validator keys this app cannot check`);
  }
  const clientsOf = (pk: string) => sel.installed.filter((c) => loadedBy.get(c.id)?.has(pk));
  const chosenReadable = !!chosen && loadedBy.has(chosen.id);
  if (chosen && !chosenReadable) status.errors.push(`Could not read the validator keys from ${chosen.name}. Is it running?`);

  // 4. A key loaded twice
  for (const v of status.validators) {
    const inClients = clientsOf(v.pubkey);
    v.loadedIn = inClients.map((c) => c.packageName);
    if (inClients.length >= 2) {
      v.state = "loaded-twice";
      status.loadedTwice.push({ pubkey: v.pubkey, packages: v.loadedIn });
      const msg = `Validator 0x${v.pubkey} is loaded in both ${inClients.map((c) => c.name).join(" and ")} — this can get it slashed. Remove it from one of them now.`;
      v.error = msg;
      status.errors.push(msg);
    } else if (inClients.length === 1) {
      v.state = inClients[0]!.id === chosen?.id ? "loaded" : "elsewhere";
      if (v.state === "elsewhere") v.error = `Loaded in ${inClients[0]!.name}${chosen ? `, not in ${chosen.name}` : ""}.`;
    }
  }
  if (status.loadedTwice.length > 0) {
    blockReasons.push("a validator key is loaded in two consensus clients at once; no key is loaded until that is fixed");
  }

  // Approvals are used up by keys that are loaded anywhere.
  let approvals = new Map<string, ApprovedEntry>();
  try {
    const a = await deps.readApproved();
    approvals = a.entries;
    if (a.error) status.errors.push(a.error);
  } catch (e) {
    status.errors.push(`The approved-keys list could not be read: ${msgOf(e)}`);
  }
  const consume = async (pks: string[]) => {
    const fresh = pks.filter((pk) => isUsable(approvals.get(pk)));
    if (fresh.length === 0) return;
    try {
      await deps.consumeApprovals(fresh);
    } catch (e) {
      status.errors.push(`Could not record that approved keys are loaded: ${msgOf(e)}`);
    }
    const at = now().toISOString();
    for (const pk of fresh) approvals.set(pk, { ...approvals.get(pk)!, loadedAt: at });
  };
  await consume(status.validators.filter((v) => v.loadedIn.length > 0).map((v) => v.pubkey));

  // Absence observations (settling delay). Only a run that read every installed client, with
  // no unknown validator package, can see a key as absent.
  const fullView = sel.installed.length > 0 && sel.installed.every((c) => loadedBy.has(c.id)) && sel.unknownValidatorPackages.length === 0;
  const observations = new Map<string, Observation>(
    status.validators.map((v) => [v.pubkey, v.loadedIn.length > 0 ? "present" : fullView ? "absent" : "unknown"] as const),
  );
  let absence: AbsenceMap = new Map();
  try {
    absence = updateAbsence(await deps.readAbsence(), observations, now());
    await deps.writeAbsence(absence);
  } catch (e) {
    absence = new Map(); // cannot prove absence: nothing counts as settled
    status.errors.push(`Could not record key observations: ${msgOf(e)}`);
  }

  // 5. Imports into the chosen client
  const gate = chosen ? importAllowed(chosen, versionOf(chosen)) : { allowed: false };
  if (chosen && !gate.allowed && gate.reason) blockReasons.push(gate.reason);
  const chosenKm = chosen ? kms.get(chosen.id) : undefined;
  let importsThisRun = 0;
  let deferred = false;
  for (const v of status.validators) {
    if (v.loadedIn.length > 0) continue;
    const found = approvals.get(v.pubkey);
    if (!found || !isUsable(found)) {
      const entry = found;
      // Only offer keys that could actually be loaded.
      const ks = await deps.loadKeystore(v.pubkey, chosen?.id ?? "teku");
      if ("problem" in ks) {
        v.state = "missing-keystore";
        v.error = keystoreError(ks);
      } else {
        v.state = "awaiting-approval";
        status.awaitingApproval.push(v.pubkey);
        if (entry?.loadedAt) v.error = "This key was loaded before and has been removed. Approve it again only if it runs nowhere else.";
      }
      continue;
    }
    const entry: ApprovedEntry = found;
    if (!chosen || !chosenReadable || !chosenKm) {
      v.state = chosen ? "import-blocked" : "no-client";
      continue;
    }
    if (!gate.allowed) {
      v.state = "client-update-needed";
      v.error = gate.reason;
      continue;
    }
    if (status.loadedTwice.length > 0 || blockReasons.length > 0) {
      v.state = "import-blocked";
      continue;
    }
    // Settling: deposit keys never seen in any client are exempt (an unused deposit approval
    // means the key has not been seen loaded since it was created).
    if (entry.source !== "deposit") {
      const at = settlesAt(absence.get(v.pubkey));
      if (!at || at.getTime() > now().getTime()) {
        v.state = "settling";
        if (at) v.settlesAt = at.toISOString();
        v.error = "Waiting to make sure this key is not running anywhere else before loading it.";
        continue;
      }
    }
    const lastApproval = Date.parse(entry.renewedAt ?? entry.approvedAt) || 0;
    let attempts = deps.importAttempts.get(v.pubkey);
    if (attempts && Date.parse(attempts.lastFailAt) < lastApproval) {
      deps.importAttempts.delete(v.pubkey);
      attempts = undefined;
    }
    if ((attempts?.count ?? 0) >= MAX_IMPORT_ATTEMPTS) {
      v.state = "retry-limit";
      v.error = `Loading this key failed ${attempts!.count} times. Approve it again to retry.`;
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
      if (r.status !== "imported" && r.status !== "duplicate") {
        throw new Error(`${chosen.name} answered "${r.status}"${r.message ? `: ${r.message}` : ""}`);
      }
      v.state = "imported";
      v.loadedIn = [chosen.packageName];
      loadedBy.get(chosen.id)!.add(v.pubkey);
      deps.importAttempts.delete(v.pubkey);
      status.keys.imported++;
      await consume([v.pubkey]);
      log("info", `reconcile: imported ${shortKey(v.pubkey)} into ${chosen.name} (${r.status})`);
    } catch (e) {
      const count = (attempts?.count ?? 0) + 1;
      deps.importAttempts.set(v.pubkey, { count, lastFailAt: now().toISOString() });
      v.state = "import-failed";
      v.error = `Import into ${chosen.name} failed: ${msgOf(e)}`;
      log("warn", `reconcile: import of ${shortKey(v.pubkey)} into ${chosen.name} failed (attempt ${count})`);
    }
  }
  status.importBlockedReasons = [...new Set(blockReasons)];
  if (status.validators.some((v) => v.state === "import-blocked")) {
    for (const r of status.importBlockedReasons) status.errors.push(`Keys were not loaded: ${r}.`);
  }

  // 6. Fee recipients in every readable installed client
  for (const c of sel.installed) {
    const keys = loadedBy.get(c.id);
    const km = kms.get(c.id);
    const report = status.clients.find((r) => r.id === c.id)!;
    if (!keys || !km) continue;
    for (const v of status.validators) {
      if (!keys.has(v.pubkey)) continue;
      report.rocketPoolKeys++;
      const fr = v.feeRecipient;
      const res: KeyStatus["feeRecipient"]["clients"][number] = { package: c.packageName, state: "ok" };
      fr.clients.push(res);
      if (!fr.expected) {
        res.state = "no-address";
        report.feeRecipients.failed++;
        continue;
      }
      let readError: string | undefined;
      try {
        res.found = await km.getFeeRecipient(v.pubkey);
      } catch (e) {
        readError = msgOf(e); // still try the (idempotent) set once
      }
      if (readError === undefined && res.found === fr.expected) {
        report.feeRecipients.ok++;
        continue;
      }
      try {
        await km.setFeeRecipient(v.pubkey, fr.expected);
        res.state = "fixed";
        report.feeRecipients.fixed++;
        log("info", `reconcile: fee recipient of ${shortKey(v.pubkey)} in ${c.name} set to ${fr.expected} (${fr.rule})`);
      } catch (e) {
        res.state = "failed";
        res.error = `${readError ? `reading failed (${readError}); ` : ""}setting failed (${msgOf(e)})`;
        report.feeRecipients.failed++;
      }
    }
  }
  for (const v of status.validators) {
    const fr = v.feeRecipient;
    fr.state = fr.clients.reduce<FeeState>((w, r) => (FEE_RANK[r.state] > FEE_RANK[w] ? r.state : w), "not-loaded");
    if (fr.state === "ok") status.feeRecipients.ok++;
    else if (fr.state === "fixed") status.feeRecipients.fixed++;
    else if (fr.state === "failed" || fr.state === "no-address") {
      status.feeRecipients.failed++;
      const detail = fr.clients.find((r) => r.state === fr.state);
      v.error = joinErr(
        v.error,
        fr.state === "no-address"
          ? `The Rocket Pool daemon reported no ${fr.rule} address.`
          : `Setting the fee recipient failed${detail?.error ? `: ${detail.error}` : ""}.`,
      );
    }
  }

  status.keys.inSync = chosen ? status.validators.filter((v) => loadedBy.get(chosen.id)?.has(v.pubkey)).length : 0;
  status.keys.summary = `${status.keys.inSync}/${status.keys.total}`;
  if (deferred) status.errors.push("More keys to load; the next check continues.");

  // Overall state and message
  const fixedNote = status.feeRecipients.fixed ? ` Fee recipient corrected for ${status.feeRecipients.fixed}.` : "";
  if (status.loadedTwice.length > 0) {
    const first = status.validators.find((v) => v.state === "loaded-twice")!;
    const more = status.loadedTwice.length > 1 ? ` (${status.loadedTwice.length} validators are affected.)` : "";
    return finish("error", `${first.error}${more}`);
  }
  if (!chosen) {
    const where = status.clients.filter((c) => c.rocketPoolKeys > 0).map((c) => c.name);
    const note = where.length ? ` Fee recipients were checked in ${where.join(", ")}.` : "";
    return finish("error", `${sel.reason ?? "No consensus client selected."}${note}`);
  }
  if (!chosenReadable) return finish("error", `Could not read the validator keys from ${chosen.name}. Is it running?${fixedNote}`);

  const summary = `Validator keys in sync with ${chosen.name}: ${status.keys.summary}.`;
  const n = status.awaitingApproval.length;
  if (n > 0) {
    const blocked = status.importBlockedReasons.length ? ` They cannot be loaded right now: ${status.importBlockedReasons[0]}.` : "";
    return finish(
      "attention",
      `${summary} ${n} validator key${n === 1 ? " is" : "s are"} not loaded and wait${n === 1 ? "s" : ""} for your approval.${blocked}`,
    );
  }
  if (!gate.allowed && status.validators.some((v) => v.state === "client-update-needed")) {
    return finish("attention", `${summary} Update Teku before loading keys.${fixedNote}`);
  }
  const allLoaded = status.keys.inSync === status.keys.total;
  const feeOk = status.feeRecipients.failed === 0 && status.validators.every((v) => v.feeRecipient.state !== "not-loaded");
  if (allLoaded && feeOk && status.errors.length === 0) return finish("ok", summary + fixedNote);
  if (status.validators.some((v) => v.state === "settling")) {
    return finish("attention", `${summary} Approved keys will be loaded once they have been absent everywhere for 20 minutes.${fixedNote}`);
  }
  return finish("attention", `${summary} Some keys need attention.${fixedNote}`);
}

function keystoreError(ks: KeystoreProblem): string {
  return ks.problem === "missing"
    ? "No keystore for this key in the Rocket Pool data folder."
    : `The keystore for this key cannot be used (${ks.detail}).`;
}

function joinErr(a: string | undefined, b: string): string {
  return a ? `${a} ${b}` : b;
}
