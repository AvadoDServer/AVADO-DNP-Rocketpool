import assert from "node:assert/strict";
import { test } from "node:test";
import type { ClientId, ClientInfo, InstalledPackage } from "../src/reconcile/clients";
import type { ImportResult, Keymanager } from "../src/reconcile/keymanager";
import type { KeystoreProblem, LoadedKeystore } from "../src/reconcile/keystores";
import { MAX_IMPORT_ATTEMPTS, runReconcile, type RunDeps } from "../src/reconcile/run";

const SP = "0x" + "5".repeat(40);
const FD = "0x" + "d".repeat(40);
const MP = "0x" + "e".repeat(40);
const OTHER = "0x" + "9".repeat(40);
const pk = (c: string) => c.repeat(96);

const PKG = {
  teku: "teku.avado.dnp.dappnode.eth",
  nimbus: "nimbus.avado.dnp.dappnode.eth",
  lighthouse: "lighthouse.avado.dnp.dappnode.eth",
  prysm: "eth2validator.avado.dnp.dappnode.eth",
};

/** In-memory keymanager that records every call. */
class FakeKm implements Keymanager {
  keys = new Set<string>();
  remote = new Set<string>();
  fee = new Map<string, string>();
  calls: string[] = [];
  failList = false;
  failRemote = true;
  importAnswer: (n: number) => ImportResult = () => ({ status: "imported" });
  failSetFee = false;
  imported: Array<{ keystoreJson: string; password: string }> = [];

  async listKeystores() {
    this.calls.push("list");
    if (this.failList) throw new Error("not reachable");
    return new Set(this.keys);
  }
  async listRemoteKeys() {
    this.calls.push("remote");
    if (this.failRemote) throw new Error("HTTP 500: failed");
    return new Set(this.remote);
  }
  async importKeystore(keystoreJson: string, password: string) {
    this.calls.push("import");
    this.imported.push({ keystoreJson, password });
    const r = this.importAnswer(this.imported.length);
    if (r.status === "imported") this.keys.add(JSON.parse(keystoreJson).pubkey);
    return r;
  }
  async getFeeRecipient(p: string) {
    this.calls.push(`getfee:${p[0]}`);
    return this.fee.get(p) ?? null;
  }
  async setFeeRecipient(p: string, a: string) {
    this.calls.push(`setfee:${p[0]}:${a}`);
    if (this.failSetFee) throw new Error("HTTP 500: failed");
    this.fee.set(p, a);
  }
}

interface Fixture {
  wallet: unknown;
  node: unknown;
  megapool: unknown;
  packages: InstalledPackage[] | Error;
  kms: Partial<Record<ClientId, FakeKm>>;
  keystores: Set<string>;
  /** The "approved to load" list. */
  approved: Set<string>;
  approvedError?: string;
  configured: string | undefined;
  snCalls: string[];
  wampCalls: number;
  attempts: Map<string, number>;
}

function fixture(o: Partial<Fixture> = {}): Fixture {
  return {
    wallet: { status: "success", walletInitialized: true, passwordSet: true, isMasquerading: false },
    node: {
      status: "success",
      registered: true,
      megapoolDeployed: false,
      feeRecipientInfo: {
        smoothingPoolAddress: SP,
        feeDistributorAddress: FD,
        megapoolAddress: MP,
        isInSmoothingPool: false,
        isInOptOutCooldown: false,
      },
      minipools: [
        { address: "0xm1", validatorPubkey: pk("1"), status: { status: "Staking" } },
        { address: "0xm2", validatorPubkey: pk("2"), status: { status: "Staking" } },
      ],
    },
    megapool: { status: "success", megapoolDetails: { validators: [] } },
    packages: [{ name: PKG.teku, running: true }],
    kms: { teku: new FakeKm() },
    keystores: new Set([pk("1"), pk("2"), pk("3"), pk("4")]),
    approved: new Set([pk("1"), pk("2"), pk("3"), pk("4")]),
    configured: "teku",
    snCalls: [],
    wampCalls: 0,
    attempts: new Map(),
    ...o,
  };
}

function deps(f: Fixture): RunDeps {
  return {
    smartnode: {
      async get(route) {
        f.snCalls.push(route);
        const body = route === "wallet/status" ? f.wallet : route === "node/status" ? f.node : route === "megapool/status" ? f.megapool : undefined;
        if (body instanceof Error) throw body;
        if (body === undefined) throw new Error(`unexpected route ${route}`);
        return body;
      },
    },
    async listPackages() {
      f.wampCalls++;
      if (f.packages instanceof Error) throw f.packages;
      return f.packages;
    },
    keymanagerFor(c: ClientInfo) {
      const km = f.kms[c.id];
      if (!km) throw new Error(`no fake keymanager for ${c.id}`);
      return km;
    },
    async loadKeystore(p): Promise<LoadedKeystore | KeystoreProblem> {
      if (!f.keystores.has(p)) return { problem: "missing" };
      return { layout: "teku", keystoreJson: JSON.stringify({ pubkey: p, crypto: {} }), password: `pw-${p[0]}` };
    },
    readApproved: async () => ({ keys: new Set(f.approved), ...(f.approvedError ? { error: f.approvedError } : {}) }),
    configuredClient: f.configured,
    importAttempts: f.attempts,
    trigger: "timer",
    now: () => new Date("2026-09-23T10:00:00Z"),
  };
}

const allCalls = (f: Fixture) => Object.values(f.kms).flatMap((k) => k!.calls);

test("no wallet: waiting, and nothing but wallet/status is asked", async () => {
  const f = fixture({ wallet: { status: "success", walletInitialized: false } });
  const s = await runReconcile(deps(f));
  assert.equal(s.state, "waiting");
  assert.match(s.message, /wallet/i);
  assert.deepEqual(f.snCalls, ["wallet/status"]);
  assert.equal(f.wampCalls, 0);
  assert.deepEqual(allCalls(f), []);
});

test("node not registered: waiting, no DAPPMANAGER or keymanager call", async () => {
  const f = fixture();
  (f.node as Record<string, unknown>).registered = false;
  const s = await runReconcile(deps(f));
  assert.equal(s.state, "waiting");
  assert.match(s.message, /not registered/);
  assert.equal(f.wampCalls, 0);
  assert.deepEqual(allCalls(f), []);
});

test("masquerading wallet: waiting, nothing touched", async () => {
  const f = fixture({ wallet: { status: "success", walletInitialized: true, isMasquerading: true } });
  const s = await runReconcile(deps(f));
  assert.equal(s.state, "waiting");
  assert.equal(f.wampCalls, 0);
});

test("daemon unreachable: waiting with the error recorded, never thrown", async () => {
  const f = fixture({ wallet: new Error("The Rocket Pool daemon is not reachable (it may still be starting).") });
  const s = await runReconcile(deps(f));
  assert.equal(s.state, "waiting");
  assert.match(s.errors[0], /not reachable/);
});

test("imports the missing Rocket Pool keys and sets their fee recipients", async () => {
  const f = fixture();
  const teku = f.kms.teku!;
  teku.keys.add(pk("1"));
  teku.fee.set(pk("1"), FD);
  const s = await runReconcile(deps(f));
  assert.equal(s.state, "ok", s.message);
  assert.equal(s.keys.summary, "2/2");
  assert.equal(s.keys.imported, 1);
  assert.equal(teku.imported.length, 1);
  assert.equal(JSON.parse(teku.imported[0].keystoreJson).pubkey, pk("2"));
  assert.equal(teku.imported[0].password, "pw-2");
  assert.deepEqual(s.feeRecipients, { total: 2, ok: 1, fixed: 1, failed: 0 });
  assert.equal(teku.fee.get(pk("2")), FD);
  assert.match(s.message, /in sync with Teku: 2\/2/);
  assert.deepEqual(s.client, { id: "teku", name: "Teku", package: PKG.teku });
  // the status never carries a keystore or a password
  const text = JSON.stringify(s);
  assert.ok(!text.includes("pw-2") && !text.includes("crypto"));
});

test("a key loaded in another installed client is never imported", async () => {
  const nimbus = new FakeKm();
  nimbus.keys.add(pk("2"));
  const f = fixture({
    packages: [
      { name: PKG.teku, running: true },
      { name: PKG.nimbus, running: false },
    ],
    kms: { teku: new FakeKm(), nimbus },
  });
  const s = await runReconcile(deps(f));
  const teku = f.kms.teku!;
  assert.deepEqual(teku.imported.map((i) => JSON.parse(i.keystoreJson).pubkey), [pk("1")]);
  const v2 = s.validators.find((v) => v.pubkey === pk("2"))!;
  assert.equal(v2.state, "elsewhere");
  assert.equal(v2.loadedIn, PKG.nimbus);
  assert.equal(s.state, "attention");
  assert.equal(s.keys.summary, "1/2");
  // the other client is only read, never written
  assert.deepEqual(nimbus.calls, ["list", "remote"]);
  assert.deepEqual(s.otherClients, [{ id: "nimbus", name: "Nimbus", package: PKG.nimbus, checked: true }]);
});

test("a remote (web3signer) key in another client also blocks the import", async () => {
  const lh = new FakeKm();
  lh.failRemote = false;
  lh.remote.add(pk("1"));
  const f = fixture({
    packages: [
      { name: PKG.teku, running: true },
      { name: PKG.lighthouse, running: true },
    ],
    kms: { teku: new FakeKm(), lighthouse: lh },
  });
  const s = await runReconcile(deps(f));
  assert.equal(s.validators.find((v) => v.pubkey === pk("1"))!.state, "elsewhere");
  assert.deepEqual(f.kms.teku!.imported.map((i) => JSON.parse(i.keystoreJson).pubkey), [pk("2")]);
});

test("when another installed client cannot be checked, nothing is imported (fail closed)", async () => {
  const prysm = new FakeKm();
  prysm.failList = true;
  const teku = new FakeKm();
  teku.keys.add(pk("1"));
  const f = fixture({
    packages: [
      { name: PKG.teku, running: true },
      { name: PKG.prysm, running: false },
    ],
    kms: { teku, prysm },
  });
  const s = await runReconcile(deps(f));
  assert.equal(teku.imported.length, 0);
  assert.equal(s.validators.find((v) => v.pubkey === pk("2"))!.state, "import-blocked");
  assert.ok(s.errors.some((e) => /Prysm/.test(e) && /could not be checked/.test(e)));
  // the loaded key's fee recipient is still managed
  assert.equal(teku.fee.get(pk("1")), FD);
  assert.equal(s.state, "attention");
});

test("an unknown validator package blocks imports", async () => {
  const f = fixture({
    packages: [
      { name: PKG.teku, running: true },
      { name: "web3signer.avado.dnp.dappnode.eth", running: true },
    ],
  });
  const s = await runReconcile(deps(f));
  assert.equal(f.kms.teku!.imported.length, 0);
  assert.deepEqual(s.unknownValidatorPackages, ["web3signer.avado.dnp.dappnode.eth"]);
  assert.ok(s.validators.every((v) => v.state === "import-blocked"));
});

test("keys that are not Rocket Pool keys are never touched", async () => {
  const teku = new FakeKm();
  const foreign = pk("f");
  teku.keys.add(foreign);
  teku.fee.set(foreign, OTHER);
  teku.keys.add(pk("1"));
  teku.keys.add(pk("2"));
  const f = fixture({ kms: { teku } });
  const s = await runReconcile(deps(f));
  assert.equal(s.state, "ok");
  assert.equal(teku.fee.get(foreign), OTHER);
  assert.ok(!teku.calls.some((c) => c.includes(":f") || c === "getfee:f"), teku.calls.join(","));
  assert.ok(!s.validators.some((v) => v.pubkey === foreign));
  assert.equal(teku.imported.length, 0);
});

test("the chosen client's key list failing stops the run without imports", async () => {
  const teku = new FakeKm();
  teku.failList = true;
  const s = await runReconcile(deps(fixture({ kms: { teku } })));
  assert.equal(s.state, "error");
  assert.match(s.message, /Teku/);
  assert.deepEqual(teku.calls, ["list"]);
});

test("DAPPMANAGER unreachable: error, nothing touched", async () => {
  const f = fixture({ packages: new Error("wamp: connection closed") });
  const s = await runReconcile(deps(f));
  assert.equal(s.state, "error");
  assert.match(s.errors[0], /DAPPMANAGER/);
  assert.deepEqual(allCalls(f), []);
});

test("configured client not installed: no import into a different client", async () => {
  const f = fixture({ configured: "nimbus" });
  const s = await runReconcile(deps(f));
  assert.equal(s.state, "error");
  assert.equal(s.client, null);
  assert.match(s.message, /Nimbus/);
  assert.deepEqual(allCalls(f), []);
});

test("import retries are bounded per key", async () => {
  const f = fixture();
  const teku = f.kms.teku!;
  teku.importAnswer = () => ({ status: "error", message: "invalid keystore" });
  for (let i = 0; i < MAX_IMPORT_ATTEMPTS; i++) {
    const s = await runReconcile(deps(f));
    assert.equal(s.validators[0].state, "import-failed");
    assert.match(s.validators[0].error!, /invalid keystore/);
  }
  const before = teku.imported.length;
  const s = await runReconcile(deps(f));
  assert.equal(teku.imported.length, before, "no further attempt");
  assert.equal(s.validators[0].state, "retry-limit");
  assert.equal(s.state, "attention");
  // a run request clears the counters (loop.ts); simulate it
  f.attempts.clear();
  teku.importAnswer = () => ({ status: "imported" });
  const s2 = await runReconcile(deps(f));
  assert.equal(s2.keys.summary, "2/2");
});

test("a thrown import error is recorded, never thrown", async () => {
  const f = fixture();
  f.kms.teku!.importKeystore = async () => {
    throw new Error("HTTP 500: failed");
  };
  const s = await runReconcile(deps(f));
  assert.equal(s.validators[0].state, "import-failed");
  assert.equal(f.attempts.get(pk("1")), 1);
});

test("a key without a keystore is reported, not imported", async () => {
  const f = fixture({ keystores: new Set([pk("1")]) });
  const s = await runReconcile(deps(f));
  const v2 = s.validators.find((v) => v.pubkey === pk("2"))!;
  assert.equal(v2.state, "missing-keystore");
  assert.match(v2.error!, /No keystore/);
  assert.equal(f.kms.teku!.imported.length, 1);
});

test("mixed node outside the smoothing pool: fee recipient per key", async () => {
  const f = fixture();
  (f.node as Record<string, unknown>).megapoolDeployed = true;
  f.megapool = { status: "success", megapoolDetails: { validators: [{ validatorId: 0, pubKey: pk("3") }] } };
  const teku = f.kms.teku!;
  for (const p of [pk("1"), pk("2"), pk("3")]) teku.keys.add(p);
  teku.fee.set(pk("3"), FD); // wrong: megapool keys pay the megapool
  const s = await runReconcile(deps(f));
  assert.equal(teku.fee.get(pk("1")), FD);
  assert.equal(teku.fee.get(pk("2")), FD);
  assert.equal(teku.fee.get(pk("3")), MP);
  assert.equal(s.feeRecipients.fixed, 3);
  assert.ok(f.snCalls.includes("megapool/status"));
});

test("smoothing pool: every key pays the smoothing pool", async () => {
  const f = fixture();
  (f.node as { feeRecipientInfo: Record<string, unknown> }).feeRecipientInfo.isInSmoothingPool = true;
  const teku = f.kms.teku!;
  teku.keys.add(pk("1"));
  teku.fee.set(pk("1"), SP);
  const s = await runReconcile(deps(f));
  assert.equal(teku.fee.get(pk("2")), SP);
  assert.deepEqual(s.feeRecipients, { total: 2, ok: 1, fixed: 1, failed: 0 });
  assert.ok(!teku.calls.includes(`setfee:1:${SP}`), "a correct fee recipient is not rewritten");
});

test("fee recipient failures are counted and reported", async () => {
  const f = fixture();
  const teku = f.kms.teku!;
  teku.keys.add(pk("1"));
  teku.keys.add(pk("2"));
  teku.failSetFee = true;
  const s = await runReconcile(deps(f));
  assert.equal(s.feeRecipients.failed, 2);
  assert.equal(s.state, "attention");
  assert.match(s.validators[0].error!, /fee recipient failed/);
});

test("a missing fee-recipient address is never set", async () => {
  const f = fixture();
  (f.node as { feeRecipientInfo: Record<string, unknown> }).feeRecipientInfo.feeDistributorAddress = "0x" + "0".repeat(40);
  const teku = f.kms.teku!;
  teku.keys.add(pk("1"));
  const s = await runReconcile(deps(f));
  assert.ok(!teku.calls.some((c) => c.startsWith("setfee")));
  assert.equal(s.validators[0].feeRecipient.state, "no-address");
});

test("node/status failing while syncing is waiting; other failures are errors", async () => {
  const f = fixture({ node: new Error("Rocket Pool daemon (node/status): The Eth 2.0 node is not synced") });
  assert.equal((await runReconcile(deps(f))).state, "waiting");
  const g = fixture({ node: new Error("Rocket Pool daemon (node/status): boom") });
  assert.equal((await runReconcile(deps(g))).state, "error");
});

test("a node with no validators is in sync (0/0)", async () => {
  const f = fixture();
  (f.node as Record<string, unknown>).minipools = [];
  const s = await runReconcile(deps(f));
  assert.equal(s.state, "ok");
  assert.equal(s.keys.summary, "0/0");
});

// ---------- Fix round 1: keys load only when approved ----------

test("a missing key that is not approved is never imported; it waits for the owner", async () => {
  const f = fixture({ approved: new Set() });
  const teku = f.kms.teku!;
  teku.keys.add(pk("1")); // loaded before (e.g. by the old wizard): kept and managed
  const s = await runReconcile(deps(f));
  assert.equal(teku.imported.length, 0);
  assert.deepEqual(s.awaitingApproval, [pk("2")]);
  const v2 = s.validators.find((v) => v.pubkey === pk("2"))!;
  assert.equal(v2.state, "awaiting-approval");
  assert.equal(s.state, "attention");
  assert.match(s.message, /1 validator key is not loaded and waits for your approval/);
  // the loaded key is not removed and its fee recipient is still corrected
  assert.equal(s.validators.find((v) => v.pubkey === pk("1"))!.state, "loaded");
  assert.equal(teku.fee.get(pk("1")), FD);
  assert.equal(s.feeRecipients.fixed, 1);
  assert.ok(!teku.calls.some((c) => c.startsWith("setfee:2")), "no fee recipient for a key that is not loaded");
});

test("approval is per key: approved keys load, the others wait", async () => {
  const f = fixture({ approved: new Set([pk("2")]) });
  (f.node as { minipools: unknown[] }).minipools.push({ address: "0xm3", validatorPubkey: pk("3"), status: { status: "Staking" } });
  const s = await runReconcile(deps(f));
  assert.deepEqual(f.kms.teku!.imported.map((i) => JSON.parse(i.keystoreJson).pubkey), [pk("2")]);
  assert.deepEqual(s.awaitingApproval, [pk("1"), pk("3")]);
  assert.match(s.message, /2 validator keys are not loaded and wait for your approval/);
});

test("keys without a keystore or loaded elsewhere are not offered for approval", async () => {
  const nimbus = new FakeKm();
  nimbus.keys.add(pk("2"));
  const f = fixture({
    approved: new Set(),
    keystores: new Set([pk("2")]),
    packages: [
      { name: PKG.teku, running: true },
      { name: PKG.nimbus, running: true },
    ],
    kms: { teku: new FakeKm(), nimbus },
  });
  const s = await runReconcile(deps(f));
  assert.deepEqual(s.awaitingApproval, []);
  assert.equal(s.validators.find((v) => v.pubkey === pk("1"))!.state, "missing-keystore");
  assert.equal(s.validators.find((v) => v.pubkey === pk("2"))!.state, "elsewhere");
});

test("an approved key is still subject to the double-signing guard", async () => {
  const prysm = new FakeKm();
  prysm.failList = true;
  const f = fixture({
    packages: [
      { name: PKG.teku, running: true },
      { name: PKG.prysm, running: true },
    ],
    kms: { teku: new FakeKm(), prysm },
  });
  const s = await runReconcile(deps(f));
  assert.equal(f.kms.teku!.imported.length, 0);
  assert.ok(s.validators.every((v) => v.state === "import-blocked"));
});

test("an unreadable approved list approves nothing and is reported", async () => {
  const f = fixture({ approved: new Set(), approvedError: ".avado-approved-keys.json is not valid; treating no key as approved" });
  const s = await runReconcile(deps(f));
  assert.equal(f.kms.teku!.imported.length, 0);
  assert.ok(s.errors.some((e) => /not valid/.test(e)));
});

test("the status says which client was chosen and why", async () => {
  const s1 = await runReconcile(deps(fixture()));
  assert.deepEqual(s1.clientChoice, { source: "setting", why: 'The Rocket Pool package setting CONSENSUSCLIENT is "teku".' });
  assert.equal(s1.configuredClient, "teku");
  const s2 = await runReconcile(deps(fixture({ configured: undefined })));
  assert.equal(s2.clientChoice!.source, "only-installed");
  assert.match(s2.clientChoice!.why, /CONSENSUSCLIENT is not set; Teku is the only installed/);
  const s3 = await runReconcile(deps(fixture({ configured: "lighthouse" })));
  assert.equal(s3.clientChoice!.source, "none");
  assert.match(s3.clientChoice!.why, /CONSENSUSCLIENT=lighthouse.*not installed/);
});
