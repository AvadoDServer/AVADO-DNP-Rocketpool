/**
 * Settling delay (fix round 2, I2): a key is only imported after it has been observed
 * absent from every installed AVADO consensus client continuously for SETTLE_MS. Without
 * slashing-protection history, a pause is the only protection against a key that was
 * signing somewhere a moment ago (for example a client the owner just uninstalled) signing
 * the same epoch again in the new client.
 *
 * "Continuously" means: every run in between saw the key absent in every installed client,
 * every client could be read, and no two observations are more than MAX_OBSERVATION_GAP_MS
 * apart (a longer gap, e.g. the backend was down, restarts the clock). Because the wall
 * clock can jump (NTP right after boot), the key must also have been counted absent in at
 * least MIN_ABSENT_OBSERVATIONS runs that were at least MIN_OBSERVATION_SPACING_MS apart. The observations are
 * persisted (<dataDir>/.avado-key-absence.json) so a backend restart does not reset them.
 * Losing the file only makes the loop wait longer.
 *
 * Keys created by this node's own deposit and never seen in any client are exempt (run.ts).
 */
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { normalizePubkey } from "./hex";

export const ABSENCE_FILE = ".avado-key-absence.json";
export const SETTLE_MS = 20 * 60_000;
export const MAX_OBSERVATION_GAP_MS = 15 * 60_000;
export const MIN_ABSENT_OBSERVATIONS = 4;
/** Observations closer together than this (e.g. trigger runs) count once. */
export const MIN_OBSERVATION_SPACING_MS = 4 * 60_000;

export interface AbsenceEntry {
  absentSince: string;
  lastObservedAt: string;
  /** Consecutive absent observations, counted at most once per MIN_OBSERVATION_SPACING_MS. */
  count: number;
  lastCountedAt: string;
}
export type AbsenceMap = Map<string, AbsenceEntry>;

/** present: loaded in some client; absent: in none, and every client was read; unknown: cannot tell. */
export type Observation = "present" | "absent" | "unknown";

export const absencePath = (dataDir: string) => path.join(dataDir, ABSENCE_FILE);

export async function readAbsence(dataDir: string): Promise<AbsenceMap> {
  const out: AbsenceMap = new Map();
  try {
    const parsed = JSON.parse(await readFile(absencePath(dataDir), "utf8")) as { keys?: Record<string, unknown> };
    for (const [k, v] of Object.entries(parsed?.keys ?? {})) {
      const pk = normalizePubkey(k);
      const e = v as Partial<AbsenceEntry> | null;
      if (!pk || typeof e?.absentSince !== "string" || typeof e?.lastObservedAt !== "string") continue;
      if (Number.isNaN(Date.parse(e.absentSince)) || Number.isNaN(Date.parse(e.lastObservedAt))) continue;
      const count = typeof e.count === "number" && Number.isInteger(e.count) && e.count > 0 ? e.count : 1;
      const lastCountedAt = typeof e.lastCountedAt === "string" && !Number.isNaN(Date.parse(e.lastCountedAt)) ? e.lastCountedAt : e.lastObservedAt;
      out.set(pk, { absentSince: e.absentSince, lastObservedAt: e.lastObservedAt, count, lastCountedAt });
    }
  } catch {
    /* missing or unreadable: no key counts as settled */
  }
  return out;
}

export async function writeAbsence(dataDir: string, map: AbsenceMap): Promise<void> {
  const file = absencePath(dataDir);
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify({ version: 1, keys: Object.fromEntries(map) }, null, 2) + "\n", { mode: 0o600 });
  await rename(tmp, file);
}

/** The new map after this run's observations. Keys that are not observed any more are dropped. */
export function updateAbsence(prev: AbsenceMap, observations: Map<string, Observation>, now: Date): AbsenceMap {
  const next: AbsenceMap = new Map();
  const at = now.toISOString();
  for (const [pk, obs] of observations) {
    if (obs !== "absent") continue;
    const p = prev.get(pk);
    const gap = p ? now.getTime() - Date.parse(p.lastObservedAt) : Infinity;
    if (!p || gap < 0 || gap > MAX_OBSERVATION_GAP_MS) {
      next.set(pk, { absentSince: at, lastObservedAt: at, count: 1, lastCountedAt: at });
      continue;
    }
    const counts = now.getTime() - Date.parse(p.lastCountedAt) >= MIN_OBSERVATION_SPACING_MS;
    next.set(pk, {
      absentSince: p.absentSince,
      lastObservedAt: at,
      count: counts ? p.count + 1 : p.count,
      lastCountedAt: counts ? at : p.lastCountedAt,
    });
  }
  return next;
}

/** When the key may be imported (absent for SETTLE_MS), or null when it is not being observed absent. */
export function settlesAt(entry: AbsenceEntry | undefined): Date | null {
  return entry ? new Date(Date.parse(entry.absentSince) + SETTLE_MS) : null;
}

/** Absent long enough: SETTLE_MS of wall-clock time AND MIN_ABSENT_OBSERVATIONS spaced observations. */
export function isSettled(entry: AbsenceEntry | undefined, now: Date): boolean {
  const at = settlesAt(entry);
  return !!entry && !!at && at.getTime() <= now.getTime() && entry.count >= MIN_ABSENT_OBSERVATIONS;
}
