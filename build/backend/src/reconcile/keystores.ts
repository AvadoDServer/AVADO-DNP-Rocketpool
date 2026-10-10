/**
 * Reads a validator keystore and its password from Smartnode's data dir. Smartnode writes
 * every key in five layouts under `<dataDir>/validators/` (research §1.2, §2.4;
 * smartnode shared/services/wallet/keystore/*):
 *
 *   teku        keys/0x<pk>.json                    passwords/0x<pk>.txt
 *   nimbus      validators/0x<pk>/keystore.json     secrets/0x<pk>
 *   lighthouse  validators/0x<pk>/voting-keystore.json   secrets/0x<pk>
 *   lodestar    validators/0x<pk>/voting-keystore.json   secrets/0x<pk>
 *   prysm-non-hd  one wallet file for all keys (not an EIP-2335 keystore; not used)
 *
 * The first four are standard EIP-2335 keystores that any client imports through the
 * keymanager API. The chosen client's own layout is tried first, then the others.
 * The password is always taken from the same layout as the keystore, byte for byte
 * (Smartnode decrypts with the file's exact content).
 *
 * Nothing here writes, moves or deletes a file.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ClientId } from "./clients";
import { normalizePubkey, prefixed } from "./hex";

export type LayoutId = "teku" | "nimbus" | "lighthouse" | "lodestar";

interface Layout {
  id: LayoutId;
  keystore: (pk: string) => string;
  password: (pk: string) => string;
}

const LAYOUTS: Record<LayoutId, Layout> = {
  teku: {
    id: "teku",
    keystore: (pk) => path.join("teku", "keys", `${prefixed(pk)}.json`),
    password: (pk) => path.join("teku", "passwords", `${prefixed(pk)}.txt`),
  },
  nimbus: {
    id: "nimbus",
    keystore: (pk) => path.join("nimbus", "validators", prefixed(pk), "keystore.json"),
    password: (pk) => path.join("nimbus", "secrets", prefixed(pk)),
  },
  lighthouse: {
    id: "lighthouse",
    keystore: (pk) => path.join("lighthouse", "validators", prefixed(pk), "voting-keystore.json"),
    password: (pk) => path.join("lighthouse", "secrets", prefixed(pk)),
  },
  lodestar: {
    id: "lodestar",
    keystore: (pk) => path.join("lodestar", "validators", prefixed(pk), "voting-keystore.json"),
    password: (pk) => path.join("lodestar", "secrets", prefixed(pk)),
  },
};

/** Layouts to try for a client, its own first. Prysm's own layout is a wallet, so Teku's comes first there. */
export function layoutOrder(client: ClientId): LayoutId[] {
  const first: LayoutId = client === "prysm" ? "teku" : client;
  return [first, ...(["teku", "nimbus", "lighthouse", "lodestar"] as LayoutId[]).filter((l) => l !== first)];
}

export interface LoadedKeystore {
  layout: LayoutId;
  /** The keystore file as it is on disk (JSON text). */
  keystoreJson: string;
  password: string;
}

export type KeystoreProblem = { problem: "missing" } | { problem: "invalid"; detail: string };

/**
 * Loads the keystore for `pubkey` (96 hex, no 0x). A layout whose keystore is present but
 * does not parse, is for another pubkey, or has no password file is reported as invalid;
 * the next layout is tried. "missing" when no layout has the key.
 */
export async function loadKeystore(
  dataDir: string,
  pubkey: string,
  client: ClientId,
): Promise<LoadedKeystore | KeystoreProblem> {
  if (normalizePubkey(pubkey) !== pubkey) return { problem: "invalid", detail: "not a canonical pubkey" };
  const validatorsDir = path.join(dataDir, "validators");
  const problems: string[] = [];
  for (const id of layoutOrder(client)) {
    const layout = LAYOUTS[id];
    let keystoreJson: string;
    try {
      keystoreJson = await readFile(path.join(validatorsDir, layout.keystore(pubkey)), "utf8");
    } catch {
      continue;
    }
    let parsed: { pubkey?: unknown; crypto?: unknown };
    try {
      parsed = JSON.parse(keystoreJson) as typeof parsed;
    } catch {
      problems.push(`${id}: keystore is not JSON`);
      continue;
    }
    if (normalizePubkey(parsed?.pubkey) !== pubkey) {
      problems.push(`${id}: keystore is for a different key`);
      continue;
    }
    if (typeof parsed.crypto !== "object" || parsed.crypto === null) {
      problems.push(`${id}: keystore has no crypto section`);
      continue;
    }
    let password: string;
    try {
      password = await readFile(path.join(validatorsDir, layout.password(pubkey)), "utf8");
    } catch {
      problems.push(`${id}: password file missing`);
      continue;
    }
    if (password.length === 0) {
      problems.push(`${id}: password file is empty`);
      continue;
    }
    return { layout: id, keystoreJson, password };
  }
  return problems.length ? { problem: "invalid", detail: problems.join("; ") } : { problem: "missing" };
}
