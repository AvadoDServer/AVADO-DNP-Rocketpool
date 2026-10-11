import { constants, type Stats } from "node:fs";
import { chmod, copyFile, lstat, mkdir, open, readdir, realpath, rm, rmdir } from "node:fs/promises";
import path from "node:path";
import { sha256 } from "../backup";
import { HttpError } from "../http-util";
import { requestReconcileRun } from "../reconcile/api";
import { restartProcess } from "./supervisor";

/**
 * A Rocket Pool wallet found on the package volume outside the data dir: in an
 * automatic backup (backups/legacy-<ts>/wallet), in an old layout (wallet,
 * .rocketpool/data/wallet, data-old/…), anywhere within reach. Offered in the status
 * while the data dir has no wallet, so the owner can put it back with one click.
 */
export interface FoundWallet {
  /** Directory holding the wallet, relative to the volume root, "/"-separated, e.g. "backups/legacy-20261006T200006Z" or "data-old". */
  dir: string;
  /** From a sibling `address` file when it is 0x + 40 hex (any case); else null. Never derived by decrypting. */
  address: string | null;
  /** Wallet file mtime, ISO. */
  modifiedAt: string;
  /** A sibling `validators` directory exists. */
  hasValidators: boolean;
  /** Where it was found: "backup" when dir starts with "backups/", else "other". */
  source: "backup" | "other";
}

export const FOUND_WALLET_MAX_DEPTH = 6;
export const FOUND_WALLET_MAX_ENTRIES = 5000;
/** At most this many candidates are reported (the newest). */
export const FOUND_WALLET_MAX_RESULTS = 10;
const MAX_WALLET_BYTES = 64 * 1024;
const MAX_PASSWORD_BYTES = 4096;
const MAX_ADDRESS_BYTES = 256;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const SKIP_DIR_NAMES = new Set(["rewards-trees", "node_modules"]);
/** Interrupted backups, and recovery-phrase archives (they hold only the phrase). */
const SKIP_DIR_PREFIXES = [".partial-", "mnemonic-archive-"];

async function lstatOrNull(p: string): Promise<Stats | null> {
  try {
    return await lstat(p);
  } catch {
    return null;
  }
}

/** Reads at most `max` bytes; refuses a symlink (O_NOFOLLOW). Null when the file is bigger than `max`. */
async function readCapped(p: string, max: number): Promise<Buffer | null> {
  const fh = await open(p, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const buf = Buffer.alloc(max + 1);
    const { bytesRead } = await fh.read(buf, 0, max + 1, 0);
    return bytesRead > max ? null : buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

/** The candidate in `dirAbs` whose `wallet` entry has stats `st`; null when it is not a usable wallet. */
async function candidate(rootAbs: string, dirAbs: string, st: Stats): Promise<FoundWallet | null> {
  if (!st.isFile() || st.size > MAX_WALLET_BYTES) return null;
  const pw = await lstatOrNull(path.join(dirAbs, "password"));
  if (!pw?.isFile() || pw.size < 1 || pw.size > MAX_PASSWORD_BYTES) return null;
  const raw = await readCapped(path.join(dirAbs, "wallet"), MAX_WALLET_BYTES);
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    return null;
  }
  const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  if (!isObject(parsed) || !isObject(parsed.crypto)) return null;

  let address: string | null = null;
  const addr = await lstatOrNull(path.join(dirAbs, "address"));
  if (addr?.isFile() && addr.size <= MAX_ADDRESS_BYTES) {
    try {
      const text = (await readCapped(path.join(dirAbs, "address"), MAX_ADDRESS_BYTES))?.toString("utf8").trim();
      if (text && ADDRESS_RE.test(text)) address = text;
    } catch {
      // unreadable address file: the wallet is still offered, without an address
    }
  }
  const validators = await lstatOrNull(path.join(dirAbs, "validators"));
  const dir = path.relative(rootAbs, dirAbs).split(path.sep).join("/");
  return {
    dir,
    address,
    modifiedAt: st.mtime.toISOString(),
    hasValidators: validators?.isDirectory() ?? false,
    source: dir.startsWith("backups/") ? "backup" : "other",
  };
}

/**
 * Searches the package volume for Rocket Pool wallets outside the data dir. Only reads:
 * names, sizes and times, the wallet file (to check it is a keystore with a `crypto`
 * object) and the `address` file. Never follows symlinks, never descends into the data
 * dir, rewards trees, node_modules, interrupted backups or recovery-phrase archives,
 * stops quietly after FOUND_WALLET_MAX_ENTRIES entries or below FOUND_WALLET_MAX_DEPTH.
 * Errors on single entries are skipped. Newest wallet first, at most 10.
 */
export async function findWallets(opts: { volumeRoot: string; dataDir: string }): Promise<FoundWallet[]> {
  let rootAbs: string;
  try {
    rootAbs = await realpath(opts.volumeRoot);
    if (!(await lstat(rootAbs)).isDirectory()) return [];
  } catch {
    return [];
  }
  const skip = new Set([path.resolve(opts.dataDir)]);
  try {
    skip.add(await realpath(opts.dataDir));
  } catch {
    // no data dir: nothing there to skip
  }

  const found: FoundWallet[] = [];
  let visited = 0;
  // `depth` is the depth of the entries inside dirAbs: the root's own entries are depth 1
  const walk = async (dirAbs: string, depth: number): Promise<void> => {
    let names: string[];
    try {
      names = (await readdir(dirAbs)).sort();
    } catch {
      return;
    }
    for (const name of names) {
      if (visited >= FOUND_WALLET_MAX_ENTRIES) return;
      visited++;
      const abs = path.join(dirAbs, name);
      const st = await lstatOrNull(abs);
      if (!st) continue;
      if (name === "wallet" && st.isFile()) {
        try {
          const c = await candidate(rootAbs, dirAbs, st);
          if (c) found.push(c);
        } catch {
          // vanished or unreadable: skipped
        }
        continue;
      }
      if (!st.isDirectory() || depth >= FOUND_WALLET_MAX_DEPTH) continue;
      if (skip.has(abs) || SKIP_DIR_NAMES.has(name) || SKIP_DIR_PREFIXES.some((p) => name.startsWith(p))) continue;
      await walk(abs, depth + 1);
    }
  };
  await walk(rootAbs, 1);

  return found
    .sort((a, b) =>
      a.modifiedAt !== b.modifiedAt ? (a.modifiedAt < b.modifiedAt ? 1 : -1) : a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0,
    )
    .slice(0, FOUND_WALLET_MAX_RESULTS);
}

/** Files copied from the found wallet's directory, with the mode each gets, in this order. */
const ADOPT_FILES: ReadonlyArray<readonly [string, number]> = [
  ["wallet", 0o600],
  ["password", 0o600],
  ["address", 0o644],
  ["custom-key-passwords", 0o600],
  ["transactions.json", 0o600],
];
/** Directories copied recursively after the files. */
const ADOPT_DIRS = ["validators", "custom-keys"] as const;
/** The daemon's stopwaitsecs is 60 (build/supervisord.conf): leave it time to stop. */
const ADOPT_RESTART_TIMEOUT_MS = 75_000;

export const ADOPT_NOT_LISTED = "That wallet is not on the list any more. Reload the page and try again.";
export const ADOPT_ALREADY_HAS_WALLET = "This AVADO already has a Rocket Pool wallet. Nothing was changed.";

export interface AdoptResult {
  dir: string;
  copied: string[];
  restarted: boolean;
  restartError?: string;
}

/** A copy failure with a plain-language reason for the owner. */
class AdoptError extends Error {}

type Created = { path: string; dir: boolean };

/**
 * Copies one regular file, never overwriting (COPYFILE_EXCL), and verifies it byte for
 * byte. A byte-identical file already at `dest` counts as done (returns false); anything
 * else already there is a conflict. Records what it created in `created`.
 */
async function copyOneFile(src: string, dest: string, rel: string, mode: number | undefined, created: Created[]): Promise<boolean> {
  const existing = await lstatOrNull(dest);
  if (existing) {
    if (existing.isFile() && (await sha256(src)) === (await sha256(dest))) return false;
    throw new AdoptError(
      existing.isFile()
        ? `a different ${rel} is already in the data folder`
        : `something else named ${rel} is already in the data folder`,
    );
  }
  try {
    await copyFile(src, dest, constants.COPYFILE_EXCL);
  } catch (err) {
    // with COPYFILE_EXCL anything but EEXIST means a half-written file of ours may be there
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") await rm(dest, { force: true });
    throw err;
  }
  created.push({ path: dest, dir: false });
  if (mode !== undefined) await chmod(dest, mode);
  if ((await sha256(src)) !== (await sha256(dest))) throw new AdoptError(`the copy of ${rel} does not match the original`);
  return true;
}

/**
 * Copies a directory tree file by file into `dest` (created, or an existing directory to
 * fill), skipping symlinks and special files. Returns true when anything was created.
 */
async function copyTree(src: string, dest: string, rel: string, created: Created[]): Promise<boolean> {
  const st = await lstat(src);
  if (st.isSymbolicLink()) return false;
  if (st.isFile()) return copyOneFile(src, dest, rel, undefined, created);
  if (!st.isDirectory()) return false;
  const existing = await lstatOrNull(dest);
  let any = false;
  if (!existing) {
    await mkdir(dest, { mode: 0o700 });
    created.push({ path: dest, dir: true });
    any = true;
  } else if (!existing.isDirectory()) {
    throw new AdoptError(`something else named ${rel} is already in the data folder`);
  }
  for (const name of (await readdir(src)).sort()) {
    if (await copyTree(path.join(src, name), path.join(dest, name), `${rel}/${name}`, created)) any = true;
  }
  // the source's permissions, applied last so a read-only source dir can still be filled
  if (!existing) await chmod(dest, st.mode & 0o777);
  return any;
}

/** Removes exactly what this call created, newest first. True when everything is gone. */
async function undo(created: Created[], madeDataDir: string | undefined, dataDir: string): Promise<boolean> {
  let ok = true;
  for (const c of created) if (c.dir) await chmod(c.path, 0o700).catch(() => undefined);
  for (const c of [...created].reverse()) {
    try {
      await (c.dir ? rmdir(c.path) : rm(c.path));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") ok = false;
    }
  }
  if (madeDataDir) {
    // mkdir -p made madeDataDir and everything below it down to dataDir
    for (let d = path.resolve(dataDir); ; d = path.dirname(d)) {
      try {
        await rmdir(d);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") ok = false;
        break;
      }
      if (d === path.resolve(madeDataDir) || d === path.dirname(d)) break;
    }
  }
  return ok;
}

function plainReason(err: unknown): string {
  if (err instanceof AdoptError) return err.message;
  const code = (err as NodeJS.ErrnoException)?.code;
  switch (code) {
    case "ENOSPC":
    case "EDQUOT":
      return "the disk is full";
    case "EACCES":
    case "EPERM":
    case "EROFS":
      return "the data folder cannot be written to";
    case "EEXIST":
      return "a file with the same name appeared in the data folder";
    case "ENOENT":
      return "a file disappeared while it was being copied";
    default:
      return `an unexpected error (${code ?? (err as Error)?.message ?? String(err)})`;
  }
}

/**
 * POST /api/avado/wallet/adopt {dir}: copies a found wallet back into the data dir.
 * `dir` must be one of the candidates of a fresh findWallets() run (no path is ever built
 * from the request otherwise). Copies, never moves and never overwrites; the source is
 * only read. Every copied file is verified byte for byte; on any failure exactly what
 * this call created is removed again. Then asks the key check to run and restarts the
 * daemon; a restart failure is reported, never thrown.
 */
export async function adoptFoundWallet(
  opts: {
    volumeRoot: string;
    dataDir: string;
    supervisorSocket: string;
    daemonProgram: string;
    reconcileTriggerFile: string;
    now?: Date;
    restartTimeoutMs?: number;
  },
  body: unknown,
): Promise<AdoptResult> {
  const b = (typeof body === "object" && body !== null && !Array.isArray(body) ? body : {}) as { dir?: unknown };
  if (typeof b.dir !== "string") throw new HttpError(400, ADOPT_NOT_LISTED);
  const want = b.dir;
  const match = (await findWallets(opts)).find((w) => w.dir === want);
  if (!match) throw new HttpError(400, ADOPT_NOT_LISTED);
  if (await lstatOrNull(path.join(opts.dataDir, "wallet"))) throw new HttpError(409, ADOPT_ALREADY_HAS_WALLET);

  const created: Created[] = [];
  const copied: string[] = [];
  let madeDataDir: string | undefined;
  try {
    const rootAbs = await realpath(opts.volumeRoot);
    const src = match.dir === "" ? rootAbs : path.join(rootAbs, ...match.dir.split("/"));
    madeDataDir = await mkdir(opts.dataDir, { recursive: true });
    const done = new Set<string>();
    for (const [name, mode] of ADOPT_FILES) {
      const s = path.join(src, name);
      if (!(await lstatOrNull(s))?.isFile()) continue; // absent, a symlink or not a file: not copied
      if (await copyOneFile(s, path.join(opts.dataDir, name), name, mode, created)) copied.push(name);
      done.add(name);
    }
    if (!done.has("wallet") || !done.has("password")) throw new AdoptError("the wallet or its password file is gone");
    for (const name of ADOPT_DIRS) {
      const s = path.join(src, name);
      if (!(await lstatOrNull(s))?.isDirectory()) continue;
      if (await copyTree(s, path.join(opts.dataDir, name), name, created)) copied.push(name);
    }
  } catch (err) {
    const clean = await undo(created, madeDataDir, opts.dataDir);
    throw new HttpError(
      500,
      `Putting the wallet back failed: ${plainReason(err)}. ` +
        (clean ? "Nothing was changed." : "Some copied files could not be removed again."),
    );
  }

  try {
    await requestReconcileRun(opts);
  } catch {
    // the loop also runs on its own schedule
  }
  let restarted = false;
  let restartError: string | undefined;
  try {
    const r = await restartProcess(opts.supervisorSocket, opts.daemonProgram, opts.restartTimeoutMs ?? ADOPT_RESTART_TIMEOUT_MS);
    restarted = r.ok;
    if (!r.ok) restartError = r.error ?? "restart failed";
  } catch (err) {
    restartError = String((err as Error)?.message ?? err);
  }
  return { dir: match.dir, copied, restarted, ...(restartError !== undefined ? { restartError } : {}) };
}
