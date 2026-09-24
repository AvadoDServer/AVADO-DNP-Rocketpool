import { lstat, readdir, readFile, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { ZipFile } from "yazl";
import { createWalletBackup, MANUAL_BACKUP_REASON, NoWalletError } from "../backup";
import type { Config } from "../config";
import { HttpError, type Limiter, readBody } from "../http-util";
import type { Logger } from "../log";

/**
 * POST /api/avado/backups/download — one-click backup download for the owner.
 *
 * Request: `Content-Type: application/json`, body `{"name": "<backup dir name>" | "current"}`.
 * The Host and CSRF guards of every /api route apply (X-Avado-Request: 1, same origin).
 *  - a name: one directory of <backupDir>, looked up in the actual directory listing
 *    (never joined blindly into a path); symlinks and anything that isn't a directory
 *    are refused.
 *  - "current": a fresh backup made now with the shared helper (wallet, password,
 *    validators/, address, custom-keys/, custom-key-passwords, legacy mnemonic; each if
 *    present) into <backupDir>/<ts>-manual-download (kind "manual", keepForever false), then that directory
 *    is sent. Within 60 s of the newest manual backup, that one is sent instead of making
 *    another. Only the 10 newest manual backups are kept; no other kind is ever pruned.
 * Answer: 200 application/zip, streamed from disk, `Content-Disposition: attachment;
 * filename="avado-rocketpool-backup-<first 8 hex of the node address>-<YYYYMMDD>.zip"`.
 * The zip holds README.txt and the backup directory as `<name>/...`.
 * Errors (JSON envelope): 400 bad body, 404 unknown backup / no wallet yet, 415 not JSON,
 * 429 two downloads already running. Contents are never logged, only the directory name.
 */

export const CURRENT_BACKUP = "current";
/** Downloads that may run at the same time. */
export const BACKUP_DOWNLOAD_LIMIT = 2;

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,199}$/;

export const BACKUP_README = `AVADO Rocket Pool backup
========================

This archive is a copy of your Rocket Pool node wallet, made by the Rocket Pool
package on your AVADO. Keep it somewhere safe and private: together, "wallet" and
"password" give full control of your node wallet and its funds.

What is in the folder
---------------------
  wallet                 your node wallet (encrypted with the password below)
  password               the password that decrypts "wallet"
  validators/            the validator keys of your minipools and megapool validators
  address                (only on some nodes) the node address Smartnode uses
  custom-keys/, custom-key-passwords
                         (only if you imported keys) validator keys you added yourself
  mnemonic               (only on older installs) your recovery phrase in plain text
  backup-info.json       when and why this backup was made

How to restore
--------------
On an AVADO: install the Rocket Pool package, then contact support@ava.do. Support
puts "wallet" and "password" (and "validators/") back into the package's data
folder (/rocketpool/data) before the node starts.

With Rocket Pool Smartnode elsewhere: stop the node, copy "wallet" and "password"
(and "validators/") into Smartnode's data folder (by default ~/.rocketpool/data),
then start it. Or recover from your 24-word recovery phrase with
"rocketpool wallet recover".

IMPORTANT: never run the same validator keys on two machines at the same time.
That gets them slashed (a permanent penalty). Stop and remove the validators on the
old machine first.
`;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Files (relative paths) and directories below `root`, without following symlinks. */
async function walk(root: string, rel = ""): Promise<{ files: string[]; dirs: string[] }> {
  const out = { files: [] as string[], dirs: [] as string[] };
  for (const entry of (await readdir(path.join(root, rel))).sort()) {
    const r = rel ? `${rel}/${entry}` : entry;
    const st = await lstat(path.join(root, r));
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      out.dirs.push(r);
      const sub = await walk(root, r);
      out.files.push(...sub.files);
      out.dirs.push(...sub.dirs);
    } else if (st.isFile()) {
      out.files.push(r);
    }
  }
  return out;
}

/** The named backup directory, only if it really is one of <backupDir>'s directories. */
async function findBackup(backupDir: string, name: string): Promise<string> {
  const unknown = new HttpError(404, "There is no backup with that name.");
  if (!NAME_RE.test(name)) throw unknown;
  let entries: string[];
  try {
    entries = await readdir(backupDir);
  } catch {
    throw unknown;
  }
  const match = entries.find((e) => e === name);
  if (!match) throw unknown;
  const dir = path.join(backupDir, match);
  const st = await lstat(dir).catch(() => null);
  if (!st || st.isSymbolicLink() || !st.isDirectory()) throw unknown;
  return match;
}

export function downloadFileName(nodeAddress: string | undefined, now = new Date()): string {
  const hex = typeof nodeAddress === "string" && /^0x[0-9a-fA-F]{40}$/.test(nodeAddress) && !/^0x0{40}$/.test(nodeAddress)
    ? nodeAddress.slice(2, 10).toLowerCase()
    : "unknown";
  const date = now.toISOString().slice(0, 10).replace(/-/g, "");
  return `avado-rocketpool-backup-${hex}-${date}.zip`;
}

/** Shared by all downloads of one app: which backup dirs are being streamed, and a lock for "current". */
export interface DownloadState {
  streaming: Map<string, number>;
  currentLock: Promise<unknown>;
}

export function createDownloadState(): DownloadState {
  return { streaming: new Map(), currentLock: Promise.resolve() };
}

/** Within this long after a manual backup, "current" streams that one instead of making another. */
export const CURRENT_REUSE_MS = 60_000;
/** Newest manual (download) backups kept; older manual ones are pruned. No other kind is ever pruned here. */
export const MANUAL_BACKUP_KEEP = 10;

const MANUAL_NAME = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-manual-download(?:-(\d+))?$/;

/** The backend's own manual backups (name pattern and backup-info kind both say so), newest first. */
async function manualBackups(backupDir: string): Promise<{ name: string; at: number }[]> {
  let entries: string[];
  try {
    entries = await readdir(backupDir);
  } catch {
    return [];
  }
  const out: { name: string; at: number; seq: number }[] = [];
  for (const name of entries) {
    const m = MANUAL_NAME.exec(name);
    if (!m) continue;
    const st = await lstat(path.join(backupDir, name)).catch(() => null);
    if (!st || st.isSymbolicLink() || !st.isDirectory()) continue;
    try {
      const info = JSON.parse(await readFile(path.join(backupDir, name, "backup-info.json"), "utf8")) as { kind?: unknown };
      if (info.kind !== "manual") continue;
    } catch {
      continue;
    }
    out.push({ name, at: Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!), seq: m[7] ? +m[7] : 1 });
  }
  return out.sort((a, b) => b.at - a.at || b.seq - a.seq);
}

/** Removes manual backups beyond the newest MANUAL_BACKUP_KEEP (never one being streamed, never another kind). */
async function pruneManualBackups(backupDir: string, state: DownloadState, logger: Logger): Promise<void> {
  const all = await manualBackups(backupDir);
  for (const b of all.slice(MANUAL_BACKUP_KEEP)) {
    if (state.streaming.has(b.name)) continue;
    try {
      await rm(path.join(backupDir, b.name), { recursive: true, force: true });
      logger.info(`backup download: pruned old manual backup ${b.name}`);
    } catch (e) {
      logger.warn(`backup download: could not prune ${b.name}: ${String((e as NodeJS.ErrnoException)?.code ?? e)}`);
    }
  }
}

/** A fresh manual backup, or the newest one if it is less than CURRENT_REUSE_MS old. Serialised. */
function currentBackup(config: Config, state: DownloadState, logger: Logger, now: Date): Promise<string> {
  const run = async (): Promise<string> => {
    const newest = (await manualBackups(config.backupDir))[0];
    const age = newest ? now.getTime() - newest.at : Infinity;
    if (newest && age >= 0 && age < CURRENT_REUSE_MS) {
      logger.info(`backup download: reusing the backup made ${Math.round(age / 1000)} s ago, ${newest.name}`);
      return newest.name;
    }
    let name: string;
    try {
      const b = await createWalletBackup({
        dataDir: config.dataDir,
        backupDir: config.backupDir,
        reason: MANUAL_BACKUP_REASON,
        info: { kind: "manual", reason: "download", keepForever: false },
        now,
      });
      name = b.name;
    } catch (e) {
      if (e instanceof NoWalletError) throw new HttpError(404, "There is no wallet to back up yet.");
      throw e;
    }
    logger.info(`backup download: made a fresh backup ${name}`);
    await pruneManualBackups(config.backupDir, state, logger);
    return name;
  };
  const p = state.currentLock.then(run, run);
  state.currentLock = p.catch(() => undefined);
  return p;
}

export async function handleBackupDownload(
  req: IncomingMessage,
  res: ServerResponse,
  deps: {
    config: Config;
    logger: Logger;
    limiter: Limiter;
    state: DownloadState;
    /** The node address, for the file name; undefined when the daemon can't say. */
    nodeAddress: () => Promise<string | undefined>;
    now?: () => Date;
  },
): Promise<void> {
  const { config, logger, limiter, state } = deps;
  const now = () => deps.now?.() ?? new Date();
  const type = (req.headers["content-type"] || "").split(";")[0]!.trim().toLowerCase();
  if (type !== "application/json") throw new HttpError(415, "Use application/json");
  let body: unknown;
  try {
    body = JSON.parse((await readBody(req)).toString("utf8"));
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, "Invalid JSON body");
  }
  const name = isObject(body) ? body.name : undefined;
  if (typeof name !== "string" || name === "") throw new HttpError(400, 'Send {"name": "<backup name>"} or {"name": "current"}.');

  if (!limiter.try()) throw new HttpError(429, "Two backup downloads are already running. Please try again shortly.");
  let released = false;
  let streamingDir: string | undefined;
  const release = () => {
    if (released) return;
    released = true;
    limiter.release();
    if (streamingDir !== undefined) {
      const n = (state.streaming.get(streamingDir) ?? 1) - 1;
      if (n > 0) state.streaming.set(streamingDir, n);
      else state.streaming.delete(streamingDir);
    }
  };
  // the slot is freed whenever the connection goes away, however far this request got
  res.once("close", release);
  /** The browser is gone: nothing more to do. */
  const gone = () => res.destroyed || req.socket?.destroyed === true;
  try {
    const dirName = name === CURRENT_BACKUP ? await currentBackup(config, state, logger, now()) : await findBackup(config.backupDir, name);
    if (gone()) return release();
    streamingDir = dirName;
    state.streaming.set(dirName, (state.streaming.get(dirName) ?? 0) + 1);

    const root = path.join(config.backupDir, dirName);
    const { files, dirs } = await walk(root);
    const address = await deps.nodeAddress().catch(() => undefined);
    const fileName = downloadFileName(address, now());
    if (gone()) return release();

    const zip = new ZipFile();
    const mtime = now();
    zip.addBuffer(Buffer.from(BACKUP_README, "utf8"), "README.txt", { mtime, mode: 0o100644 });
    zip.addEmptyDirectory(dirName, { mtime });
    for (const d of dirs) zip.addEmptyDirectory(`${dirName}/${d}`);
    for (const f of files) zip.addFile(path.join(root, f), `${dirName}/${f}`);
    zip.end();

    res.writeHead(200, {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${fileName}"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    const fail = (what: string) => {
      logger.error(`backup download of ${dirName} failed: ${what}`);
      release();
      res.destroy();
    };
    zip.on("error", (e) => fail(String((e as NodeJS.ErrnoException).code ?? "read error")));
    zip.outputStream.on("error", () => fail("stream error"));
    zip.outputStream.pipe(res);
    logger.info(`backup download: ${dirName} (${files.length} files)`);
  } catch (e) {
    release();
    throw e;
  }
}
