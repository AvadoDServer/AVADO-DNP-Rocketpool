/**
 * Scheduler for the reconcile pass: every RECONCILE_INTERVAL_MS (5 min), shortly after start,
 * and as soon as the trigger file (/tmp/reconcile-now) appears — written by the UI's
 * "Check now" (POST /api/avado/reconcile/run) and by Smartnode's validatorRestartCommand.
 *
 * Runs never overlap. A trigger resets the per-key import attempt counters. The status is
 * written atomically (temp file + rename) so the HTTP endpoint never reads half a file.
 */
import { rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { redact } from "../log";
import type { ReconcileStatus, RunDeps } from "./run";
import { runReconcile } from "./run";

const DEFERRED_RUN_DELAY_MS = 30_000;

export interface LoopOptions {
  statusFile: string;
  triggerFile: string;
  intervalMs: number;
  /** Delay before the first run. */
  startDelayMs: number;
  /** How often the trigger file is looked for. */
  triggerPollMs: number;
  /** Shortest gap between two runs (trigger spam). */
  minGapMs: number;
  /** Builds the per-run dependencies (a fresh WAMP session etc.) and a cleanup. */
  makeDeps(trigger: ReconcileStatus["trigger"], importAttempts: Map<string, number>): { deps: RunDeps; dispose(): void };
  log(level: "info" | "warn" | "error", msg: string): void;
}

export interface ReconcileLoop {
  stop(): void;
  /** Resolves when the current run (if any) is done. For tests. */
  idle(): Promise<void>;
}

export async function writeStatusFile(file: string, status: ReconcileStatus): Promise<void> {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  // redact() is a second line of defence: the status never holds secrets.
  await writeFile(tmp, redact(JSON.stringify(status, null, 2)) + "\n", { mode: 0o644 });
  await rename(tmp, file);
}

export function startLoop(opts: LoopOptions): ReconcileLoop {
  const importAttempts = new Map<string, number>();
  let stopped = false;
  let running: Promise<void> | null = null;
  let lastRunEnd = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let nextRunAt = Date.now() + opts.startDelayMs;
  let firstRun = true;

  const runOnce = async (trigger: ReconcileStatus["trigger"]) => {
    const { deps, dispose } = opts.makeDeps(trigger, importAttempts);
    try {
      const status = await runReconcile(deps);
      // Keys left over for the next run (MAX_IMPORTS_PER_RUN) follow soon, not in 5 minutes.
      const more = status.validators.some((v) => v.state === "deferred");
      nextRunAt = Date.now() + (more ? Math.min(opts.intervalMs, DEFERRED_RUN_DELAY_MS) : opts.intervalMs);
      status.nextRunAt = new Date(nextRunAt).toISOString();
      await writeStatusFile(opts.statusFile, status);
      const line = `reconcile (${trigger}): ${status.state} — ${status.message}`;
      opts.log(status.state === "error" ? "warn" : "info", line);
    } catch (e) {
      opts.log("error", `reconcile: could not write the status file: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      try {
        dispose();
      } catch {
        /* ignore */
      }
    }
  };

  const tick = async () => {
    timer = null;
    if (stopped) return;
    try {
      let trigger: ReconcileStatus["trigger"] | null = null;
      const requested = await stat(opts.triggerFile).then(
        () => true,
        () => false,
      );
      if (requested && Date.now() - lastRunEnd >= opts.minGapMs) {
        // Remove the request before running, so a request made during the run is not lost.
        await rm(opts.triggerFile, { force: true });
        importAttempts.clear();
        trigger = "request";
      } else if (Date.now() >= nextRunAt) {
        trigger = firstRun ? "startup" : "timer";
      }
      if (trigger && !stopped) {
        firstRun = false;
        running = runOnce(trigger);
        await running;
        running = null;
        lastRunEnd = Date.now();
      }
    } catch (e) {
      opts.log("error", `reconcile: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!stopped) {
      timer = setTimeout(() => void tick(), opts.triggerPollMs);
      timer.unref?.();
    }
  };

  timer = setTimeout(() => void tick(), Math.min(opts.triggerPollMs, opts.startDelayMs));
  timer.unref?.();

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
    async idle() {
      if (running) await running;
    },
  };
}
