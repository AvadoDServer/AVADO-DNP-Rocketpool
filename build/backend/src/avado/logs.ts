import { open } from "node:fs/promises";
import { redact } from "../log";

const MAX_READ_BYTES = 2 * 1024 * 1024;
export const MAX_TAIL = 2000;
export const DEFAULT_TAIL = 200;

/** Last `n` lines of a file (reads at most the last 2 MiB). Missing file -> null. */
export async function tailFile(file: string, n: number): Promise<string[] | null> {
  let fh;
  try {
    fh = await open(file, "r");
  } catch {
    return null;
  }
  try {
    const { size } = await fh.stat();
    const length = Math.min(size, MAX_READ_BYTES);
    const buf = Buffer.alloc(length);
    await fh.read(buf, 0, length, size - length);
    let lines = buf.toString("utf8").split(/\r?\n/);
    if (length < size) lines = lines.slice(1); // first line is probably cut
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    return lines.slice(-n);
  } finally {
    await fh.close();
  }
}

// strip ANSI colour codes the daemon may emit
const ANSI = /\x1b\[[0-9;]*m/g;

export function cleanLine(line: string): string {
  return redact(line.replace(ANSI, ""));
}

export function parseTail(value: string | null): number {
  const n = Number(value ?? DEFAULT_TAIL);
  if (!Number.isInteger(n) || n <= 0) return DEFAULT_TAIL;
  return Math.min(n, MAX_TAIL);
}

const ERROR_RE = /\b(error|err|fatal|panic|failed)\b/i;

/** The last `max` error-looking lines of the daemon log, redacted. */
export async function recentErrors(file: string, max = 20): Promise<string[]> {
  const lines = await tailFile(file, MAX_TAIL);
  if (!lines) return [];
  return lines
    .map((l) => l.replace(ANSI, ""))
    .filter((l) => ERROR_RE.test(l))
    .slice(-max)
    .map(cleanLine);
}
