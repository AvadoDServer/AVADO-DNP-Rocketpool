/**
 * Reconcile module boundary (keys and fee recipients in the consensus client).
 *
 * Task 2 only provides the status/trigger plumbing used by the HTTP endpoints:
 *  - the loop writes its status to config.reconcileStatusFile (/tmp/reconcile-status.json)
 *  - anyone (the UI, Smartnode's validatorRestartCommand script) asks for a run by
 *    creating config.reconcileTriggerFile (/tmp/reconcile-now)
 *
 * The loop itself: loop.ts (scheduling, status file), run.ts (one pass), rules.ts (which
 * keys, which fee recipient), clients.ts (AVADO consensus-client packages), keymanager.ts,
 * keystores.ts, wamp.ts (DAPPMANAGER).
 */
import { readFile, stat, writeFile } from "node:fs/promises";
import type { Config } from "../config";
import { HttpError } from "../http-util";
import type { Logger } from "../log";
import { SmartnodeClient } from "../sn/proxy";
import { listInstalledPackages } from "./clients";
import { createKeymanager } from "./keymanager";
import { loadKeystore } from "./keystores";
import { startLoop, type ReconcileLoop } from "./loop";
import type { SmartnodeReader } from "./run";
import { WampClient } from "./wamp";

export type { ReconcileStatus } from "./run";
export type { ReconcileLoop } from "./loop";

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

/** Smartnode GET with the token injected; the error envelope and HTTP failures become an Error. */
export function smartnodeReader(client: SmartnodeClient, timeoutMs: number): SmartnodeReader {
  return {
    async get(route, query = {}) {
      let r: { status: number; body: unknown };
      try {
        r = await client.call(route, "GET", new URLSearchParams(query), { timeoutMs });
      } catch (e) {
        throw new Error(e instanceof HttpError ? e.message : `Rocket Pool daemon: ${String((e as Error)?.message ?? e)}`);
      }
      const body = r.body as { status?: unknown; error?: unknown } | null;
      if (r.status !== 200 || body?.status !== "success") {
        const err = typeof body?.error === "string" && body.error ? body.error : `HTTP ${r.status}`;
        throw new Error(`Rocket Pool daemon (${route}): ${err}`);
      }
      return body;
    },
  };
}

export function startReconcileLoop(config: Config, logger: Logger): ReconcileLoop {
  const sn = smartnodeReader(new SmartnodeClient(config, logger), config.snTimeoutMs);
  logger.info(
    `reconcile loop: every ${Math.round(config.reconcileIntervalMs / 1000)} s, consensus client setting ${config.consensusClient ?? "(none)"}`,
  );
  return startLoop({
    statusFile: config.reconcileStatusFile,
    triggerFile: config.reconcileTriggerFile,
    intervalMs: config.reconcileIntervalMs,
    startDelayMs: 15_000,
    triggerPollMs: 2_000,
    minGapMs: 10_000,
    log: (level, msg) => logger[level](msg),
    makeDeps(trigger, importAttempts) {
      const wamp = new WampClient({ url: config.wampUrl, realm: "dappnode_admin" });
      return {
        deps: {
          smartnode: sn,
          // listPackages runs `docker system df`, which is slow on a busy box
          listPackages: () => listInstalledPackages(wamp, 60_000),
          keymanagerFor: (client) => createKeymanager({ baseUrl: client.keymanagerUrl }),
          loadKeystore: (pubkey, client) => loadKeystore(config.dataDir, pubkey, client),
          configuredClient: config.consensusClient,
          importAttempts,
          trigger,
          log: (level, msg) => logger[level](msg),
        },
        dispose: () => wamp.close(),
      };
    },
  });
}
