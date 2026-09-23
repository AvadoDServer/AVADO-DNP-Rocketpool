/**
 * Which keys belong to this Rocket Pool node, and where each one's execution-layer
 * rewards must go (spec §4.3, research §2.3; Smartnode rocketpool/node/manage-fee-recipient.go).
 *
 *  - in the smoothing pool, or in the opt-out cooldown: every key → smoothing pool
 *  - otherwise a minipool key → the node's fee distributor
 *  - otherwise a megapool key → the megapool
 *
 * For a node with only minipools or only megapool validators this equals Smartnode's
 * global fee recipient; for a mixed node outside the smoothing pool it is Smartnode's
 * global value plus its per-key override for megapool keys. (Smartnode skips the
 * override during the opt-out cooldown and lets megapool keys pay the megapool while the
 * global value is still the smoothing pool; we keep every key on the smoothing pool until
 * the cooldown ends, as the spec says.)
 */
import { normalizeAddress, normalizePubkey } from "./hex";

export type KeyKind = "minipool" | "megapool";

export interface WantedKey {
  pubkey: string;
  kind: KeyKind;
  /** Minipool address or megapool validator id, for the UI. */
  ref: string;
}

export interface FeeRecipientInfo {
  smoothingPoolAddress: string | null;
  feeDistributorAddress: string | null;
  megapoolAddress: string | null;
  isInSmoothingPool: boolean;
  isInOptOutCooldown: boolean;
}

export type FeeRecipientRule = "smoothing-pool" | "fee-distributor" | "megapool";

export interface FeeRecipientTarget {
  rule: FeeRecipientRule;
  /** null when Smartnode did not report a usable (non-zero) address for the rule. */
  address: string | null;
}

const obj = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** Reads feeRecipientInfo from a node/status response. */
export function parseFeeRecipientInfo(nodeStatus: unknown): FeeRecipientInfo {
  const f = obj(obj(nodeStatus).feeRecipientInfo);
  return {
    smoothingPoolAddress: normalizeAddress(f.smoothingPoolAddress),
    feeDistributorAddress: normalizeAddress(f.feeDistributorAddress),
    megapoolAddress: normalizeAddress(f.megapoolAddress),
    isInSmoothingPool: f.isInSmoothingPool === true,
    isInOptOutCooldown: f.isInOptOutCooldown === true,
  };
}

export function feeRecipientFor(kind: KeyKind, info: FeeRecipientInfo): FeeRecipientTarget {
  if (info.isInSmoothingPool || info.isInOptOutCooldown) {
    return { rule: "smoothing-pool", address: info.smoothingPoolAddress };
  }
  if (kind === "minipool") return { rule: "fee-distributor", address: info.feeDistributorAddress };
  return { rule: "megapool", address: info.megapoolAddress };
}

/** Minipool statuses whose validator key must be loaded. Dissolved and finalised ones are left alone. */
const LIVE_MINIPOOL_STATUSES = new Set(["Initialized", "Prelaunch", "Staking", "Withdrawable"]);

/**
 * The node's Rocket Pool validator keys that should be validating:
 *  - node/status `.minipools[]`: not finalised, not dissolved
 *  - megapool/status `.megapoolDetails.validators[]`: not exited, not dissolved
 * Entries without a valid pubkey are ignored. A pubkey listed twice keeps its first entry.
 */
export function wantedKeys(nodeStatus: unknown, megapoolStatus: unknown): WantedKey[] {
  const out = new Map<string, WantedKey>();
  const minipools = obj(nodeStatus).minipools;
  if (Array.isArray(minipools)) {
    for (const m of minipools) {
      const mp = obj(m);
      const pubkey = normalizePubkey(mp.validatorPubkey);
      if (!pubkey || mp.finalised === true) continue;
      const status = obj(mp.status).status;
      if (typeof status !== "string" || !LIVE_MINIPOOL_STATUSES.has(status)) continue;
      if (!out.has(pubkey)) out.set(pubkey, { pubkey, kind: "minipool", ref: String(mp.address ?? "") });
    }
  }
  const validators = obj(obj(megapoolStatus).megapoolDetails).validators;
  if (Array.isArray(validators)) {
    for (const v of validators) {
      const mv = obj(v);
      const pubkey = normalizePubkey(mv.pubKey);
      if (!pubkey || mv.exited === true || mv.dissolved === true) continue;
      if (!out.has(pubkey)) out.set(pubkey, { pubkey, kind: "megapool", ref: String(mv.validatorId ?? "") });
    }
  }
  return [...out.values()];
}
