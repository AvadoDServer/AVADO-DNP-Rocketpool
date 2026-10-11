import { createHash } from "node:crypto";
import { constants, type Dir, type Stats } from "node:fs";
import { chmod, lstat, mkdir, open, opendir, realpath, rmdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { sha256 } from "../backup";
import { HttpError } from "../http-util";
import { requestReconcileRun } from "../reconcile/api";
import { getProcessState, restartProcess, startProcess } from "./supervisor";

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
/** findWalletsCached reuses a scan for this long. */
export const FOUND_WALLET_CACHE_MS = 10_000;
const MAX_WALLET_BYTES = 64 * 1024;
const MAX_PASSWORD_BYTES = 4096;
const MAX_ADDRESS_BYTES = 256;
/** Upper bound for any single file adopt copies (keystores and settings are a few KiB). */
const MAX_COPY_FILE_BYTES = 64 * 1024 * 1024;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const SKIP_DIR_NAMES = new Set(["rewards-trees", "node_modules"]);
/** Interrupted backups, and recovery-phrase archives (they hold only the phrase). */
const SKIP_DIR_PREFIXES = [".partial-", "mnemonic-archive-"];
/** Searched first: an automatic backup is where a lost wallet most likely is. */
const FIRST_DIR = "backups";
/** Never follows a symlink, never blocks on a FIFO. */
const OPEN_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

async function lstatOrNull(p: string): Promise<Stats | null> {
  try {
    return await lstat(p);
  } catch {
    return null;
  }
}

type Regular = { kind: "ok"; buf: Buffer; st: Stats } | { kind: "not-file" } | { kind: "too-big" };

/**
 * Reads a regular file through one handle: opened with O_NOFOLLOW|O_NONBLOCK, checked
 * with fstat, then read (at most `max` bytes). What is read is what was checked, even if
 * the path is swapped meanwhile. Throws when it can't be opened (ELOOP for a symlink).
 */
async function readRegular(p: string, max: number): Promise<Regular> {
  const fh = await open(p, OPEN_FLAGS);
  try {
    const st = await fh.stat();
    if (!st.isFile()) return { kind: "not-file" };
    if (st.size > max) return { kind: "too-big" };
    const buf = Buffer.alloc(st.size + 1);
    let total = 0;
    for (;;) {
      const { bytesRead } = await fh.read(buf, total, buf.length - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total === buf.length) return { kind: "too-big" }; // grew while being read
    }
    return { kind: "ok", buf: buf.subarray(0, total), st };
  } finally {
    await fh.close();
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The candidate whose wallet file is `dirAbs/wallet`; null when it is not a usable wallet. */
async function candidate(rootAbs: string, dirAbs: string): Promise<FoundWallet | null> {
  const pw = await lstatOrNull(path.join(dirAbs, "password"));
  if (!pw?.isFile() || pw.size < 1 || pw.size > MAX_PASSWORD_BYTES) return null;
  const w = await readRegular(path.join(dirAbs, "wallet"), MAX_WALLET_BYTES);
  if (w.kind !== "ok") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(w.buf.toString("utf8"));
  } catch {
    return null;
  }
  if (!isObject(parsed) || !isObject(parsed.crypto)) return null;

  let address: string | null = null;
  try {
    const a = await readRegular(path.join(dirAbs, "address"), MAX_ADDRESS_BYTES);
    const text = a.kind === "ok" ? a.buf.toString("utf8").trim() : "";
    if (ADDRESS_RE.test(text)) address = text;
  } catch {
    // no or unreadable address file: the wallet is still offered, without an address
  }
  const validators = await lstatOrNull(path.join(dirAbs, "validators"));
  const dir = path.relative(rootAbs, dirAbs).split(path.sep).join("/");
  return {
    dir,
    address,
    modifiedAt: w.st.mtime.toISOString(),
    hasValidators: validators?.isDirectory() ?? false,
    source: dir.startsWith("backups/") ? "backup" : "other",
  };
}

/**
 * Searches the package volume for Rocket Pool wallets outside the data dir. Only reads:
 * names, sizes and times, the wallet file (to check it is a keystore with a `crypto`
 * object) and the `address` file. `backups/` is searched first. Never follows symlinks,
 * never descends into the data dir, rewards trees, node_modules, interrupted backups or
 * recovery-phrase archives; stops reading directories after FOUND_WALLET_MAX_ENTRIES
 * entries in all, and below FOUND_WALLET_MAX_DEPTH. Wallet files are then checked newest
 * first until 10 usable ones are found. Errors on single entries are skipped.
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

  let visited = 0;
  /** Up to the remaining entry budget of names in dirAbs, sorted; never reads past the cap. */
  const readNames = async (dirAbs: string): Promise<string[]> => {
    const names: string[] = [];
    let d: Dir;
    try {
      d = await opendir(dirAbs);
    } catch {
      return names;
    }
    try {
      while (visited < FOUND_WALLET_MAX_ENTRIES) {
        const e = await d.read();
        if (!e) break;
        visited++;
        names.push(e.name);
      }
    } catch {
      // unreadable mid-way: keep what was read
    } finally {
      await d.close().catch(() => undefined);
    }
    return names.sort();
  };

  const wallets: { dirAbs: string; mtimeMs: number }[] = [];
  // `depth` is the depth of the entries inside dirAbs: the root's own entries are depth 1
  const walk = async (dirAbs: string, depth: number): Promise<void> => {
    let names = await readNames(dirAbs);
    if (dirAbs === rootAbs && names.includes(FIRST_DIR)) names = [FIRST_DIR, ...names.filter((n) => n !== FIRST_DIR)];
    for (const name of names) {
      const abs = path.join(dirAbs, name);
      const st = await lstatOrNull(abs);
      if (!st) continue;
      if (name === "wallet" && st.isFile()) {
        if (st.size <= MAX_WALLET_BYTES) wallets.push({ dirAbs, mtimeMs: st.mtimeMs });
        continue;
      }
      if (!st.isDirectory() || depth >= FOUND_WALLET_MAX_DEPTH) continue;
      if (skip.has(abs) || SKIP_DIR_NAMES.has(name) || SKIP_DIR_PREFIXES.some((p) => name.startsWith(p))) continue;
      await walk(abs, depth + 1);
    }
  };
  await walk(rootAbs, 1);

  wallets.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.dirAbs < b.dirAbs ? -1 : a.dirAbs > b.dirAbs ? 1 : 0));
  const found: FoundWallet[] = [];
  for (const w of wallets) {
    if (found.length >= FOUND_WALLET_MAX_RESULTS) break;
    try {
      const c = await candidate(rootAbs, w.dirAbs);
      if (c) found.push(c);
    } catch {
      // vanished or unreadable: skipped
    }
  }
  // newest first by the mtime read through the handle (the same as the lstat one unless it changed)
  return found.sort((a, b) =>
    a.modifiedAt !== b.modifiedAt ? (a.modifiedAt < b.modifiedAt ? 1 : -1) : a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0,
  );
}

let scanCache: { key: string; promise: Promise<FoundWallet[]>; doneAt?: number } | undefined;

/**
 * findWallets for the status poll: one scan at a time, and a finished scan is reused for
 * FOUND_WALLET_CACHE_MS. Adopting always runs a fresh findWallets.
 */
export function findWalletsCached(opts: { volumeRoot: string; dataDir: string }): Promise<FoundWallet[]> {
  const key = JSON.stringify([opts.volumeRoot, opts.dataDir]);
  const c = scanCache;
  if (c && c.key === key && (c.doneAt === undefined || Date.now() - c.doneAt < FOUND_WALLET_CACHE_MS)) return c.promise;
  const entry: NonNullable<typeof scanCache> = { key, promise: findWallets(opts).catch(() => []) };
  void entry.promise.then(() => {
    entry.doneAt = Date.now();
  });
  scanCache = entry;
  return entry.promise;
}

export function clearFoundWalletsCache(): void {
  scanCache = undefined;
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
/**
 * The key check is asked to run again this long after the restart: the run right after
 * the restart may still find the daemon starting, and the next scheduled one is 5 min away.
 */
export const ADOPT_TRIGGER_RETRY_MS = [45_000, 120_000] as const;

export const ADOPT_NOT_LISTED = "That wallet is not on the list any more. Reload the page and try again.";
export const ADOPT_ALREADY_HAS_WALLET = "This AVADO already has a Rocket Pool wallet. Nothing was changed.";
export const ADOPT_BUSY = "A wallet is already being put back. Wait a minute and reload the page.";

export interface AdoptResult {
  dir: string;
  copied: string[];
  restarted: boolean;
  restartError?: string;
}

export interface AdoptOptions {
  volumeRoot: string;
  dataDir: string;
  supervisorSocket: string;
  daemonProgram: string;
  reconcileTriggerFile: string;
  now?: Date;
  /** Wall-clock limit for stopping the daemon (default RESTART_STOP_DEADLINE_MS, 70 s). */
  restartStopDeadlineMs?: number;
  /** Runs the later checks (ADOPT_TRIGGER_RETRY_MS); default: an unref'd setTimeout. */
  schedule?: (fn: () => Promise<void>, ms: number) => void;
  /** Where the later checks report what they did. */
  log?: (msg: string) => void;
  /** Tests only: called after each file or folder this call creates. */
  onCreated?: (p: string) => void | Promise<void>;
}

/** A copy failure with a plain-language reason for the owner. */
class AdoptError extends Error {}

type Created = { path: string; dir: boolean };
interface CopyCtx {
  created: Created[];
  onCreated?: (p: string) => void | Promise<void>;
}

async function recordCreated(ctx: CopyCtx, p: string, dir: boolean): Promise<void> {
  ctx.created.push({ path: p, dir });
  await ctx.onCreated?.(p);
}

/**
 * Copies one regular file, never overwriting ('wx'), from the bytes read through a single
 * O_NOFOLLOW handle, and verifies the copy against them. A byte-identical file already at
 * `dest` counts as done (returns false); anything else already there is a conflict.
 * `mode` defaults to the source's permissions.
 */
async function copyOneFile(src: string, dest: string, rel: string, mode: number | undefined, ctx: CopyCtx): Promise<boolean> {
  let r: Regular;
  try {
    r = await readRegular(src, MAX_COPY_FILE_BYTES);
  } catch {
    throw new AdoptError(`${rel} in the found wallet could not be read`);
  }
  if (r.kind === "not-file") throw new AdoptError(`${rel} in the found wallet is not a regular file`);
  if (r.kind === "too-big") throw new AdoptError(`${rel} in the found wallet is too big`);
  const hash = createHash("sha256").update(r.buf).digest("hex");
  const perms = mode ?? r.st.mode & 0o777;

  const existing = await lstatOrNull(dest);
  if (existing) {
    if (existing.isFile() && (await sha256(dest)) === hash) return false;
    throw new AdoptError(
      existing.isFile()
        ? `a different ${rel} is already in the data folder`
        : `something else named ${rel} is already in the data folder`,
    );
  }
  try {
    await writeFile(dest, r.buf, { flag: "wx", mode: 0o600 });
  } catch (err) {
    // 'wx' failing with anything but EEXIST may leave a half-written file of ours: undo removes it
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") ctx.created.push({ path: dest, dir: false });
    throw err;
  }
  await recordCreated(ctx, dest, false);
  await chmod(dest, perms);
  if ((await sha256(dest)) !== hash) throw new AdoptError(`the copy of ${rel} does not match the original`);
  return true;
}

/**
 * Copies a directory tree file by file into `dest` (created, or an existing directory to
 * fill), skipping symlinks and special files. Returns true when anything was created.
 */
async function copyTree(src: string, dest: string, rel: string, ctx: CopyCtx): Promise<boolean> {
  const st = await lstat(src);
  if (st.isSymbolicLink()) return false;
  if (st.isFile()) return copyOneFile(src, dest, rel, undefined, ctx);
  if (!st.isDirectory()) return false;
  const existing = await lstatOrNull(dest);
  let any = false;
  if (!existing) {
    await mkdir(dest, { mode: 0o700 });
    await recordCreated(ctx, dest, true);
    any = true;
  } else if (!existing.isDirectory()) {
    throw new AdoptError(`something else named ${rel} is already in the data folder`);
  }
  let names: string[];
  try {
    names = await readDirNames(src);
  } catch {
    throw new AdoptError(`${rel} in the found wallet could not be read`);
  }
  for (const name of names) {
    if (await copyTree(path.join(src, name), path.join(dest, name), `${rel}/${name}`, ctx)) any = true;
  }
  // the source's permissions, applied last so a read-only source dir can still be filled
  if (!existing) await chmod(dest, st.mode & 0o777);
  return any;
}

async function readDirNames(dir: string): Promise<string[]> {
  const names: string[] = [];
  const d = await opendir(dir);
  try {
    for (let e = await d.read(); e; e = await d.read()) names.push(e.name);
  } finally {
    await d.close().catch(() => undefined);
  }
  return names.sort();
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

/** Supervisord states in which the daemon is down and nothing will start it again. */
const DAEMON_DOWN_STATES = new Set(["STOPPED", "EXITED", "FATAL"]);

/**
 * Runs ADOPT_TRIGGER_RETRY_MS after adopting: if the daemon is down (the restart's start
 * can be lost when the stop took longer than its deadline), starts it, then asks the key
 * check to run again. Never throws.
 */
async function laterCheck(opts: AdoptOptions, ms: number, trigger: () => Promise<unknown>): Promise<void> {
  const log = opts.log ?? (() => undefined);
  const after = `${Math.round(ms / 1000)}s after putting the wallet back`;
  try {
    const st = await getProcessState(opts.supervisorSocket, opts.daemonProgram);
    if (DAEMON_DOWN_STATES.has(st.state)) {
      const r = await startProcess(opts.supervisorSocket, opts.daemonProgram);
      log(
        r.ok
          ? `${after}: the daemon was ${st.state}, started it`
          : `${after}: the daemon was ${st.state}, starting it failed: ${r.error ?? "unknown"}`,
      );
    } else {
      log(`${after}: the daemon is ${st.state}${st.error ? ` (${st.error})` : ""}`);
    }
  } catch (err) {
    log(`${after}: checking the daemon failed: ${String((err as Error)?.message ?? err)}`);
  }
  await trigger();
  log(`${after}: asked the key check to run`);
}

/** One adopt at a time per process (a double click, a second tab). */
let adoptInFlight = false;

/**
 * POST /api/avado/wallet/adopt {dir}: copies a found wallet back into the data dir.
 * `dir` must be one of the candidates of a fresh findWallets() run (no path is ever built
 * from the request otherwise). Copies, never moves and never overwrites; the source is
 * only read. Every copied file is verified byte for byte; on any failure exactly what
 * this call created is removed again. Then restarts the daemon (a restart failure is
 * reported, never thrown) and asks the key check to run: right after the restart, and
 * again after ADOPT_TRIGGER_RETRY_MS so one run finds the daemon up with the wallet.
 */
export async function adoptFoundWallet(opts: AdoptOptions, body: unknown): Promise<AdoptResult> {
  const b = (typeof body === "object" && body !== null && !Array.isArray(body) ? body : {}) as { dir?: unknown };
  if (typeof b.dir !== "string") throw new HttpError(400, ADOPT_NOT_LISTED);
  if (adoptInFlight) throw new HttpError(409, ADOPT_BUSY);
  adoptInFlight = true;
  try {
    return await adopt(opts, b.dir);
  } finally {
    adoptInFlight = false;
  }
}

async function adopt(opts: AdoptOptions, want: string): Promise<AdoptResult> {
  const match = (await findWallets(opts)).find((w) => w.dir === want);
  if (!match) throw new HttpError(400, ADOPT_NOT_LISTED);
  if (await lstatOrNull(path.join(opts.dataDir, "wallet"))) throw new HttpError(409, ADOPT_ALREADY_HAS_WALLET);

  const ctx: CopyCtx = { created: [], onCreated: opts.onCreated };
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
      if (await copyOneFile(s, path.join(opts.dataDir, name), name, mode, ctx)) copied.push(name);
      done.add(name);
    }
    if (!done.has("wallet") || !done.has("password")) throw new AdoptError("the wallet or its password file is gone");
    for (const name of ADOPT_DIRS) {
      const s = path.join(src, name);
      if (!(await lstatOrNull(s))?.isDirectory()) continue;
      if (await copyTree(s, path.join(opts.dataDir, name), name, ctx)) copied.push(name);
    }
  } catch (err) {
    const clean = await undo(ctx.created, madeDataDir, opts.dataDir);
    throw new HttpError(
      500,
      `Putting the wallet back failed: ${plainReason(err)}. ` +
        (clean ? "Nothing was changed." : "Some copied files could not be removed again."),
    );
  }
  clearFoundWalletsCache();

  let restarted = false;
  let restartError: string | undefined;
  try {
    const r = await restartProcess(opts.supervisorSocket, opts.daemonProgram, opts.restartStopDeadlineMs);
    restarted = r.ok;
    if (!r.ok) restartError = r.error ?? "restart failed";
  } catch (err) {
    restartError = String((err as Error)?.message ?? err);
  }

  // after the restart, so the run does not see the old wallet-less daemon; again later,
  // when the daemon is up (the loop deletes the file each time it picks it up)
  const trigger = () => requestReconcileRun(opts).catch(() => undefined);
  await trigger();
  const schedule =
    opts.schedule ?? ((fn: () => Promise<void>, ms: number) => void setTimeout(() => void fn(), ms).unref());
  for (const ms of ADOPT_TRIGGER_RETRY_MS) schedule(() => laterCheck(opts, ms, trigger), ms);

  return { dir: match.dir, copied, restarted, ...(restartError !== undefined ? { restartError } : {}) };
}
