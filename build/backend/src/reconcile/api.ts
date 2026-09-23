/**
 * The reconcile loop's HTTP-facing side: status file, run requests, key approvals.
 * Imports nothing from the Smartnode proxy, so the proxy can use recordDepositKeys().
 */
import { readFile, stat, writeFile } from "node:fs/promises";
import type { Config } from "../config";
import { HttpError } from "../http-util";
import { addApprovedKeys } from "./approved";
import { normalizePubkey } from "./hex";

export interface ReconcileStatusView {
  /** false until the loop has written a status file. */
  available: boolean;
  /** A run was requested and has not been picked up yet. */
  runRequested: boolean;
  /** The status file's content as written by the loop (shape owned by Task 3). */
  status?: unknown;
  /** Status file modification time. */
  updatedAt?: string;
  error?: string;
}

export async function getReconcileStatus(config: Config): Promise<ReconcileStatusView> {
  const runRequested = await stat(config.reconcileTriggerFile).then(
    () => true,
    () => false,
  );
  let raw: string;
  let mtime: Date;
  try {
    [raw, mtime] = await Promise.all([
      readFile(config.reconcileStatusFile, "utf8"),
      stat(config.reconcileStatusFile).then((s) => s.mtime),
    ]);
  } catch {
    return { available: false, runRequested };
  }
  try {
    return { available: true, runRequested, status: JSON.parse(raw), updatedAt: mtime.toISOString() };
  } catch {
    return { available: false, runRequested, error: "The reconcile status file is not valid JSON" };
  }
}

/** Asks the loop to run now by touching the trigger file. */
export async function requestReconcileRun(config: Config): Promise<void> {
  await writeFile(config.reconcileTriggerFile, new Date().toISOString() + "\n", { mode: 0o644 });
}

/** The typed confirmation the owner must send to approve loading keys. */
export const APPROVE_CONFIRMATION = "LOAD";
export const MAX_APPROVE_KEYS = 1000;

/**
 * POST /api/avado/reconcile/approve {pubkeys:[...], confirm:"LOAD"}: the owner confirms
 * that these validators run nowhere else. Adds them to the approved list and asks for a
 * run. Throws HttpError(400) on a bad request; nothing is written then.
 */
export async function approveKeysForLoading(config: Config, body: unknown): Promise<{ approved: number; added: number }> {
  const b = (typeof body === "object" && body !== null && !Array.isArray(body) ? body : {}) as { pubkeys?: unknown; confirm?: unknown };
  if (b.confirm !== APPROVE_CONFIRMATION) {
    throw new HttpError(400, `Type ${APPROVE_CONFIRMATION} to confirm that these validators are not running anywhere else.`);
  }
  if (!Array.isArray(b.pubkeys) || b.pubkeys.length === 0 || b.pubkeys.length > MAX_APPROVE_KEYS) {
    throw new HttpError(400, `pubkeys must be a list of 1 to ${MAX_APPROVE_KEYS} validator public keys`);
  }
  const keys = b.pubkeys.map(normalizePubkey);
  if (keys.some((k) => k === null)) throw new HttpError(400, "pubkeys contains an invalid validator public key");
  const unique = [...new Set(keys as string[])];
  const added = await addApprovedKeys(config.dataDir, unique, "owner");
  await requestReconcileRun(config);
  return { approved: unique.length, added };
}

/**
 * Called by the Smartnode proxy after a successful node/deposit: the keys in
 * `validatorPubkeys` were just created by this node, so they may be loaded without asking.
 * Only a success answer with a transaction hash counts (without submit=true Smartnode does
 * not save the keys). Returns the number of keys recorded.
 */
export async function recordDepositKeys(config: Config, body: unknown): Promise<number> {
  const b = (body ?? {}) as { status?: unknown; txHash?: unknown; validatorPubkeys?: unknown };
  if (b.status !== "success" || !Array.isArray(b.validatorPubkeys)) return 0;
  if (typeof b.txHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(b.txHash) || /^0x0{64}$/.test(b.txHash)) return 0;
  const keys = b.validatorPubkeys.map(normalizePubkey).filter((k): k is string => k !== null);
  if (keys.length === 0) return 0;
  const added = await addApprovedKeys(config.dataDir, keys, "deposit");
  await requestReconcileRun(config);
  return added;
}

