import assert from "node:assert/strict";
import net from "node:net";
import { after, before, test } from "node:test";
import { DEFAULT_ALLOWED_HOSTNAMES, isAllowedHost } from "../src/host";
import { startHarness, type Harness } from "./helpers";

let h: Harness;
before(async () => (h = await startHarness({ EXTRA_ALLOWED_HOSTS: "rp.example.lan" })));
after(async () => h.close());

test("isAllowedHost: box names, IP literals and localhost pass; anything else fails", () => {
  const names = [...DEFAULT_ALLOWED_HOSTNAMES];
  for (const ok of [
    "rocketpool.my.ava.do",
    "rocketpool.my.ava.do:80",
    "ROCKETPOOL.MY.AVA.DO",
    "rocketpool.my.ava.do.",
    "rocketpool.avado.dnp.dappnode.eth",
    "my.rocketpool.avado.dnp.dappnode.eth",
    "DAppNodePackage-rocketpool.avado.dnp.dappnode.eth",
    "rocketpool.avado.dappnode",
    "rocketpool.avado.avado",
    "localhost",
    "localhost:8080",
    "127.0.0.1",
    "127.0.0.1:18080",
    "10.191.0.1",
    "192.168.1.20:80",
    "[::1]",
    "[::1]:80",
    "[fe80::1]:8080",
  ]) {
    assert.equal(isAllowedHost(ok, names), true, ok);
  }
  for (const bad of [
    undefined,
    "",
    "evil.example",
    "evil.example:80",
    "rocketpool.my.ava.do.evil.example",
    "evil-rocketpool.my.ava.do",
    "my.ava.do",
    "rocketpool.my.ava.do:8080",
    "rocketpool.my.ava.do@evil.example",
    "10.191.0.1.nip.io",
    "999.1.1.1",
    "[::1",
    "[not-an-ip]",
    "localhost.evil.example",
    "rocketpool.avadopackage.com",
  ]) {
    assert.equal(isAllowedHost(bad, names), false, String(bad));
  }
});

test("reviewer repro: DNS-rebound POST node/withdraw-eth is refused before anything else", async () => {
  const r = await h.request("POST", "/api/sn/node/withdraw-eth", {
    headers: {
      Host: "evil.example",
      Origin: "http://evil.example",
      "X-Avado-Request": "1",
      "Sec-Fetch-Site": "same-origin",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "amount=1000000000000000000",
  });
  assert.equal(r.status, 421);
  assert.equal(h.calls.length, 0);
});

test("DNS-rebound wallet/export is refused", async () => {
  const r = await h.request("POST", "/api/sn/wallet/export", {
    headers: {
      Host: "evil.example:80",
      Origin: "http://evil.example",
      "X-Avado-Request": "1",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ typedConfirmation: "EXPORT" }),
  });
  assert.equal(r.status, 421);
  assert.equal(h.calls.length, 0);
});

test("DNS-rebound reads are refused too (GET, own endpoints included)", async () => {
  for (const p of ["/api/sn/node/status", "/api/avado/status", "/api/avado/logs", "/api/avado/reconcile", "/api/nope"]) {
    const r = await h.request("GET", p, { headers: { Host: "evil.example" } });
    assert.equal(r.status, 421, p);
  }
  assert.equal(h.calls.length, 0);
});

test("the box's own names pass, with a matching Origin for writes", async () => {
  const g = await h.request("GET", "/api/sn/node/status", { headers: { Host: "rocketpool.my.ava.do" } });
  assert.equal(g.status, 200);
  const p = await h.request("POST", "/api/sn/node/set-timezone", {
    headers: {
      Host: "rocketpool.my.ava.do:80",
      Origin: "http://rocketpool.my.ava.do:80",
      "X-Avado-Request": "1",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ timezoneLocation: "Etc/UTC" }),
  });
  assert.equal(p.status, 200);
  const extra = await h.request("GET", "/api/sn/node/status", { headers: { Host: "rp.example.lan" } });
  assert.equal(extra.status, 200);
});

test("a request without a Host header is refused", async () => {
  const raw = await new Promise<string>((resolve) => {
    const s = net.connect(Number(new URL(h.base).port), "127.0.0.1", () =>
      s.write("GET /api/sn/node/status HTTP/1.0\r\n\r\n"),
    );
    let data = "";
    s.on("data", (c) => (data += c));
    s.on("end", () => resolve(data));
  });
  assert.match(raw, /^HTTP\/1\.[01] (421|400)/);
});

test("the static UI is not affected by the Host check", async () => {
  const r = await h.request("GET", "/", { headers: { Host: "evil.example" } });
  assert.equal(r.status, 200);
});
