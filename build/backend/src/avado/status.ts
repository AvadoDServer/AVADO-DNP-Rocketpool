import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { listBackups, type BackupInfo } from "../backup";
import type { Config } from "../config";
import type { Limiter } from "../http-util";
import { redact } from "../log";
import { recentErrors } from "./logs";
import { getProcessState, type ProcessState } from "./supervisor";

export const SUPPORTED_NETWORKS = ["mainnet"];

export interface AvadoStatus {
  packageVersion: string | null;
  network: string;
  networkSupported: boolean;
  daemon: ProcessState;
  /** Smartnode's HTTP API answers /healthz. */
  apiReachable: boolean;
  apiTokenPresent: boolean;
  /** Startup problem reported by the start script (bad config, unsupported network), redacted. */
  startupError: string | null;
  daemonErrors: string[];
  backups: BackupInfo[];
  walletFilePresent: boolean;
  passwordFilePresent: boolean;
  /** The legacy plaintext recovery phrase file from the old package is still in the data dir. */
  legacyMnemonicPresent: boolean;
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

async function readSmall(p: string): Promise<string | null> {
  try {
    const text = (await readFile(p, "utf8")).trim();
    return text ? text.slice(0, 4000) : null;
  } catch {
    return null;
  }
}

async function healthz(snApi: string): Promise<boolean> {
  try {
    const res = await fetch(`${snApi}/healthz`, { signal: AbortSignal.timeout(1500), redirect: "error" });
    await res.body?.cancel();
    return res.ok;
  } catch {
    return false;
  }
}

async function limitedErrors(file: string, limiter: Limiter): Promise<string[]> {
  // under load the error lines are skipped rather than queued
  if (!limiter.try()) return [];
  try {
    return await recentErrors(file);
  } finally {
    limiter.release();
  }
}

export async function getAvadoStatus(config: Config, logLimiter: Limiter): Promise<AvadoStatus> {
  const d = config.dataDir;
  const [daemon, apiReachable, apiTokenPresent, startupError, daemonErrors, backups, wallet, password, mnemonic, marker] =
    await Promise.all([
      getProcessState(config.supervisorSocket, config.daemonProgram),
      healthz(config.snApi),
      isFile(path.join(d, "api-tokens.json")),
      readSmall(config.startupErrorFile),
      limitedErrors(config.daemonLogFile, logLimiter),
      listBackups(config.backupDir),
      isFile(path.join(d, "wallet")),
      isFile(path.join(d, "password")),
      isFile(path.join(d, "mnemonic")),
      readSmall(path.join(d, ".avado-package-version")),
    ]);
  return {
    packageVersion: config.packageVersion ?? marker,
    network: config.network,
    networkSupported: SUPPORTED_NETWORKS.includes(config.network),
    daemon,
    apiReachable,
    apiTokenPresent,
    startupError: startupError === null ? null : redact(startupError),
    daemonErrors,
    backups,
    walletFilePresent: wallet,
    passwordFilePresent: password,
    legacyMnemonicPresent: mnemonic,
  };
}
