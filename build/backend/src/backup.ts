import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { cp, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";

/**
 * Shared wallet backup. Copies (never moves) the hot wallet, its password, the
 * validator keystores and the legacy plaintext `mnemonic` (if present) into
 * <backupDir>/<UTC timestamp>-<reason>/ and verifies every copied file byte for byte.
 * The originals are only read. Throws when the backup is incomplete; a partial
 * backup directory is removed so it is never mistaken for a good one.
 */

export const WALLET_BACKUP_ITEMS = ["wallet", "password", "validators", "mnemonic"] as const;
/** Items that must exist for a wallet backup to count. */
const REQUIRED_ITEMS = new Set(["wallet"]);

export interface WalletBackupResult {
  /** Directory name inside backupDir. */
  name: string;
  path: string;
  /** Items that were copied. */
  items: string[];
}

export function utcStamp(date = new Date()): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function listFiles(root: string, rel = ""): Promise<string[]> {
  const abs = path.join(root, rel);
  const st = await stat(abs);
  if (!st.isDirectory()) return [rel];
  const out: string[] = [];
  for (const entry of await readdir(abs)) out.push(...(await listFiles(root, path.join(rel, entry))));
  return out;
}

async function sha256(file: string): Promise<string> {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

export async function createWalletBackup(opts: {
  dataDir: string;
  backupDir: string;
  reason: string;
  now?: Date;
}): Promise<WalletBackupResult> {
  const reason = opts.reason.replace(/[^a-z0-9-]/gi, "-");
  await mkdir(opts.backupDir, { recursive: true, mode: 0o700 });
  const base = `${utcStamp(opts.now)}-${reason}`;
  let name = base;
  for (let i = 2; await exists(path.join(opts.backupDir, name)); i++) name = `${base}-${i}`;
  const target = path.join(opts.backupDir, name);
  await mkdir(target, { mode: 0o700 });

  const copied: string[] = [];
  try {
    for (const item of WALLET_BACKUP_ITEMS) {
      const src = path.join(opts.dataDir, item);
      if (!(await exists(src))) {
        if (REQUIRED_ITEMS.has(item)) throw new Error(`Nothing to back up: ${item} not found`);
        continue;
      }
      const dest = path.join(target, item);
      await cp(src, dest, {
        recursive: true,
        errorOnExist: true,
        force: false,
        preserveTimestamps: true,
        mode: constants.COPYFILE_EXCL,
      });
      // verify every file byte for byte
      const srcFiles = (await listFiles(src)).sort();
      const destFiles = (await listFiles(dest)).sort();
      if (srcFiles.join("\n") !== destFiles.join("\n")) throw new Error(`Backup of ${item} is incomplete`);
      for (const rel of srcFiles) {
        const [a, b] = await Promise.all([sha256(path.join(src, rel)), sha256(path.join(dest, rel))]);
        if (a !== b) throw new Error(`Backup of ${path.join(item, rel)} does not match the original`);
      }
      copied.push(item);
    }
  } catch (err) {
    // only ever removes the directory this call just created, never the originals
    await rm(target, { recursive: true, force: true });
    throw err;
  }
  return { name, path: target, items: copied };
}

export interface BackupInfo {
  name: string;
  createdAt: string;
  kind: "wallet-change" | "upgrade";
}

/** Lists backup directories, newest first. Only names and times; never contents. */
export async function listBackups(backupDir: string): Promise<BackupInfo[]> {
  let entries: string[];
  try {
    entries = await readdir(backupDir);
  } catch {
    return [];
  }
  const out: BackupInfo[] = [];
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    try {
      const st = await stat(path.join(backupDir, name));
      if (!st.isDirectory()) continue;
      out.push({
        name,
        createdAt: st.mtime.toISOString(),
        kind: name.includes("before-wallet-change") ? "wallet-change" : "upgrade",
      });
    } catch {
      // vanished while listing
    }
  }
  return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
}
