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
import type { Config } from "../config";
import { HttpError } from "../http-util";
import type { Logger } from "../log";
import { SmartnodeClient } from "../sn/proxy";
import { readAbsence, writeAbsence } from "./absence";
import { checkApprovalsWritable, consumeApprovals, readApprovedKeys } from "./approved";
import { listInstalledPackages } from "./clients";
import { createKeymanager } from "./keymanager";
import { loadKeystore } from "./keystores";
import { startLoop, type ReconcileLoop } from "./loop";
import type { SmartnodeReader } from "./run";
import { WampClient } from "./wamp";

export type { ReconcileStatus } from "./run";
export type { ReconcileLoop } from "./loop";
export {
  APPROVE_CONFIRMATION,
  approveKeysForLoading,
  getReconcileStatus,
  recordDepositKeys,
  requestReconcileRun,
  type ReconcileStatusView,
} from "./api";

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
    makeDeps(trigger, importAttempts, seenLoaded) {
      const wamp = new WampClient({ url: config.wampUrl, realm: "dappnode_admin" });
      return {
        deps: {
          smartnode: sn,
          // listPackages runs `docker system df`, which is slow on a busy box
          listPackages: () => listInstalledPackages(wamp, 60_000),
          keymanagerFor: (client) => createKeymanager({ baseUrl: client.keymanagerUrl }),
          loadKeystore: (pubkey, client) => loadKeystore(config.dataDir, pubkey, client),
          readApproved: () => readApprovedKeys(config.dataDir),
          consumeApprovals: async (pubkeys) => {
            await consumeApprovals(config.dataDir, pubkeys);
          },
          checkApprovalsWritable: () => checkApprovalsWritable(config.dataDir),
          seenLoaded,
          readAbsence: () => readAbsence(config.dataDir),
          writeAbsence: (map) => writeAbsence(config.dataDir, map),
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
