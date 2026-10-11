import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { listBackups, type BackupInfo } from "../backup";
import type { Config } from "../config";
import type { Limiter } from "../http-util";
import { redact } from "../log";
import { findWallets, type FoundWallet } from "./found-wallet";
import { recentErrors } from "./logs";
import { readAutoTxSettings, type AutoTxSettings } from "./settings";
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
  /**
   * Wallets found elsewhere on the package volume (backups, old layouts), newest first.
   * Only searched while the data dir has no wallet; [] otherwise and on any scan failure.
   */
  foundWallets: FoundWallet[];
  /**
   * Automatic-transaction settings the daemon actually runs with, read from the
   * rendered Smartnode settings file. Omitted (not null) when that file can't be
   * read or parsed, so a rendering or upgrade hiccup never fails the status call.
   */
  settings?: AutoTxSettings;
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

/** readAutoTxSettings already treats every failure as "return null"; this is a defensive belt-and-braces layer so a future change there can never fail the whole status call. */
async function safeAutoTxSettings(settingsFile: string): Promise<AutoTxSettings | null> {
  try {
    return await readAutoTxSettings(settingsFile);
  } catch {
    return null;
  }
}

/** findWallets already skips what it can't read; this makes sure a scan problem never fails the status call. */
async function safeFindWallets(config: Config): Promise<FoundWallet[]> {
  try {
    return await findWallets({ volumeRoot: config.volumeRoot, dataDir: config.dataDir });
  } catch {
    return [];
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
  const [daemon, apiReachable, apiTokenPresent, startupError, daemonErrors, backups, wallet, password, mnemonic, marker, settings] =
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
      safeAutoTxSettings(config.settingsFile),
    ]);
  const foundWallets = wallet ? [] : await safeFindWallets(config);
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
    foundWallets,
    ...(settings ? { settings } : {}),
  };
}
