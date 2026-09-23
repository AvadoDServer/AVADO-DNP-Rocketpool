import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import { after, before, test } from "node:test";
import { startHarness, type Harness } from "./helpers";

let h: Harness;
before(async () => (h = await startHarness()));
after(async () => h.close());

const JSON_CT = { "Content-Type": "application/json" };

test("POST without the X-Avado-Request header is 403 and not forwarded", async () => {
  const r = await h.request("POST", "/api/sn/node/register", { headers: { ...JSON_CT, Origin: h.base }, body: "{}" });
  assert.equal(r.status, 403);
  assert.equal(h.calls.length, 0);
});

test("a wrong header value is 403", async () => {
  const r = await h.post("/api/sn/node/register", {}, { "X-Avado-Request": "yes" });
  assert.equal(r.status, 403);
});

test("a foreign Origin is 403", async () => {
  const r = await h.post("/api/sn/node/register", {}, { Origin: "http://evil.example" });
  assert.equal(r.status, 403);
  const r2 = await h.post("/api/sn/node/register", {}, { Origin: "null" });
  assert.equal(r2.status, 403);
});

test("a foreign Referer without Origin is 403", async () => {
  const r = await h.request("POST", "/api/sn/node/register", {
    headers: { ...JSON_CT, "X-Avado-Request": "1", Referer: "http://evil.example/page" },
    body: "{}",
  });
  assert.equal(r.status, 403);
});

test("Sec-Fetch-Site cross-site is 403", async () => {
  const r = await h.post("/api/sn/node/register", {}, { "Sec-Fetch-Site": "cross-site" });
  assert.equal(r.status, 403);
  assert.equal(h.calls.length, 0);
});

test("same-origin POST with the header passes", async () => {
  const r = await h.post("/api/sn/node/register", { timezoneLocation: "Etc/UTC" }, { "Sec-Fetch-Site": "same-origin" });
  assert.equal(r.status, 200);
  assert.equal(h.calls.length, 1);
});

test("the header with no Origin/Referer (non-browser client) passes", async () => {
  const r = await h.request("POST", "/api/sn/node/register", {
    headers: { ...JSON_CT, "X-Avado-Request": "1" },
    body: "{}",
  });
  assert.equal(r.status, 200);
});

test("own POST endpoints are guarded too: reconcile/run without the header does nothing", async () => {
  const r = await h.request("POST", "/api/avado/reconcile/run", { headers: JSON_CT });
  assert.equal(r.status, 403);
  await assert.rejects(stat(h.config.reconcileTriggerFile));
  const r2 = await h.post("/api/avado/reconcile/run", {}, { Origin: "http://evil.example" });
  assert.equal(r2.status, 403);
  await assert.rejects(stat(h.config.reconcileTriggerFile));
});

test("GET does not need the header; the server never sends CORS headers", async () => {
  const r = await h.request("GET", "/api/sn/node/status", { headers: { Origin: "http://evil.example" } });
  assert.equal(r.status, 200);
  assert.equal(r.headers["access-control-allow-origin"], undefined);
});
