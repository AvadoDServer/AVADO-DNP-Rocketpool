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
    "/api/sn/node/sign",
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
  await h.post("/api/sn/node/set-timezone", "timezoneLocation=Etc%2FUTC", {
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
