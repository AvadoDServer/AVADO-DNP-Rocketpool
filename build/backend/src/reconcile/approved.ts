/**
 * The "approved to load" list: validator keys the reconcile loop may import into the
 * consensus client on its own. A Rocket Pool key that is missing from the client is only
 * imported when it is on this list, because the owner may have moved those validators to
 * another machine on purpose, and loading them here too would get them slashed.
 *
 * Keys get on the list in two ways:
 *  - "deposit": the key was created by this node through the backend (a successful
 *    node/deposit answered with validatorPubkeys and a transaction hash)
 *  - "owner":   the owner confirmed it in the UI (POST /api/avado/reconcile/approve)
 *
 * The file lives on the volume next to the wallet (<dataDir>/.avado-approved-keys.json),
 * not in the backups directory, so backup pruning never touches it. Older package
 * versions ignore it. Entries are only ever added. Writes are atomic (temp file + rename)
 * and serialised within the process.
 */
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { normalizePubkey } from "./hex";

export const APPROVED_KEYS_FILE = ".avado-approved-keys.json";

export type ApprovalSource = "deposit" | "owner";

export interface ApprovedEntry {
  source: ApprovalSource;
  approvedAt: string;
}

export interface ApprovedFile {
  version: 1;
  keys: Record<string, ApprovedEntry>;
}

export interface ApprovedRead {
  keys: Set<string>;
  /** Set when the file exists but cannot be used; the list is then treated as empty. */
  error?: string;
}

export const approvedKeysPath = (dataDir: string) => path.join(dataDir, APPROVED_KEYS_FILE);

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
      const e = v as Partial<ApprovedEntry> | null;
      if (!pk || (e?.source !== "deposit" && e?.source !== "owner")) continue;
      keys[pk] = { source: e.source, approvedAt: typeof e.approvedAt === "string" ? e.approvedAt : "" };
    }
    return { data: { version: 1, keys }, corrupt: false };
  } catch {
    return { data: { version: 1, keys: {} }, error: `${APPROVED_KEYS_FILE} is not valid; treating no key as approved`, corrupt: true };
  }
}

export async function readApprovedKeys(dataDir: string): Promise<ApprovedRead> {
  const s = await readFileState(approvedKeysPath(dataDir));
  return { keys: new Set(Object.keys(s.data.keys)), ...(s.error ? { error: s.error } : {}) };
}

let writeLock: Promise<unknown> = Promise.resolve();

/**
 * Adds pubkeys to the list (existing entries keep their source and time). Returns the
 * number of keys newly added. Invalid pubkeys are ignored. A corrupt file is kept aside
 * as `<name>.corrupt-<time>` (never deleted) and a new list is started; that can only
 * shrink the approvals, never widen them.
 */
export function addApprovedKeys(
  dataDir: string,
  pubkeys: unknown[],
  source: ApprovalSource,
  now: Date = new Date(),
): Promise<number> {
  const run = async () => {
    const file = approvedKeysPath(dataDir);
    const state = await readFileState(file);
    if (state.error && !state.corrupt) throw new Error(state.error);
    if (state.corrupt) await rename(file, `${file}.corrupt-${now.toISOString().replace(/[:.]/g, "")}`);
    let added = 0;
    for (const p of pubkeys) {
      const pk = normalizePubkey(p);
      if (!pk || state.data.keys[pk]) continue;
      state.data.keys[pk] = { source, approvedAt: now.toISOString() };
      added++;
    }
    if (added === 0 && !state.corrupt) return 0;
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(state.data, null, 2) + "\n", { mode: 0o600 });
    await rename(tmp, file);
    return added;
  };
  const p = writeLock.then(run, run);
  writeLock = p.catch(() => undefined);
  return p;
}
