import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { ALLOWED_ROUTES, lookupRoute } from "../src/sn/allowlist";
import { startHarness, type Harness } from "./helpers";

let h: Harness;
before(async () => (h = await startHarness()));
after(async () => h.close());

test("unknown and deliberately excluded routes are 404 and never reach Smartnode", async () => {
  for (const p of [
    "/api/sn/does/not-exist",
    "/api/sn/service/terminate-data-folder",
    "/api/sn/wallet/masquerade",
    "/api/sn/wallet/test-recover",
    "/api/sn/wallet/test-search-and-recover",
    "/api/sn/node/sign",
    // write routes the UI never calls
    "/api/sn/node/send",
    "/api/sn/node/send-all",
    "/api/sn/node/sign-message",
    "/api/sn/node/set-rpl-withdrawal-address",
    "/api/sn/megapool/stake",
    "/api/sn/megapool/reduce-bond",
    "/api/sn/megapool/dissolve-validator",
    "/api/sn/megapool/delegate-upgrade",
    "/api/sn/megapool/set-use-latest-delegate",
    "/api/sn/minipool/refund",
    "/api/sn/minipool/delegate-upgrade",
    "/api/sn/minipool/set-use-latest-delegate",
    "/api/sn/minipool/rescue-dissolved",
    "/api/sn/node/set-timezone",
    "/api/sn/node/confirm-primary-withdrawal-address",
    "/api/sn/node/confirm-rpl-withdrawal-address",
    "/api/sn/node/initialize-fee-distributor",
    "/api/sn/node/withdraw-rpl-v131",
    "/api/sn/node/set-rpl-locking-allowed",
    "/api/sn/node/set-stake-rpl-for-allowed",
    "/api/sn/megapool/notify-validator-exit",
    "/api/sn/megapool/notify-final-balance",
    "/api/sn/service/restart-vc",
    "/api/sn/wallet/rebuild",
    "/api/sn/node/wait-and-stake-rpl",
    "/api/sn/network/download-rewards-file",
    "/api/sn/odao/status",
    "/api/sn/constructor",
    "/api/sn/__proto__",
    "/api/sn/node/status/extra",
    "/api/sn/",
    "/api/unknown",
  ]) {
    const r = await h.post(p);
    assert.equal(r.status, 404, p);
    const g = await h.request("GET", p);
    assert.equal(g.status, 404, p);
  }
  assert.equal(h.calls.length, 0);
});

test("lookup only matches own keys", () => {
  assert.equal(lookupRoute("toString"), undefined);
  assert.equal(lookupRoute("hasOwnProperty"), undefined);
  assert.deepEqual(lookupRoute("node/status"), { kind: "R" });
});

test("read routes are GET only, write routes POST only", async () => {
  const r1 = await h.post("/api/sn/node/status");
  assert.equal(r1.status, 405);
  assert.equal(r1.headers.allow, "GET");
  const r2 = await h.request("GET", "/api/sn/node/register");
  assert.equal(r2.status, 405);
  assert.equal(r2.headers.allow, "POST");
  assert.equal(h.calls.length, 0);
});

test("a read is forwarded as GET with its query; /api/sn/x maps to /api/x", async () => {
  h.calls.length = 0;
  const r = await h.request("GET", "/api/sn/node/can-register?timezoneLocation=Europe%2FLjubljana");
  assert.equal(r.status, 200);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0]!.method, "GET");
  assert.equal(h.calls[0]!.path, "/api/node/can-register");
  assert.equal(h.calls[0]!.query, "?timezoneLocation=Europe%2FLjubljana");
});

test("a write is forwarded as POST form-encoded; JSON or form bodies accepted", async () => {
  h.calls.length = 0;
  await h.post("/api/sn/node/register", { timezoneLocation: "Europe/Ljubljana", maxFee: 12.5 });
  await h.post("/api/sn/node/register", "timezoneLocation=Etc%2FUTC", {
    "Content-Type": "application/x-www-form-urlencoded",
  });
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[0]!.method, "POST");
  assert.equal(h.calls[0]!.contentType, "application/x-www-form-urlencoded");
  assert.equal(h.calls[0]!.body, "timezoneLocation=Europe%2FLjubljana&maxFee=12.5");
  assert.equal(h.calls[0]!.query, "");
  assert.equal(h.calls[1]!.body, "timezoneLocation=Etc%2FUTC");
});

test("a write with parameters in the URL, nested JSON or another content type is refused", async () => {
  h.calls.length = 0;
  assert.equal((await h.post("/api/sn/node/register?timezoneLocation=x", {})).status, 400);
  assert.equal((await h.post("/api/sn/node/register", { a: { b: 1 } })).status, 400);
  assert.equal((await h.post("/api/sn/node/register", "x", { "Content-Type": "text/plain" })).status, 415);
  assert.equal(h.calls.length, 0);
});

test("upstream error envelopes and status codes pass through", async () => {
  h.setUpstream(() => ({ status: 500, body: '{"status":"error","error":"node is not registered"}' }));
  const r = await h.request("GET", "/api/sn/node/status");
  assert.equal(r.status, 500);
  assert.deepEqual(r.json, { status: "error", error: "node is not registered" });
  assert.equal(r.headers["cache-control"], "no-store");
});

test("a daemon that is down gives 502", async () => {
  const down = await startHarness({ SN_API: "http://127.0.0.1:1" });
  try {
    const r = await down.request("GET", "/api/sn/node/status");
    assert.equal(r.status, 502);
    assert.equal(r.json.status, "error");
  } finally {
    await down.close();
  }
});

test("every allow-listed route has a valid kind", () => {
  for (const [k, v] of Object.entries(ALLOWED_ROUTES)) {
    assert.ok(v.kind === "R" || v.kind === "W", k);
    assert.match(k, /^[a-z0-9-]+(\/[a-z0-9-]+)?$/, k);
  }
  for (const secret of ["wallet/export", "wallet/init", "wallet/recover", "wallet/set-password"]) {
    assert.equal(ALLOWED_ROUTES[secret]?.secret, true, secret);
  }
  assert.equal(ALLOWED_ROUTES["wait"]?.long, true);
});

test("long routes: waits, wallet recovery, and node/deposit (key generation + tx) get the long timeout", () => {
  for (const r of ["wait", "wallet/recover", "wallet/search-and-recover", "node/deposit"]) {
    assert.equal(ALLOWED_ROUTES[r]?.long, true, r);
  }
  assert.deepEqual(ALLOWED_ROUTES["node/deposit"], { kind: "W", long: true });
});

test("every allow-listed write route is one the UI sends", () => {
  const writes = Object.entries(ALLOWED_ROUTES).filter(([, v]) => v.kind === "W").map(([k]) => k).sort();
  assert.deepEqual(writes, [
    "megapool/claim-refund", "megapool/distribute", "megapool/exit-queue", "megapool/exit-validator", "megapool/repay-debt",
    "minipool/close", "minipool/distribute-balance", "minipool/exit",
    "node/claim-and-stake-rewards", "node/claim-rewards", "node/claim-unclaimed-rewards", "node/deposit", "node/distribute",
    "node/provision-express-tickets", "node/register", "node/set-primary-withdrawal-address", "node/set-smoothing-pool-status",
    "node/stake-rpl", "node/stake-rpl-approve-rpl", "node/unstake-legacy-rpl", "node/unstake-rpl",
    "node/withdraw-credit", "node/withdraw-eth", "node/withdraw-rpl",
    "wallet/export", "wallet/init", "wallet/recover", "wallet/search-and-recover", "wallet/set-password",
  ]);
});

test("the read routes of removed writes stay available", () => {
  for (const r of ["node/can-send", "megapool/can-stake", "megapool/can-reduce-bond", "megapool/can-dissolve-validator", "minipool/can-refund", "node/can-set-rpl-withdrawal-address"]) {
    assert.deepEqual(ALLOWED_ROUTES[r], { kind: "R" }, r);
  }
});
