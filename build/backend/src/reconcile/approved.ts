/**
 * The "approved to load" list: validator keys the reconcile loop may import into the
 * consensus client on its own. A Rocket Pool key that is missing from the client is only
 * imported when it has an unused approval, because the owner may have moved those
 * validators to another machine on purpose, and loading them here too would get them
 * slashed.
 *
 * Keys get an approval in two ways:
 *  - "deposit": the key was created by this node through the backend (a successful
 *    node/deposit with submit=true answered with validatorPubkeys and a transaction hash)
 *  - "owner":   the owner confirmed it in the UI (POST /api/avado/reconcile/approve)
 *
 * An approval is single-use: once the key is seen loaded in any installed client (or the
 * loop imports it), `loadedAt` is set and the approval no longer allows an import. If the
 * key goes missing later (the owner removed it, perhaps to run it elsewhere), it waits for
 * a new approval; it is never loaded again silently.
 *
 * The file lives on the volume next to the wallet (<dataDir>/.avado-approved-keys.json),
 * not in the backups directory, so backup pruning never touches it. Older package
 * versions ignore it. Entries are never removed. Writes are atomic (temp file + rename)
 * and serialised within the process.
 */
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { normalizePubkey } from "./hex";

export const APPROVED_KEYS_FILE = ".avado-approved-keys.json";

export type ApprovalSource = "deposit" | "owner";

export interface ApprovedEntry {
  source: ApprovalSource;
  approvedAt: string;
  /** The owner approved again while the approval was still unused (resets the retry limit). */
  renewedAt?: string;
  /** When the key was first seen loaded after this approval: the approval is used up. */
  loadedAt?: string;
}

export interface ApprovedFile {
  version: 1;
  keys: Record<string, ApprovedEntry>;
}

export interface ApprovedRead {
  entries: Map<string, ApprovedEntry>;
  /** Set when the file exists but cannot be used; nothing counts as approved then. */
  error?: string;
}

/** The approval allows an import: it exists and has not been used. */
export const isUsable = (e: ApprovedEntry | undefined): boolean => !!e && !e.loadedAt;

export const approvedKeysPath = (dataDir: string) => path.join(dataDir, APPROVED_KEYS_FILE);

const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

async function readFileState(file: string): Promise<{ data: ApprovedFile; error?: string; corrupt: boolean }> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { data: { version: 1, keys: {} }, corrupt: false };
    return { data: { version: 1, keys: {} }, error: `cannot read ${APPROVED_KEYS_FILE}: ${(e as Error).message}`, corrupt: false };
  }
  try {
    const parsed = JSON.parse(raw) as { keys?: unknown };
    const keys: Record<string, ApprovedEntry> = {};
    if (typeof parsed?.keys !== "object" || parsed.keys === null || Array.isArray(parsed.keys)) throw new Error("no keys object");
    for (const [k, v] of Object.entries(parsed.keys as Record<string, unknown>)) {
      const pk = normalizePubkey(k);
      const e = v as Record<string, unknown> | null;
      if (!pk || (e?.source !== "deposit" && e?.source !== "owner")) continue;
      const entry: ApprovedEntry = { source: e.source, approvedAt: str(e.approvedAt) ?? "" };
      if (str(e.renewedAt)) entry.renewedAt = str(e.renewedAt);
      if (str(e.loadedAt)) entry.loadedAt = str(e.loadedAt);
      keys[pk] = entry;
    }
    return { data: { version: 1, keys }, corrupt: false };
  } catch {
    return { data: { version: 1, keys: {} }, error: `${APPROVED_KEYS_FILE} is not valid; treating no key as approved`, corrupt: true };
  }
}

export async function readApprovedKeys(dataDir: string): Promise<ApprovedRead> {
  const s = await readFileState(approvedKeysPath(dataDir));
  return { entries: new Map(Object.entries(s.data.keys)), ...(s.error ? { error: s.error } : {}) };
}

let writeLock: Promise<unknown> = Promise.resolve();

function update(dataDir: string, now: Date, change: (data: ApprovedFile) => number): Promise<number> {
  const run = async () => {
    const file = approvedKeysPath(dataDir);
    const state = await readFileState(file);
    if (state.error && !state.corrupt) throw new Error(state.error);
    // A corrupt file is kept aside, never deleted; starting afresh can only remove approvals.
    if (state.corrupt) await rename(file, `${file}.corrupt-${now.toISOString().replace(/[:.]/g, "")}`);
    const changed = change(state.data);
    if (changed === 0 && !state.corrupt) return 0;
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(state.data, null, 2) + "\n", { mode: 0o600 });
    await rename(tmp, file);
    return changed;
  };
  const p = writeLock.then(run, run);
  writeLock = p.catch(() => undefined);
  return p;
}

/**
 * Approves pubkeys. Returns the number of entries added or changed. Invalid pubkeys are ignored.
 *  - a new key gets a new approval
 *  - "owner" on a used approval: a new approval (the owner confirmed again)
 *  - "owner" on an unused approval: `renewedAt` (lets the loop retry a failed import)
 *  - "deposit" never changes an existing entry
 */
export function addApprovedKeys(dataDir: string, pubkeys: unknown[], source: ApprovalSource, now: Date = new Date()): Promise<number> {
  return update(dataDir, now, (data) => {
    let changed = 0;
    const at = now.toISOString();
    for (const p of new Set(pubkeys.map(normalizePubkey))) {
      if (!p) continue;
      const e = data.keys[p];
      if (!e) data.keys[p] = { source, approvedAt: at };
      else if (source !== "owner") continue;
      else if (e.loadedAt) data.keys[p] = { source: "owner", approvedAt: at };
      else e.renewedAt = at;
      changed++;
    }
    return changed;
  });
}

/**
 * Throws when the approval state could not be saved: writes and removes a probe file next to
 * the list (only the probe this function created is ever removed).
 */
export async function checkApprovalsWritable(dataDir: string): Promise<void> {
  const probe = `${approvedKeysPath(dataDir)}.probe-${process.pid}`;
  await writeFile(probe, "probe\n", { mode: 0o600 });
  await rm(probe, { force: true });
}

/** Marks unused approvals of these keys as used (the keys were seen loaded). */
export function consumeApprovals(dataDir: string, pubkeys: string[], now: Date = new Date()): Promise<number> {
  return update(dataDir, now, (data) => {
    let changed = 0;
    for (const p of pubkeys) {
      const e = data.keys[p];
      if (e && !e.loadedAt) {
        e.loadedAt = now.toISOString();
        changed++;
      }
    }
    return changed;
  });
}
