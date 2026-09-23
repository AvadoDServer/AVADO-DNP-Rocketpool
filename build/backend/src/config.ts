import path from "node:path";
import { DEFAULT_ALLOWED_HOSTNAMES } from "./host";

/** Runtime configuration. Everything comes from the environment, with the package defaults. */
export interface Config {
  port: number;
  host: string;
  /** Directory with the built UI (index.html, assets/). */
  uiDir: string;
  /** Base URL of the Smartnode HTTP API (bound to localhost inside the container). */
  snApi: string;
  /** Smartnode data dir: wallet, password, validators/, api-tokens.json. */
  dataDir: string;
  /** Where package and wallet-change backups live (same volume as dataDir). */
  backupDir: string;
  /** Status file written by the reconcile loop (Task 3). */
  reconcileStatusFile: string;
  /** File whose presence asks the reconcile loop to run now. */
  reconcileTriggerFile: string;
  /** File with the Rocket Pool daemon's stdout/stderr (written by supervisord). */
  daemonLogFile: string;
  /** Optional file with a startup error written by the start script (bad config, unsupported network). */
  startupErrorFile: string;
  /** Supervisord XML-RPC unix socket. */
  supervisorSocket: string;
  /** Supervisord program name of the daemon. */
  daemonProgram: string;
  /** Package version, from the image. Falls back to <dataDir>/.avado-package-version. */
  packageVersion: string | undefined;
  network: string;
  /** Default upstream timeout in ms. */
  snTimeoutMs: number;
  /** Upstream timeout for /api/wait and wallet recovery in ms. */
  snLongTimeoutMs: number;
  /** CONSENSUSCLIENT package setting (nimbus, teku, lighthouse, prysm): where Rocket Pool keys go. */
  consensusClient: string | undefined;
  /** DAPPMANAGER WAMP router. */
  wampUrl: string;
  /** Reconcile loop interval in ms. */
  reconcileIntervalMs: number;
  /** DNS names accepted in the Host header of /api/* requests (IP literals and localhost always are). */
  allowedHostnames: string[];
  /** Max concurrent long-running proxy requests (/api/wait, wallet recover, …). */
  longRequestLimit: number;
  /** Max concurrent daemon log reads (/api/avado/logs, status). */
  logReadLimit: number;
}

function num(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dataDir = env.DATA_DIR || "/rocketpool/data";
  return {
    port: num(env.PORT, 80),
    host: env.HOST || "0.0.0.0",
    uiDir: env.UI_DIR || "/usr/local/ui",
    snApi: (env.SN_API || "http://127.0.0.1:8280").replace(/\/+$/, ""),
    dataDir,
    backupDir: env.BACKUP_DIR || path.join(path.dirname(dataDir), "backups"),
    reconcileStatusFile: env.RECONCILE_STATUS_FILE || "/tmp/reconcile-status.json",
    reconcileTriggerFile: env.RECONCILE_TRIGGER_FILE || "/tmp/reconcile-now",
    daemonLogFile: env.DAEMON_LOG_FILE || "/var/log/rocketpool/daemon.log",
    startupErrorFile: env.STARTUP_ERROR_FILE || "/tmp/rocketpool-startup-error.txt",
    supervisorSocket: env.SUPERVISOR_SOCKET || "/dev/shm/supervisor.sock",
    daemonProgram: env.DAEMON_PROGRAM || "rocketpool-node",
    packageVersion: env.PACKAGE_VERSION || undefined,
    network: env.NETWORK || "mainnet",
    snTimeoutMs: num(env.SN_TIMEOUT_MS, 120_000),
    snLongTimeoutMs: num(env.SN_LONG_TIMEOUT_MS, 60 * 60_000),
    consensusClient: env.CONSENSUSCLIENT || undefined,
    wampUrl: env.WAMP_URL || "ws://wamp.my.ava.do:8080/ws",
    reconcileIntervalMs: num(env.RECONCILE_INTERVAL_MS, 5 * 60_000),
    allowedHostnames: [
      ...DEFAULT_ALLOWED_HOSTNAMES,
      ...(env.EXTRA_ALLOWED_HOSTS || "")
        .split(",")
        .map((h) => h.trim().toLowerCase())
        .filter(Boolean),
    ],
    longRequestLimit: num(env.LONG_REQUEST_LIMIT, 20),
    logReadLimit: num(env.LOG_READ_LIMIT, 4),
  };
}
