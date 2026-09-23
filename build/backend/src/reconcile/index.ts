/**
 * Reconcile module boundary (keys and fee recipients in the consensus client).
 *
 * Task 2 only provides the status/trigger plumbing used by the HTTP endpoints:
 *  - the loop writes its status to config.reconcileStatusFile (/tmp/reconcile-status.json)
 *  - anyone (the UI, Smartnode's validatorRestartCommand script) asks for a run by
 *    creating config.reconcileTriggerFile (/tmp/reconcile-now)
 *
 * Task 3 implements startReconcileLoop() here; server.ts already calls it.
 */
import { readFile, stat, writeFile } from "node:fs/promises";
import type { Config } from "../config";
import type { Logger } from "../log";

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

export interface ReconcileLoop {
  stop(): void;
}

/** Stub until Task 3: the loop is not implemented yet. */
export function startReconcileLoop(_config: Config, logger: Logger): ReconcileLoop {
  logger.info("reconcile loop: not implemented in this build");
  return { stop() {} };
}
