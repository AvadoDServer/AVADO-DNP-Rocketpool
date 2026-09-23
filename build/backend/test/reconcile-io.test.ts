import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { listInstalledPackages } from "../src/reconcile/clients";
import { createKeymanager } from "../src/reconcile/keymanager";
import { layoutOrder, loadKeystore } from "../src/reconcile/keystores";
import { startLoop, writeStatusFile } from "../src/reconcile/loop";
import { runReconcile, type ReconcileStatus, type RunDeps } from "../src/reconcile/run";
import { WampClient, type WebSocketLike } from "../src/reconcile/wamp";

const pk = (c: string) => c.repeat(96);
const FD = "0x" + "d".repeat(40);

let root: string;
before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "rp-reconcile-"));
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});

// ---------- keymanager over HTTP (a stand-in for the package proxies) ----------

interface Seen {
  method: string;
  url: string;
  contentType?: string;
  body: string;
}

async function keymanagerServer(opts: { nimbusStyle?: boolean; prysmStyle?: boolean } = {}) {
  const seen: Seen[] = [];
  const keys = new Set([pk("1"), pk("f")]);
  const fee = new Map<string, string>([[pk("1"), "0x" + "1".repeat(40)]]);
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const url = req.url ?? "";
      seen.push({ method: req.method ?? "", url, contentType: req.headers["content-type"], body });
      const send = (code: number, v: unknown) => {
        res.writeHead(code, { "Content-Type": "application/json" });
        res.end(typeof v === "string" ? v : JSON.stringify(v));
      };
      // the Deno proxy JSON-parses every non-GET body and fails a bodiless request
      if (opts.nimbusStyle && req.method !== "GET") {
        try {
          JSON.parse(body);
        } catch {
          return send(500, { error: "Unexpected end of JSON input" });
        }
      }
      if (req.method === "GET" && url === "/keymanager/eth/v1/keystores") {
        return send(200, { data: [...keys].map((k) => ({ validating_pubkey: "0x" + k, derivation_path: "", readonly: false })) });
      }
      if (req.method === "GET" && url === "/keymanager/eth/v1/remotekeys") return send(500, "failed");
      if (req.method === "POST" && url === "/keymanager/eth/v1/keystores") {
        const b = JSON.parse(body) as { keystores: string[]; passwords: string[] };
        const k = JSON.parse(b.keystores[0]).pubkey as string;
        keys.add(k);
        return send(200, { data: [{ status: opts.prysmStyle ? "IMPORTED" : "imported", message: "" }] });
      }
      const m = /^\/keymanager\/eth\/v1\/validator\/0x([0-9a-f]{96})\/feerecipient$/.exec(url);
      if (m) {
        if (req.method === "GET") {
          const a = fee.get(m[1]);
          return a ? send(200, { data: { pubkey: "0x" + m[1], ethaddress: a } }) : send(404, { message: "not found" });
        }
        if (req.method === "POST") {
          fee.set(m[1], (JSON.parse(body) as { ethaddress: string }).ethaddress);
          res.writeHead(202);
          return res.end();
        }
      }
      send(404, { message: "no route" });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/keymanager`;
  return { server, base, seen, keys, fee };
}

test("keymanager: JSON bodies on every write, standard paths, 404 fee recipient is null", async () => {
  const km = await keymanagerServer({ nimbusStyle: true });
  try {
    const c = createKeymanager({ baseUrl: km.base });
    assert.deepEqual([...(await c.listKeystores())].sort(), [pk("1"), pk("f")]);
    await assert.rejects(() => c.listRemoteKeys(), /HTTP 500/);
    assert.equal(await c.getFeeRecipient(pk("2")), null);
    assert.equal(await c.getFeeRecipient(pk("1")), "0x" + "1".repeat(40));
    const ks = JSON.stringify({ pubkey: pk("2"), crypto: {} });
    assert.deepEqual(await c.importKeystore(ks, "secret-pw"), { status: "imported", message: "" });
    await c.setFeeRecipient(pk("2"), FD);
    assert.equal(km.fee.get(pk("2")), FD);

    const writes = km.seen.filter((s) => s.method !== "GET");
    assert.equal(writes.length, 2);
    for (const w of writes) assert.equal(w.contentType, "application/json");
    const imp = JSON.parse(writes[0].body);
    assert.deepEqual(Object.keys(imp).sort(), ["keystores", "passwords"], "no slashing_protection: Smartnode has none");
    assert.equal(typeof imp.keystores[0], "string", "keystores are JSON strings");
    assert.deepEqual(imp.passwords, ["secret-pw"]);
    assert.deepEqual(JSON.parse(writes[1].body), { ethaddress: FD });
    assert.equal(writes[1].url, `/keymanager/eth/v1/validator/0x${pk("2")}/feerecipient`);
    assert.ok(km.seen.every((s) => s.method !== "DELETE"));
    assert.ok(km.seen.every((s) => !s.url.includes("?")), "the proxies drop query strings");
  } finally {
    km.server.close();
  }
});

test("keymanager: Prysm's upper-case import status is normalised; errors carry no secret", async () => {
  const km = await keymanagerServer({ prysmStyle: true });
  try {
    const c = createKeymanager({ baseUrl: km.base });
    const r = await c.importKeystore(JSON.stringify({ pubkey: pk("3"), crypto: {} }), "pw");
    assert.equal(r.status, "imported");
  } finally {
    km.server.close();
  }
  const down = createKeymanager({ baseUrl: "http://127.0.0.1:9/keymanager", timeoutMs: 2000 });
  await assert.rejects(
    () => down.importKeystore("{}", "very-secret-password"),
    (e: Error) => /not reachable|no answer/.test(e.message) && !e.message.includes("very-secret-password"),
  );
});

// ---------- keystores on disk ----------

async function writeLayout(dataDir: string, layout: "teku" | "nimbus" | "lighthouse", p: string, opts: { password?: string | null; keyPub?: string } = {}) {
  const v = path.join(dataDir, "validators");
  const ks = JSON.stringify({ crypto: { kdf: {} }, version: 4, uuid: "u", path: "m/12381/3600/0/0/0", pubkey: opts.keyPub ?? p });
  let ksFile: string;
  let pwFile: string;
  if (layout === "teku") {
    ksFile = path.join(v, "teku", "keys", `0x${p}.json`);
    pwFile = path.join(v, "teku", "passwords", `0x${p}.txt`);
  } else {
    ksFile = path.join(v, layout, "validators", `0x${p}`, layout === "nimbus" ? "keystore.json" : "voting-keystore.json");
    pwFile = path.join(v, layout, "secrets", `0x${p}`);
  }
  await mkdir(path.dirname(ksFile), { recursive: true });
  await writeFile(ksFile, ks);
  if (opts.password !== null) {
    await mkdir(path.dirname(pwFile), { recursive: true });
    await writeFile(pwFile, opts.password ?? `pw-${layout}`);
  }
}

test("keystores: the chosen client's layout first, password from the same layout, exact bytes", async () => {
  const d = path.join(root, "ks1");
  await writeLayout(d, "teku", pk("1"), { password: "teku pw \n" });
  await writeLayout(d, "nimbus", pk("1"));
  const n = await loadKeystore(d, pk("1"), "nimbus");
  assert.ok(!("problem" in n));
  assert.equal(n.layout, "nimbus");
  assert.equal(n.password, "pw-nimbus");
  const t = await loadKeystore(d, pk("1"), "prysm");
  assert.ok(!("problem" in t));
  assert.equal(t.layout, "teku");
  assert.equal(t.password, "teku pw \n", "not trimmed: Smartnode uses the exact file content");
  assert.deepEqual(layoutOrder("prysm"), ["teku", "nimbus", "lighthouse", "lodestar"]);
  assert.deepEqual(layoutOrder("lighthouse"), ["lighthouse", "teku", "nimbus", "lodestar"]);
});

test("keystores: a keystore for another key or without password is refused; missing is missing", async () => {
  const d = path.join(root, "ks2");
  await writeLayout(d, "teku", pk("2"), { keyPub: pk("3") });
  await writeLayout(d, "nimbus", pk("2"), { password: null });
  const r = await loadKeystore(d, pk("2"), "teku");
  assert.ok("problem" in r && r.problem === "invalid");
  assert.match((r as { detail: string }).detail, /different key/);
  assert.match((r as { detail: string }).detail, /password file missing/);
  await writeLayout(d, "lighthouse", pk("2"));
  const ok = await loadKeystore(d, pk("2"), "teku");
  assert.ok(!("problem" in ok) && ok.layout === "lighthouse", "falls through to a good layout");
  assert.deepEqual(await loadKeystore(d, pk("4"), "teku"), { problem: "missing" });
  assert.equal(((await loadKeystore(d, "../../etc", "teku")) as { problem: string }).problem, "invalid");
});

// ---------- WAMP / DAPPMANAGER ----------

class FakeSocket implements WebSocketLike {
  static last: FakeSocket;
  static reply: (msg: unknown[]) => unknown[] | null = () => null;
  readyState = 0;
  sent: unknown[][] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor(
    readonly url: string,
    readonly protocols?: string | string[],
  ) {
    FakeSocket.last = this;
    setImmediate(() => {
      this.readyState = 1;
      this.onopen?.({});
    });
  }
  send(data: string) {
    const msg = JSON.parse(data) as unknown[];
    this.sent.push(msg);
    const out = msg[0] === 1 ? [2, 1234, {}] : FakeSocket.reply(msg);
    if (out) setImmediate(() => this.onmessage?.({ data: JSON.stringify(out) }));
  }
  close() {
    this.readyState = 3;
    setImmediate(() => this.onclose?.({}));
  }
}

test("DAPPMANAGER listPackages over WAMP: envelope, running flag per package", async () => {
  FakeSocket.reply = (m) =>
    m[0] === 48
      ? [
          50,
          m[1],
          {},
          [
            JSON.stringify({
              success: true,
              message: "ok",
              result: [
                { name: "teku.avado.dnp.dappnode.eth", running: false },
                { name: "teku.avado.dnp.dappnode.eth", running: true },
                { name: "rocketpool.avado.dnp.dappnode.eth", running: true },
                { nope: 1 },
              ],
            }),
          ],
        ]
      : null;
  const wamp = new WampClient({ url: "ws://wamp.test/ws", realm: "dappnode_admin", WebSocket: FakeSocket });
  const list = await listInstalledPackages(wamp);
  assert.deepEqual(list, [
    { name: "teku.avado.dnp.dappnode.eth", running: true },
    { name: "rocketpool.avado.dnp.dappnode.eth", running: true },
  ]);
  const s = FakeSocket.last;
  assert.deepEqual(s.protocols, ["wamp.2.json"]);
  assert.equal(s.sent[0][1], "dappnode_admin");
  assert.equal(s.sent[1][3], "listPackages.dappmanager.dnp.dappnode.eth");
  wamp.close();
});

test("DAPPMANAGER: success:false and no_such_procedure are errors, never an empty list", async () => {
  FakeSocket.reply = (m) => (m[0] === 48 ? [50, m[1], {}, [JSON.stringify({ success: false, message: "docker down" })]] : null);
  const w1 = new WampClient({ url: "ws://x", realm: "dappnode_admin", WebSocket: FakeSocket });
  await assert.rejects(() => listInstalledPackages(w1), /docker down/);
  w1.close();
  FakeSocket.reply = (m) => (m[0] === 48 ? [8, 48, m[1], {}, "wamp.error.no_such_procedure"] : null);
  const w2 = new WampClient({ url: "ws://x", realm: "dappnode_admin", WebSocket: FakeSocket });
  await assert.rejects(() => listInstalledPackages(w2), (e: Error & { kind?: string }) => e.kind === "unavailable");
  w2.close();
  FakeSocket.reply = () => null;
  const w3 = new WampClient({ url: "ws://x", realm: "dappnode_admin", WebSocket: FakeSocket, callTimeoutMs: 50 });
  await assert.rejects(() => w3.call("listPackages.dappmanager.dnp.dappnode.eth"), /no answer/);
  w3.close();
});

// ---------- end to end: run against HTTP keymanagers and real keystore files ----------

test("end to end: imports into the chosen client from disk, never touches the other client", async () => {
  const d = path.join(root, "e2e");
  await writeLayout(d, "teku", pk("2"), { password: "teku-secret" });
  const teku = await keymanagerServer();
  const nimbus = await keymanagerServer();
  nimbus.keys.clear();
  nimbus.keys.add(pk("3"));
  try {
    const deps: RunDeps = {
      smartnode: {
        async get(route) {
          if (route === "wallet/status") return { walletInitialized: true };
          return {
            registered: true,
            feeRecipientInfo: { smoothingPoolAddress: "0x" + "5".repeat(40), feeDistributorAddress: FD, megapoolAddress: "0x" + "e".repeat(40) },
            minipools: [pk("1"), pk("2"), pk("3")].map((p) => ({ address: "0x", validatorPubkey: p, status: { status: "Staking" } })),
          };
        },
      },
      listPackages: async () => [
        { name: "teku.avado.dnp.dappnode.eth", running: true },
        { name: "nimbus.avado.dnp.dappnode.eth", running: true },
      ],
      keymanagerFor: (c) => createKeymanager({ baseUrl: c.id === "teku" ? teku.base : nimbus.base }),
      loadKeystore: (p, c) => loadKeystore(d, p, c),
      readApproved: async () => ({ keys: new Set([pk("2"), pk("3")]) }),
      configuredClient: "teku",
      importAttempts: new Map(),
      trigger: "request",
    };
    const s = await runReconcile(deps);
    assert.equal(s.keys.summary, "2/3");
    assert.equal(s.validators.find((v) => v.pubkey === pk("3"))!.state, "elsewhere");
    const imports = teku.seen.filter((x) => x.method === "POST" && x.url.endsWith("/keystores"));
    assert.equal(imports.length, 1);
    assert.equal(JSON.parse(JSON.parse(imports[0].body).keystores[0]).pubkey, pk("2"));
    assert.equal(teku.fee.get(pk("1")), FD);
    assert.equal(teku.fee.get(pk("2")), FD);
    assert.ok(!teku.seen.some((x) => x.url.includes(pk("f"))), "the foreign key in Teku is not touched");
    assert.ok(nimbus.seen.every((x) => x.method === "GET"), "the other client is only read");
    assert.ok(!JSON.stringify(s).includes("teku-secret"));
  } finally {
    teku.server.close();
    nimbus.server.close();
  }
});

// ---------- loop: trigger file, status file ----------

test("loop: runs on the trigger file, removes it, writes the status file atomically", async () => {
  const statusFile = path.join(root, "reconcile-status.json");
  const triggerFile = path.join(root, "reconcile-now");
  const triggers: string[] = [];
  const attemptsSeen: number[] = [];
  const loop = startLoop({
    statusFile,
    triggerFile,
    intervalMs: 60 * 60_000,
    startDelayMs: 60 * 60_000,
    triggerPollMs: 20,
    minGapMs: 0,
    log: () => {},
    makeDeps(trigger, importAttempts) {
      triggers.push(trigger);
      attemptsSeen.push(importAttempts.size);
      importAttempts.set("x", 3);
      return {
        deps: {
          smartnode: { get: async () => ({ walletInitialized: false }) },
          listPackages: async () => [],
          keymanagerFor: () => {
            throw new Error("unused");
          },
          loadKeystore: async () => ({ problem: "missing" }),
          readApproved: async () => ({ keys: new Set<string>() }),
          configuredClient: undefined,
          importAttempts,
          trigger,
        },
        dispose() {},
      };
    },
  });
  try {
    await writeFile(triggerFile, "now\n");
    for (let i = 0; i < 100 && triggers.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    await loop.idle();
    for (let i = 0; i < 50; i++) {
      try {
        await stat(statusFile);
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 20));
      }
    }
    assert.deepEqual(triggers, ["request"]);
    assert.deepEqual(attemptsSeen, [0], "a run request resets the attempt counters");
    await assert.rejects(() => stat(triggerFile), "the trigger file is consumed");
    const status = JSON.parse(await readFile(statusFile, "utf8")) as ReconcileStatus;
    assert.equal(status.state, "waiting");
    assert.equal(status.trigger, "request");
    assert.ok(status.nextRunAt);
  } finally {
    loop.stop();
  }
});

test("writeStatusFile redacts anything secret-looking as a second line of defence", async () => {
  const f = path.join(root, "s.json");
  const s = { errors: ["password=hunter2hunter2"] } as unknown as ReconcileStatus;
  await writeStatusFile(f, s);
  assert.ok(!(await readFile(f, "utf8")).includes("hunter2"));
});
