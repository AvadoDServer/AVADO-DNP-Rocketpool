import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { readAutoTxSettings } from "../src/avado/settings";

let root: string;
before(async () => (root = await mkdtemp(path.join(os.tmpdir(), "rp-settings-"))));
after(async () => rm(root, { recursive: true, force: true }));

async function file(name: string, contents: string): Promise<string> {
  const p = path.join(root, name);
  await writeFile(p, contents);
  return p;
}

// A trimmed-down real rendering of build/user-settings.template.
const RENDERED = `# Smartnode native-mode settings, rendered by start-node.sh on every start.
# Do not edit on the box: it is overwritten on each start.
root:
  version: v1.24.2
  isNative: "true"
  rpDir: /srv/rocketpool
  executionClientMode: external
  executionClient: geth
  consensusClientMode: external
  externalConsensusClient: teku
  useFallbackClients: "false"
smartnode:
  projectName: rocketpool
  network: mainnet
  dataPath: /rocketpool/data
  # Gas (gwei). manualMaxFee 0 = use the network estimate; the backend always
  # sends an explicit maxFee for transactions the owner confirms.
  manualMaxFee: "0"
  priorityFee: "1"
  # "Automatic TX Gas Threshold"
  minipoolStakeGasThreshold: "20"
  # Auto-distribute a minipool once its EL balance exceeds this (ETH).
  distributeThreshold: "1"
  rewardsTreeMode: download
  verifyProposals: "false"
native:
  ecHttpUrl: http://ethchain-geth.my.ava.do:8545
  ccHttpUrl: http://beacon-chain-teku.my.ava.do:3500
  consensusClient: teku
  validatorRestartCommand: /srv/rocketpool/signal-reconcile.sh
  validatorStopCommand: /srv/rocketpool/signal-reconcile.sh
api:
  apiPort: "8280"
  openApiPort: localhost
  tokenScope: all
  rateLimit: "0"
`;

test("reads the numeric smartnode settings from a real rendering, as strings, with units", async () => {
  const p = await file("user-settings.yml", RENDERED);
  const settings = await readAutoTxSettings(p);
  assert.ok(settings);
  assert.equal(settings.manualMaxFee, "0");
  assert.equal(settings.priorityFee, "1");
  assert.equal(settings.minipoolStakeGasThreshold, "20");
  assert.equal(settings.autoTxGasThreshold, "20");
  assert.equal(settings.distributeThreshold, "1");
  assert.equal(settings.autoTxMaxFee, undefined);
  assert.deepEqual(settings.units, {
    autoTxGasThreshold: "gwei",
    minipoolStakeGasThreshold: "gwei",
    manualMaxFee: "gwei",
    priorityFee: "gwei",
    distributeThreshold: "ETH",
  });
});

test("includes autoTxMaxFee (and its unit) only when the file has it", async () => {
  const withFee = RENDERED.replace('minipoolStakeGasThreshold: "20"', 'minipoolStakeGasThreshold: "20"\n  autoTxMaxFee: "30"');
  const p = await file("with-max-fee.yml", withFee);
  const settings = await readAutoTxSettings(p);
  assert.ok(settings);
  assert.equal(settings.autoTxMaxFee, "30");
  assert.equal(settings.units.autoTxMaxFee, "gwei");
});

test("single-quoted and unquoted-but-irrelevant values are handled", async () => {
  const withQuotes = RENDERED.replace('priorityFee: "1"', "priorityFee: '1'");
  const p = await file("single-quoted.yml", withQuotes);
  const settings = await readAutoTxSettings(p);
  assert.ok(settings);
  assert.equal(settings.priorityFee, "1");
});

test("returns null when the file is missing", async () => {
  const settings = await readAutoTxSettings(path.join(root, "does-not-exist.yml"));
  assert.equal(settings, null);
});

test("returns null when the smartnode section is missing entirely", async () => {
  const p = await file("no-smartnode.yml", "root:\n  version: v1.24.2\napi:\n  apiPort: \"8280\"\n");
  assert.equal(await readAutoTxSettings(p), null);
});

test("returns null when a required key is missing", async () => {
  const missingKey = RENDERED.replace('  distributeThreshold: "1"\n', "");
  const p = await file("missing-key.yml", missingKey);
  assert.equal(await readAutoTxSettings(p), null);
});

test("returns null when a required value isn't a plain number", async () => {
  const bad = RENDERED.replace('manualMaxFee: "0"', 'manualMaxFee: "not-a-number"');
  const p = await file("bad-value.yml", bad);
  assert.equal(await readAutoTxSettings(p), null);
});

test("a same-named key in another section is never picked up", async () => {
  // "rateLimit" under api: must not leak into smartnode's namespace, and a
  // decoy indented under `native:` must not be read as a smartnode key.
  const decoy = RENDERED.replace("native:\n", "native:\n  manualMaxFee: \"999\"\n");
  const p = await file("decoy.yml", decoy);
  const settings = await readAutoTxSettings(p);
  assert.ok(settings);
  assert.equal(settings.manualMaxFee, "0");
});

test("empty file is not parsed as valid settings", async () => {
  const p = await file("empty.yml", "");
  assert.equal(await readAutoTxSettings(p), null);
});

test("no secret-looking content ever appears in the parsed keys", async () => {
  const p = await file("user-settings.yml", RENDERED);
  const settings = await readAutoTxSettings(p);
  assert.ok(settings);
  const text = JSON.stringify(settings);
  assert.doesNotMatch(text, /password|mnemonic|private/i);
});
