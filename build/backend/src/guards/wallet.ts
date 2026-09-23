import { stat } from "node:fs/promises";
import path from "node:path";
import { HttpError } from "../http-util";

/** Routes that create or replace the node wallet. */
export const WALLET_CHANGE_ROUTES = new Set(["wallet/init", "wallet/recover", "wallet/search-and-recover"]);

/** Parameter carrying the typed confirmation for wallet/export. */
export const EXPORT_CONFIRM_PARAM = "typedConfirmation";
/** What the owner has to type to export the wallet. */
export const EXPORT_CONFIRM_TEXT = "EXPORT";

export interface WalletState {
  walletExists: boolean;
  passwordSet: boolean;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

/**
 * Wallet state from the data dir, combined with Smartnode's view when available.
 * Either source saying "exists" wins: the guard errs on the side of refusing.
 */
export async function readWalletState(
  dataDir: string,
  snStatus: () => Promise<{ walletInitialized?: unknown; passwordSet?: unknown } | null>,
): Promise<WalletState> {
  const [walletFile, passwordFile] = await Promise.all([
    fileExists(path.join(dataDir, "wallet")),
    fileExists(path.join(dataDir, "password")),
  ]);
  let sn: { walletInitialized?: unknown; passwordSet?: unknown } | null = null;
  try {
    sn = await snStatus();
  } catch {
    sn = null;
  }
  return {
    walletExists: walletFile || sn?.walletInitialized === true,
    passwordSet: passwordFile || sn?.passwordSet === true,
  };
}

export interface GuardOutcome {
  /** Parameters to forward upstream (guard-only parameters removed). */
  params: Map<string, string>;
}

/** Shown when someone tries to create or restore a wallet on a node that has one. */
export const WALLET_EXISTS_MESSAGE =
  "This AVADO already has a Rocket Pool wallet. Contact support@ava.do if you need to change it.";

/**
 * Runs the wallet guards for a write route. Throws HttpError to refuse.
 *  - wallet/init, wallet/recover, wallet/search-and-recover: refused (409) whenever a
 *    wallet exists. Replacing a wallet is not supported in this release; no code path
 *    moves, overwrites or deletes the wallet or password files.
 *  - wallet/set-password: refused (409) when a password is already set.
 *  - wallet/export: needs typedConfirmation=EXPORT (400 otherwise).
 */
export async function applyWalletGuards(
  route: string,
  params: Map<string, string>,
  ctx: { walletState: () => Promise<WalletState> },
): Promise<GuardOutcome> {
  const out = new Map(params);
  if (WALLET_CHANGE_ROUTES.has(route)) {
    const state = await ctx.walletState();
    if (state.walletExists) throw new HttpError(409, WALLET_EXISTS_MESSAGE);
    return { params: out };
  }
  if (route === "wallet/set-password") {
    const state = await ctx.walletState();
    if (state.passwordSet) throw new HttpError(409, "A wallet password is already set on this node.");
    return { params: out };
  }
  if (route === "wallet/export") {
    const typed = out.get(EXPORT_CONFIRM_PARAM);
    out.delete(EXPORT_CONFIRM_PARAM);
    if (typed !== EXPORT_CONFIRM_TEXT) {
      throw new HttpError(400, `Exporting the wallet needs the typed confirmation "${EXPORT_CONFIRM_TEXT}".`);
    }
    return { params: out };
  }
  return { params: out };
}
