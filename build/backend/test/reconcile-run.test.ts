import assert from "node:assert/strict";
import { test } from "node:test";
import type { ClientId, ClientInfo, InstalledPackage } from "../src/reconcile/clients";
import type { ImportResult, Keymanager } from "../src/reconcile/keymanager";
import type { KeystoreProblem, LoadedKeystore } from "../src/reconcile/keystores";
import type { AbsenceMap } from "../src/reconcile/absence";
import type { ApprovedEntry } from "../src/reconcile/approved";
import { MAX_IMPORT_ATTEMPTS, runReconcile, type ImportAttempts, type RunDeps } from "../src/reconcile/run";

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
  failGetFee = false;
  async getFeeRecipient(p: string) {
    this.calls.push(`getfee:${p[0]}`);
    if (this.failGetFee) throw new Error("HTTP 500: failed");
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
  /** The "approved to load" list (persisted between runs, like the file). */
  approved: Map<string, ApprovedEntry>;
  approvedError?: string;
  /** Persisted absence observations. */
  absence: AbsenceMap;
  configured: string | undefined;
  snCalls: string[];
  wampCalls: number;
  attempts: Map<string, ImportAttempts>;
  /** The loop's per-process set of keys seen loaded. */
  seenLoaded: Map<string, string>;
  failConsume?: boolean;
  failWritable?: boolean;
  /** The clock for the next run. */
  now: Date;
}

const T0 = new Date("2026-09-23T10:00:00Z");
const at = (min: number) => new Date(T0.getTime() + min * 60_000);
const deposit = (): ApprovedEntry => ({ source: "deposit", approvedAt: "2026-09-23T09:00:00.000Z" });
const owner = (): ApprovedEntry => ({ source: "owner", approvedAt: "2026-09-23T09:00:00.000Z" });
const approvals = (kind: () => ApprovedEntry, ...keys: string[]) => new Map(keys.map((k) => [k, kind()]));

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
    packages: [{ name: PKG.teku, running: true, version: "0.0.76" }],
    kms: { teku: new FakeKm() },
    keystores: new Set([pk("1"), pk("2"), pk("3"), pk("4")]),
    approved: approvals(deposit, pk("1"), pk("2"), pk("3"), pk("4")),
    absence: new Map(),
    configured: "teku",
    snCalls: [],
    wampCalls: 0,
    attempts: new Map(),
    seenLoaded: new Map(),
    now: T0,
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
    readApproved: async () => ({
      entries: new Map([...f.approved].map(([k, v]) => [k, { ...v }])),
      ...(f.approvedError ? { error: f.approvedError } : {}),
    }),
    async consumeApprovals(pubkeys) {
      if (f.failConsume) throw new Error("ENOSPC: no space left on device");
      for (const p of pubkeys) {
        const e = f.approved.get(p);
        if (e && !e.loadedAt) e.loadedAt = f.now.toISOString();
      }
    },
    async checkApprovalsWritable() {
      if (f.failWritable) throw new Error("EROFS: read-only file system");
    },
    seenLoaded: f.seenLoaded,
    readAbsence: async () => new Map(f.absence),
    async writeAbsence(map) {
      f.absence = new Map(map);
    },
    configuredClient: f.configured,
    importAttempts: f.attempts,
    trigger: "timer",
    now: () => f.now,
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

test("a key loaded in another installed client is never imported there or here; its fee recipient is fixed there", async () => {
  const nimbus = new FakeKm();
  nimbus.keys.add(pk("2"));
  const f = fixture({
    packages: [
      { name: PKG.teku, running: true, version: "0.0.76" },
      { name: PKG.nimbus, running: false },
    ],
    kms: { teku: new FakeKm(), nimbus },
  });
  const s = await runReconcile(deps(f));
  const teku = f.kms.teku!;
  assert.deepEqual(teku.imported.map((i) => JSON.parse(i.keystoreJson).pubkey), [pk("1")]);
  const v2 = s.validators.find((v) => v.pubkey === pk("2"))!;
  assert.equal(v2.state, "elsewhere");
  assert.deepEqual(v2.loadedIn, [PKG.nimbus]);
  assert.equal(s.state, "attention");
  assert.equal(s.keys.summary, "1/2");
  // nothing is imported into the other client; only the Rocket Pool key's fee recipient is set there
  assert.equal(nimbus.imported.length, 0);
  assert.deepEqual(nimbus.calls, ["list", "remote", "getfee:2", `setfee:2:${FD}`]);
  assert.equal(nimbus.fee.get(pk("2")), FD);
  const rep = s.clients.find((c) => c.id === "nimbus")!;
  assert.deepEqual([rep.checked, rep.chosen, rep.rocketPoolKeys, rep.feeRecipients.fixed], [true, false, 1, 1]);
});

test("a remote (web3signer) key in another client also blocks the import", async () => {
  const lh = new FakeKm();
  lh.failRemote = false;
  lh.remote.add(pk("1"));
  const f = fixture({
    packages: [
      { name: PKG.teku, running: true, version: "0.0.76" },
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
      { name: PKG.teku, running: true, version: "0.0.76" },
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
      { name: PKG.teku, running: true, version: "0.0.76" },
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

test("the chosen client's key list failing: error, no imports", async () => {
  const teku = new FakeKm();
  teku.failList = true;
  const s = await runReconcile(deps(fixture({ kms: { teku } })));
  assert.equal(s.state, "error");
  assert.match(s.message, /Teku/);
  assert.deepEqual(teku.calls, ["list"]);
  assert.ok(s.validators.every((v) => v.state === "import-blocked"));
});

test("DAPPMANAGER unreachable: error, nothing touched", async () => {
  const f = fixture({ packages: new Error("wamp: connection closed") });
  const s = await runReconcile(deps(f));
  assert.equal(s.state, "error");
  assert.match(s.errors[0], /DAPPMANAGER/);
  assert.deepEqual(allCalls(f), []);
});

test("configured client not installed: no import anywhere, fee recipients still fixed where keys run", async () => {
  const f = fixture({ configured: "prysm" });
  const teku = f.kms.teku!;
  teku.keys.add(pk("1"));
  const s = await runReconcile(deps(f));
  assert.equal(s.state, "error");
  assert.equal(s.client, null);
  assert.match(s.message, /set to use Prysm.*not installed.*Fee recipients were checked in Teku/);
  assert.equal(teku.imported.length, 0);
  assert.equal(teku.fee.get(pk("1")), FD);
  assert.equal(s.validators.find((v) => v.pubkey === pk("2"))!.state, "no-client");
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
  // a trigger does not reset the bound: only a new owner approval of the key does
  const s1 = await runReconcile(deps(f));
  assert.equal(s1.validators[0].state, "retry-limit");
  f.approved.get(pk("1"))!.renewedAt = at(1).toISOString();
  f.approved.get(pk("2"))!.renewedAt = at(1).toISOString();
  f.now = at(2);
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
  assert.equal(f.attempts.get(pk("1"))!.count, 1);
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
  const f = fixture({ approved: new Map() });
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
  const f = fixture({ approved: approvals(deposit, pk("2")) });
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
    approved: new Map(),
    keystores: new Set([pk("2")]),
    packages: [
      { name: PKG.teku, running: true, version: "0.0.76" },
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
      { name: PKG.teku, running: true, version: "0.0.76" },
      { name: PKG.prysm, running: true },
    ],
    kms: { teku: new FakeKm(), prysm },
  });
  const s = await runReconcile(deps(f));
  assert.equal(f.kms.teku!.imported.length, 0);
  assert.ok(s.validators.every((v) => v.state === "import-blocked"));
});

test("an unreadable approved list approves nothing and is reported", async () => {
  const f = fixture({ approved: new Map(), approvedError: ".avado-approved-keys.json is not valid; treating no key as approved" });
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

// ---------- Fix round 2 ----------

const onlyKey1 = (f: Fixture) => {
  (f.node as { minipools: unknown[] }).minipools = [{ address: "0xm1", validatorPubkey: pk("1"), status: { status: "Staking" } }];
};

for (const [label, kind] of [
  ["deposit-approved", deposit],
  ["LOAD-approved", owner],
] as const) {
  test(`C1: a ${label} key the owner removes on purpose is never re-imported`, async () => {
    const f = fixture({ approved: approvals(kind, pk("1")) });
    onlyKey1(f);
    const teku = f.kms.teku!;
    if (kind === owner) {
      // an owner approval waits for the settling time first
      for (const m of [0, 5, 10, 15]) {
        f.now = at(m);
        assert.equal((await runReconcile(deps(f))).validators[0].state, "settling");
      }
      f.now = at(20);
    }
    const s1 = await runReconcile(deps(f));
    assert.equal(s1.validators[0].state, "imported");
    assert.equal(teku.imported.length, 1);
    assert.ok(f.approved.get(pk("1"))!.loadedAt, "the approval is used up");

    teku.keys.delete(pk("1")); // the owner removes the key (e.g. to run it on another machine)
    for (const m of [30, 60, 120]) {
      f.now = at(m);
      const s = await runReconcile(deps(f));
      assert.equal(s.validators[0].state, "awaiting-approval");
      assert.deepEqual(s.awaitingApproval, [pk("1")]);
      assert.match(s.validators[0].error!, /loaded before and has been removed/);
    }
    assert.equal(teku.imported.length, 1, "no second import");
  });
}

test("C1: an approved key seen loaded in any client uses its approval up", async () => {
  const nimbus = new FakeKm();
  nimbus.keys.add(pk("1"));
  const f = fixture({
    packages: [
      { name: PKG.teku, running: true, version: "0.0.76" },
      { name: PKG.nimbus, running: true },
    ],
    kms: { teku: new FakeKm(), nimbus },
  });
  onlyKey1(f);
  await runReconcile(deps(f));
  assert.ok(f.approved.get(pk("1"))!.loadedAt);
  nimbus.keys.delete(pk("1")); // the owner removes it from Nimbus
  f.now = at(60);
  const s = await runReconcile(deps(f));
  assert.equal(s.validators[0].state, "awaiting-approval");
  assert.equal(f.kms.teku!.imported.length, 0);
});

test("I1: fee recipients are corrected in every readable installed client", async () => {
  const nimbus = new FakeKm();
  nimbus.keys.add(pk("2"));
  nimbus.fee.set(pk("2"), OTHER);
  nimbus.keys.add(pk("f")); // not a Rocket Pool key
  nimbus.fee.set(pk("f"), OTHER);
  const teku = new FakeKm();
  teku.keys.add(pk("1"));
  const f = fixture({
    packages: [
      { name: PKG.teku, running: true, version: "0.0.76" },
      { name: PKG.nimbus, running: true },
    ],
    kms: { teku, nimbus },
  });
  const s = await runReconcile(deps(f));
  assert.equal(nimbus.fee.get(pk("2")), FD);
  assert.equal(nimbus.fee.get(pk("f")), OTHER, "non-Rocket Pool keys are untouched");
  assert.equal(teku.fee.get(pk("1")), FD);
  assert.equal(nimbus.imported.length + teku.imported.length, 0);
  assert.deepEqual(s.validators.find((v) => v.pubkey === pk("2"))!.feeRecipient.clients, [
    { package: PKG.nimbus, found: OTHER, state: "fixed" },
  ]);
  assert.equal(s.feeRecipients.fixed, 2);
});

test("I2: an owner-approved key is imported only after 20 minutes of continuous absence", async () => {
  const f = fixture({ approved: approvals(owner, pk("1")) });
  onlyKey1(f);
  const teku = f.kms.teku!;
  let s = await runReconcile(deps(f));
  assert.equal(s.validators[0].state, "settling");
  assert.equal(s.validators[0].settlesAt, at(20).toISOString());
  assert.match(s.message, /absent everywhere for 20 minutes/);
  f.now = at(5);
  f.attempts = new Map(); // a backend restart: the observations are persisted
  f.seenLoaded = new Map();
  s = await runReconcile(deps(f));
  assert.equal(s.validators[0].state, "settling");
  for (const m of [10, 15]) {
    f.now = at(m);
    assert.equal((await runReconcile(deps(f))).validators[0].state, "settling");
  }
  f.now = at(19);
  assert.equal((await runReconcile(deps(f))).validators[0].state, "settling");
  f.now = at(20);
  s = await runReconcile(deps(f));
  assert.equal(s.validators[0].state, "imported");
  assert.equal(teku.imported.length, 1);
});

test("I2: a gap in the observations or a sighting restarts the clock", async () => {
  const f = fixture({ approved: approvals(owner, pk("1")) });
  onlyKey1(f);
  await runReconcile(deps(f)); // absent since T0
  f.now = at(16); // more than 15 min without an observation (backend down)
  let s = await runReconcile(deps(f));
  assert.equal(s.validators[0].settlesAt, at(36).toISOString());

  // seen in another client for one run, then gone again
  const nimbus = new FakeKm();
  f.packages = [
    { name: PKG.teku, running: true, version: "0.0.76" },
    { name: PKG.nimbus, running: true },
  ];
  f.kms.nimbus = nimbus;
  f.approved = approvals(owner, pk("1"));
  f.now = at(30);
  s = await runReconcile(deps(f));
  assert.equal(s.validators[0].settlesAt, at(36).toISOString());
  nimbus.keys.add(pk("1"));
  f.now = at(31);
  await runReconcile(deps(f)); // present: the clock stops (and the approval is used up)
  nimbus.keys.delete(pk("1"));
  f.approved = new Map([[pk("1"), { source: "owner", approvedAt: at(31.5).toISOString() }]]); // the owner approves again
  f.now = at(32);
  s = await runReconcile(deps(f));
  assert.equal(s.validators[0].state, "settling");
  assert.equal(s.validators[0].settlesAt, at(52).toISOString());
});

test("I2: an unreadable client breaks the continuity", async () => {
  const prysm = new FakeKm();
  const f = fixture({
    approved: approvals(owner, pk("1")),
    packages: [
      { name: PKG.teku, running: true, version: "0.0.76" },
      { name: PKG.prysm, running: true },
    ],
    kms: { teku: new FakeKm(), prysm },
  });
  onlyKey1(f);
  await runReconcile(deps(f)); // absent since T0
  prysm.failList = true;
  f.now = at(10);
  await runReconcile(deps(f));
  assert.equal(f.absence.size, 0, "cannot tell: the clock is reset");
  prysm.failList = false;
  f.now = at(21);
  const s = await runReconcile(deps(f));
  assert.equal(s.validators[0].state, "settling");
  assert.equal(s.validators[0].settlesAt, at(41).toISOString());
});

test("I2: deposit keys never seen in any client are exempt from the settling delay", async () => {
  const f = fixture({ approved: approvals(deposit, pk("1")) });
  onlyKey1(f);
  const s = await runReconcile(deps(f));
  assert.equal(s.validators[0].state, "imported");
});

test("I3: a key loaded in two clients is an error and stops every import", async () => {
  const nimbus = new FakeKm();
  nimbus.keys.add(pk("1"));
  const teku = new FakeKm();
  teku.keys.add(pk("1"));
  const f = fixture({
    packages: [
      { name: PKG.teku, running: true, version: "0.0.76" },
      { name: PKG.nimbus, running: true },
    ],
    kms: { teku, nimbus },
  });
  const s = await runReconcile(deps(f));
  assert.equal(s.state, "error");
  assert.equal(s.message, `Validator 0x${pk("1")} is loaded in both Nimbus and Teku — this can get it slashed. Remove it from one of them now.`);
  assert.equal(s.validators[0].state, "loaded-twice");
  assert.deepEqual(s.loadedTwice, [{ pubkey: pk("1"), packages: [PKG.nimbus, PKG.teku] }]);
  assert.equal(s.validators[1].state, "import-blocked", "the approved missing key is not loaded in this run");
  assert.equal(teku.imported.length, 0);
  assert.ok(!allCalls(f).some((c) => c.startsWith("delete")), "nothing is removed");
});

test("I4: no automatic import into an old or unknown-version Teku; fee recipients still fixed", async () => {
  for (const version of ["0.0.75", "/ipfs/QmX", null]) {
    const f = fixture({ packages: [{ name: PKG.teku, running: true, version }] });
    const teku = f.kms.teku!;
    teku.keys.add(pk("1"));
    const s = await runReconcile(deps(f));
    assert.equal(teku.imported.length, 0, String(version));
    assert.equal(s.validators[1].state, "client-update-needed");
    assert.match(s.message, /Update Teku before loading keys/);
    assert.ok(s.importBlockedReasons.some((r) => /Update Teku/.test(r)));
    assert.equal(teku.fee.get(pk("1")), FD);
  }
  const ok = fixture({ packages: [{ name: PKG.teku, running: true, version: "0.0.80" }] });
  await runReconcile(deps(ok));
  assert.equal(ok.kms.teku!.imported.length, 2);
});

test("M3: the approval prompt carries the reason keys cannot be loaded right now", async () => {
  const prysm = new FakeKm();
  prysm.failList = true;
  const f = fixture({
    approved: new Map(),
    packages: [
      { name: PKG.teku, running: true, version: "0.0.76" },
      { name: PKG.prysm, running: false },
    ],
    kms: { teku: new FakeKm(), prysm },
  });
  const s = await runReconcile(deps(f));
  assert.equal(s.awaitingApproval.length, 2);
  assert.match(s.importBlockedReasons[0], /Prysm.*could not be checked/);
  assert.match(s.message, /cannot be loaded right now: the keys in Prysm/);
});

test("M6: when reading a fee recipient fails, setting it is still tried once", async () => {
  const f = fixture();
  const teku = f.kms.teku!;
  teku.keys.add(pk("1"));
  teku.keys.add(pk("2"));
  teku.failGetFee = true;
  const s = await runReconcile(deps(f));
  assert.equal(teku.fee.get(pk("1")), FD);
  assert.equal(s.feeRecipients.fixed, 2);
  teku.failSetFee = true;
  const s2 = await runReconcile(deps(f));
  assert.equal(s2.feeRecipients.failed, 2);
  assert.match(s2.validators[0].feeRecipient.clients[0].error!, /reading failed.*setting failed/);
});

// ---------- Fix round 3 ----------

test("R1: if recording a used approval fails, the key is never re-imported and nothing else loads that run", async () => {
  const f = fixture({ failConsume: true }); // disk full
  const teku = f.kms.teku!;
  const s1 = await runReconcile(deps(f));
  // key 1 was imported; recording that failed, so key 2 is not loaded in this run
  assert.equal(teku.imported.length, 1);
  assert.equal(s1.validators[0].state, "imported");
  assert.equal(s1.validators[1].state, "import-blocked");
  assert.ok(s1.importBlockedReasons.some((r) => /could not record which keys are loaded/.test(r)));
  assert.equal(f.approved.get(pk("1"))!.loadedAt, undefined, "the file still says unused");

  teku.keys.delete(pk("1")); // the owner removes key 1 on purpose
  f.failConsume = false;
  f.now = at(5);
  const s2 = await runReconcile(deps(f));
  assert.equal(s2.validators[0].state, "awaiting-approval", "the process remembers it was loaded");
  assert.deepEqual(teku.imported.map((i) => JSON.parse(i.keystoreJson).pubkey), [pk("1"), pk("2")]);
});

test("R1: a key seen loaded while the write fails blocks every import in that run", async () => {
  const f = fixture({ failConsume: true });
  f.kms.teku!.keys.add(pk("1")); // loaded by hand, approval unused on disk
  const s = await runReconcile(deps(f));
  assert.equal(f.kms.teku!.imported.length, 0);
  assert.equal(s.validators[1].state, "import-blocked");
  f.kms.teku!.keys.delete(pk("1"));
  f.failConsume = false;
  f.now = at(5);
  const s2 = await runReconcile(deps(f));
  assert.equal(s2.validators[0].state, "awaiting-approval");
});

test("R1: when the approval state cannot be saved at all, nothing is loaded and the status says why", async () => {
  const f = fixture({ failWritable: true });
  const s = await runReconcile(deps(f));
  assert.equal(f.kms.teku!.imported.length, 0);
  assert.ok(s.validators.every((v) => v.state === "import-blocked"));
  assert.ok(s.importBlockedReasons.some((r) => r.startsWith("Can't save approval state — disk full or read-only")));
  assert.ok(s.errors.some((e) => /Can't save approval state/.test(e)));
});

test("R1: a later owner approval in the same process is honoured", async () => {
  const f = fixture({ approved: approvals(deposit, pk("1")) });
  onlyKey1(f);
  const teku = f.kms.teku!;
  await runReconcile(deps(f));
  teku.keys.delete(pk("1"));
  f.approved = new Map([[pk("1"), { source: "owner", approvedAt: at(1).toISOString() }]]);
  for (const m of [2, 7, 12, 17]) {
    f.now = at(m);
    assert.equal((await runReconcile(deps(f))).validators[0].state, "settling");
  }
  f.now = at(22);
  assert.equal((await runReconcile(deps(f))).validators[0].state, "imported");
});

test("R2: the deposit exemption expires 24 hours after the deposit was recorded", async () => {
  const f = fixture({ approved: new Map([[pk("1"), { source: "deposit", approvedAt: new Date(T0.getTime() - 24 * 3600_000).toISOString() }]]) });
  onlyKey1(f);
  const s = await runReconcile(deps(f));
  assert.equal(s.validators[0].state, "settling");
  assert.equal(f.kms.teku!.imported.length, 0);
  const g = fixture({ approved: new Map([[pk("1"), { source: "deposit", approvedAt: new Date(T0.getTime() - 23 * 3600_000).toISOString() }]]) });
  onlyKey1(g);
  assert.equal((await runReconcile(deps(g))).validators[0].state, "imported");
});

test("R3: 20 minutes are not enough without 4 spaced absent observations", async () => {
  const f = fixture({ approved: approvals(owner, pk("1")) });
  onlyKey1(f);
  for (const m of [0, 10, 20]) {
    f.now = at(m);
    assert.equal((await runReconcile(deps(f))).validators[0].state, "settling", `at ${m}`);
  }
  assert.equal(f.absence.get(pk("1"))!.count, 3);
  // runs closer than 4 minutes (triggers) count once
  f.now = at(21);
  assert.equal((await runReconcile(deps(f))).validators[0].state, "settling");
  assert.equal(f.absence.get(pk("1"))!.count, 3);
  f.now = at(24);
  assert.equal((await runReconcile(deps(f))).validators[0].state, "imported");
});
