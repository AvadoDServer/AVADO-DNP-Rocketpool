import assert from "node:assert/strict";
import { test } from "node:test";
import { CLIENTS, selectClient } from "../src/reconcile/clients";
import { normalizeAddress, normalizePubkey } from "../src/reconcile/hex";
import { feeRecipientFor, parseFeeRecipientInfo, wantedKeys, type FeeRecipientInfo } from "../src/reconcile/rules";

const SP = "0x" + "5".repeat(40);
const FD = "0x" + "d".repeat(40);
const MP = "0x" + "e".repeat(40);
const pk = (c: string) => c.repeat(96);

const info = (o: Partial<FeeRecipientInfo>): FeeRecipientInfo => ({
  smoothingPoolAddress: SP,
  feeDistributorAddress: FD,
  megapoolAddress: MP,
  isInSmoothingPool: false,
  isInOptOutCooldown: false,
  ...o,
});

test("fee recipient rule table", () => {
  const rows: Array<[string, Partial<FeeRecipientInfo>, "minipool" | "megapool", string, string]> = [
    ["in SP, minipool", { isInSmoothingPool: true }, "minipool", "smoothing-pool", SP],
    ["in SP, megapool", { isInSmoothingPool: true }, "megapool", "smoothing-pool", SP],
    ["opt-out cooldown, minipool", { isInOptOutCooldown: true }, "minipool", "smoothing-pool", SP],
    ["opt-out cooldown, megapool (mixed node stays on SP)", { isInOptOutCooldown: true }, "megapool", "smoothing-pool", SP],
    ["not in SP, minipool → fee distributor", {}, "minipool", "fee-distributor", FD],
    ["not in SP, megapool → megapool (per key on a mixed node)", {}, "megapool", "megapool", MP],
  ];
  for (const [name, o, kind, rule, address] of rows) {
    assert.deepEqual(feeRecipientFor(kind, info(o)), { rule, address }, name);
  }
  // a missing address is reported as null, never as the zero address
  assert.deepEqual(feeRecipientFor("megapool", info({ megapoolAddress: null })), { rule: "megapool", address: null });
});

test("parseFeeRecipientInfo normalises addresses and drops the zero address", () => {
  const i = parseFeeRecipientInfo({
    feeRecipientInfo: {
      smoothingPoolAddress: SP.toUpperCase().replace("0X", "0x"),
      feeDistributorAddress: FD,
      megapoolAddress: "0x" + "0".repeat(40),
      isInSmoothingPool: "true",
      isInOptOutCooldown: true,
    },
  });
  assert.equal(i.smoothingPoolAddress, SP);
  assert.equal(i.megapoolAddress, null);
  assert.equal(i.isInSmoothingPool, false, "only a real boolean true counts");
  assert.equal(i.isInOptOutCooldown, true);
  assert.deepEqual(parseFeeRecipientInfo(undefined), {
    smoothingPoolAddress: null,
    feeDistributorAddress: null,
    megapoolAddress: null,
    isInSmoothingPool: false,
    isInOptOutCooldown: false,
  });
});

test("wantedKeys: live minipools and megapool validators only", () => {
  const node = {
    minipools: [
      { address: "0xa", validatorPubkey: pk("1"), status: { status: "Staking" }, finalised: false },
      { address: "0xb", validatorPubkey: pk("2"), status: { status: "Prelaunch" } },
      { address: "0xc", validatorPubkey: pk("3"), status: { status: "Dissolved" } },
      { address: "0xd", validatorPubkey: pk("4"), status: { status: "Staking" }, finalised: true },
      { address: "0xe", validatorPubkey: "not-a-key", status: { status: "Staking" } },
      { address: "0xf", validatorPubkey: "0x" + pk("A"), status: { status: "Withdrawable" } },
    ],
  };
  const mega = {
    megapoolDetails: {
      validators: [
        { validatorId: 0, pubKey: pk("5"), staked: true },
        { validatorId: 1, pubKey: pk("6"), inQueue: true },
        { validatorId: 2, pubKey: pk("7"), exited: true },
        { validatorId: 3, pubKey: pk("8"), dissolved: true },
        { validatorId: 4, pubKey: pk("1") }, // duplicate of a minipool key: first entry wins
      ],
    },
  };
  const w = wantedKeys(node, mega);
  assert.deepEqual(
    w.map((k) => [k.pubkey[0], k.kind, k.ref]),
    [
      ["1", "minipool", "0xa"],
      ["2", "minipool", "0xb"],
      ["a", "minipool", "0xf"],
      ["5", "megapool", "0"],
      ["6", "megapool", "1"],
    ],
  );
  assert.deepEqual(wantedKeys({}, undefined), []);
  assert.deepEqual(wantedKeys({ minipools: "x" }, { megapoolDetails: { validators: null } }), []);
});

test("normalizers", () => {
  assert.equal(normalizePubkey("0x" + "AB".repeat(48)), "ab".repeat(48));
  assert.equal(normalizePubkey("ab".repeat(47)), null);
  assert.equal(normalizePubkey("../" + "a".repeat(93)), null);
  assert.equal(normalizeAddress("0x" + "0".repeat(40)), null);
  assert.equal(normalizeAddress("0x" + "F".repeat(40)), "0x" + "f".repeat(40));
});

const installed = (...names: string[]) => names.map((name) => ({ name, running: true }));

test("selectClient: the configured client, never a different one", () => {
  const s1 = selectClient(installed("teku.avado.dnp.dappnode.eth", "nimbus.avado.dnp.dappnode.eth"), "nimbus");
  assert.equal(s1.chosen?.id, "nimbus");
  assert.deepEqual(s1.installed.map((c) => c.id).sort(), ["nimbus", "teku"]);

  const s2 = selectClient(installed("teku.avado.dnp.dappnode.eth"), "prysm");
  assert.equal(s2.chosen, null, "configured Prysm is not installed: do not fall back to Teku");
  assert.match(s2.reason!, /Prysm/);

  const s3 = selectClient(installed("teku.avado.dnp.dappnode.eth"), undefined);
  assert.equal(s3.chosen?.id, "teku", "no setting: the only installed client");

  const s4 = selectClient(installed("teku.avado.dnp.dappnode.eth", "lighthouse.avado.dnp.dappnode.eth"), "bogus");
  assert.equal(s4.chosen, null, "no usable setting and two clients: none");

  const s5 = selectClient(installed("prysm-beacon-chain-mainnet.avado.dnp.dappnode.eth", "eth2validator.avado.dnp.dappnode.eth"), "PRYSM");
  assert.equal(s5.chosen?.packageName, "eth2validator.avado.dnp.dappnode.eth", "Prysm keys live in the validator package");
  assert.deepEqual(s5.unknownValidatorPackages, []);
});

test("selectClient: unknown validator-like mainnet packages are flagged, testnet variants are not", () => {
  const s = selectClient(
    installed(
      "teku.avado.dnp.dappnode.eth",
      "teku-holesky.avado.dnp.dappnode.eth",
      "lodestar.avado.dnp.dappnode.eth",
      "web3signer.avado.dnp.dappnode.eth",
      "geth.avado.dnp.dappnode.eth",
      "rocketpool.avado.dnp.dappnode.eth",
    ),
    "teku",
  );
  assert.deepEqual(s.unknownValidatorPackages, ["lodestar.avado.dnp.dappnode.eth", "web3signer.avado.dnp.dappnode.eth"]);
});

test("client table: mainnet keymanager routes on :9999/keymanager", () => {
  assert.deepEqual(
    CLIENTS.map((c) => [c.id, c.packageName, c.keymanagerUrl]),
    [
      ["nimbus", "nimbus.avado.dnp.dappnode.eth", "http://nimbus.my.ava.do:9999/keymanager"],
      ["teku", "teku.avado.dnp.dappnode.eth", "http://teku.my.ava.do:9999/keymanager"],
      ["lighthouse", "lighthouse.avado.dnp.dappnode.eth", "http://lighthouse.my.ava.do:9999/keymanager"],
      ["prysm", "eth2validator.avado.dnp.dappnode.eth", "http://eth2validator.my.ava.do:9999/keymanager"],
    ],
  );
});
