/**
 * Explicit allow-list of Smartnode v1.24.2 API routes the AVADO UI may call.
 *
 * Keys are paths below /api/ (the UI calls /api/sn/<key>, the backend forwards to
 * <SN_API>/api/<key>). "R" routes are GET only, "W" routes (transactions or secrets)
 * are POST only and are forwarded as application/x-www-form-urlencoded.
 *
 * Source: rocketpool/api/*\/routes.go at v1.24.2 and research §3.3.
 * Deliberately NOT listed (anything else is 404):
 *   - service/terminate-data-folder (deletes the data dir)
 *   - wallet/masquerade, wallet/end-masquerade (writes an `address` file that switches the wallet mode)
 *   - wallet/test-recover, wallet/test-search-and-recover (take the mnemonic in a GET query)
 *   - wallet/set-ens-name, wallet/estimate-gas-set-ens-name
 *   - node/sign, node/send-message, node/can-send-message (arbitrary signing / calldata)
 *   - node/burn, node/*swap-rpl*, node/create-vacant-minipool, node/claim-rpl-rewards (legacy / unused)
 *   - minipool stake, promote, dissolve, change-withdrawal-creds, import-key, vanity, verify-performance
 *   - megapool challenge-performance, dissolve-with-proof, verify-performance (oDAO duties)
 *   - network generate-rewards-tree, dao-proposals; queue process/assign-deposits
 *   - the odao, pdao, auction, security, debug and upgrade groups (governance is out of scope)
 *   - write routes the AVADO UI never calls (their read routes stay): node/send, node/send-all
 *     and node/sign-message (hot-wallet drain / arbitrary signing), node/set-rpl-withdrawal-address,
 *     megapool stake, reduce-bond and dissolve-validator, minipool refund and rescue-dissolved,
 *     minipool/delegate-upgrade and the megapool/minipool set-use-latest-delegate setters,
 *     node/set-timezone, node/confirm-primary-withdrawal-address,
 *     node/confirm-rpl-withdrawal-address, node/initialize-fee-distributor,
 *     node/withdraw-rpl-v131, node/set-rpl-locking-allowed, node/set-stake-rpl-for-allowed,
 *     megapool/notify-validator-exit, megapool/notify-final-balance (the daemon sends these
 *     two itself), service/restart-vc, wallet/rebuild, node/wait-and-stake-rpl and
 *     network/download-rewards-file (the daemon downloads rewards trees itself). Every write that stays listed is one the UI sends
 *     (checked against AVADO-Client-UI rocketpool-app and rp-simple); any other LAN device
 *     gets nothing more.
 */

export type RouteKind = "R" | "W";

export interface RouteSpec {
  kind: RouteKind;
  /** Upstream may block for a long time (wait for a tx, wallet recovery). */
  long?: boolean;
  /** Never log anything about the response of this route (it carries secrets). */
  secret?: boolean;
}

const R: RouteSpec = { kind: "R" };
const W: RouteSpec = { kind: "W" };
const R_LONG: RouteSpec = { kind: "R", long: true };
const W_LONG: RouteSpec = { kind: "W", long: true };

export const ALLOWED_ROUTES: Readonly<Record<string, RouteSpec>> = Object.freeze({
  // meta
  version: R,
  wait: R_LONG,

  // wallet
  "wallet/status": R,
  "wallet/recovery-status": R,
  "wallet/set-password": { kind: "W", secret: true },
  "wallet/init": { kind: "W", secret: true },
  "wallet/recover": { kind: "W", long: true, secret: true },
  "wallet/search-and-recover": { kind: "W", long: true, secret: true },
  "wallet/export": { kind: "W", secret: true },

  // node: status and meta
  "node/status": R,
  "node/sync": R,
  "node/alerts": R,
  "node/get-eth-balance": R,
  "node/check-collateral": R,
  "node/resolve-ens-name": R,
  "node/reverse-resolve-ens-name": R,

  // node: registration, timezone, withdrawal addresses
  "node/can-register": R,
  "node/register": W,
  "node/can-set-timezone": R,
  "node/can-set-primary-withdrawal-address": R,
  "node/set-primary-withdrawal-address": W,
  "node/can-confirm-primary-withdrawal-address": R,
  "node/can-set-rpl-withdrawal-address": R,
  "node/can-confirm-rpl-withdrawal-address": R,

  // node: smoothing pool and fee distributor
  "node/get-smoothing-pool-registration-status": R,
  "node/can-set-smoothing-pool-status": R,
  "node/set-smoothing-pool-status": W,
  "node/is-fee-distributor-initialized": R,
  "node/get-initialize-fee-distributor-gas": R,
  "node/can-distribute": R,
  "node/distribute": W,

  // node: RPL
  "node/stake-rpl-allowance": R,
  "node/can-stake-rpl": R,
  "node/get-stake-rpl-approval-gas": R,
  "node/stake-rpl-approve-rpl": W,
  "node/stake-rpl": W,
  "node/can-unstake-rpl": R,
  "node/unstake-rpl": W,
  "node/can-unstake-legacy-rpl": R,
  "node/unstake-legacy-rpl": W,
  "node/can-withdraw-rpl": R,
  "node/withdraw-rpl": W,
  "node/can-withdraw-rpl-v131": R,
  "node/can-set-rpl-locking-allowed": R,
  "node/can-set-stake-rpl-for-allowed": R,

  // node: megapool deposits and express tickets
  "node/get-bond-requirement": R,
  "node/get-express-ticket-count": R,
  "node/get-express-tickets-provisioned": R,
  "node/can-provision-express-tickets": R,
  "node/provision-express-tickets": W,
  "node/can-deposit": R,
  // long: Smartnode creates and saves the validator keys (4 keystore formats each) and
  // sends the transaction before it answers. The backend must still see that answer, or
  // the new keys are never recorded as approved for loading (sn/proxy.ts).
  "node/deposit": W_LONG,

  // node: rewards, credit, sending
  "node/rewards": R,
  "node/get-rewards-info": R,
  "node/can-claim-rewards": R,
  "node/claim-rewards": W,
  "node/can-claim-and-stake-rewards": R,
  "node/claim-and-stake-rewards": W,
  "node/can-claim-unclaimed-rewards": R,
  "node/claim-unclaimed-rewards": W,
  "node/can-withdraw-credit": R,
  "node/withdraw-credit": W,
  "node/can-withdraw-eth": R,
  "node/withdraw-eth": W,
  "node/can-send": R,

  // megapool
  "megapool/status": R,
  "megapool/validator-map-and-balances": R,
  "megapool/get-new-validator-bond-requirement": R,
  "megapool/pending-rewards": R,
  "megapool/calculate-rewards": R,
  "megapool/beacon-withdrawal-queue-estimate": R,
  "megapool/get-delegate": R,
  "megapool/get-effective-delegate": R,
  "megapool/get-use-latest-delegate": R,
  "megapool/can-stake": R,
  "megapool/can-exit-queue": R,
  "megapool/exit-queue": W,
  "megapool/can-exit-validator": R,
  "megapool/exit-validator": W,
  "megapool/can-notify-validator-exit": R,
  "megapool/can-notify-final-balance": R,
  "megapool/can-distribute": R,
  "megapool/distribute": W,
  "megapool/can-claim-refund": R,
  "megapool/claim-refund": W,
  "megapool/can-repay-debt": R,
  "megapool/repay-debt": W,
  "megapool/can-reduce-bond": R,
  "megapool/can-dissolve-validator": R,
  "megapool/can-delegate-upgrade": R,
  "megapool/delegate-upgrade": W,
  "megapool/can-set-use-latest-delegate": R,

  // minipools (existing fleet)
  "minipool/status": R,
  "minipool/can-exit": R,
  "minipool/exit": W,
  "minipool/get-distribute-balance-details": R,
  "minipool/distribute-balance": W,
  "minipool/get-minipool-close-details-for-node": R,
  "minipool/close": W,
  "minipool/can-refund": R,
  "minipool/get-delegate": R,
  "minipool/get-effective-delegate": R,
  "minipool/get-previous-delegate": R,
  "minipool/get-use-latest-delegate": R,
  "minipool/can-delegate-upgrade": R,
  "minipool/can-set-use-latest-delegate": R,
  "minipool/get-rescue-dissolved-details-for-node": R,

  // network, queue, service
  "network/node-fee": R,
  "network/rpl-price": R,
  "network/stats": R,
  "network/timezone-map": R,
  "network/latest-delegate": R,
  "queue/status": R,
  "queue/get-queue-details": R,
  "service/get-client-status": R,
  "service/get-gas-price-from-latest-block": R,
});

/** Looks up a route key (the part after /api/sn/). Only exact matches count. */
export function lookupRoute(key: string): RouteSpec | undefined {
  return Object.prototype.hasOwnProperty.call(ALLOWED_ROUTES, key) ? ALLOWED_ROUTES[key] : undefined;
}
