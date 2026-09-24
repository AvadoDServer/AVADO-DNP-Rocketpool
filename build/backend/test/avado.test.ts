import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { after, before, test } from "node:test";
import { startHarness, TOKEN, type Harness } from "./helpers";

let h: Harness;
let supervisor: http.Server;
let supervisorState = "RUNNING";

before(async () => {
  h = await startHarness();
  supervisor = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      assert.match(body, /supervisor\.getProcessInfo/);
      assert.match(body, /<string>rocketpool-node<\/string>/);
      res.writeHead(200, { "Content-Type": "text/xml" });
      res.end(`<?xml version='1.0'?><methodResponse><params><param><value><struct>
<member><name>name</name><value><string>rocketpool-node</string></value></member>
<member><name>statename</name><value><string>${supervisorState}</string></value></member>
<member><name>start</name><value><int>1790000000</int></value></member>
<member><name>exitstatus</name><value><int>1</int></value></member>
<member><name>description</name><value><string>pid 42, uptime 1:00:00</string></value></member>
</struct></value></param></params></methodResponse>`);
    });
  });
  await new Promise<void>((r) => supervisor.listen(h.config.supervisorSocket, () => r()));
  h.setUpstream(() => ({ body: '{"status":"success","error":""}' }));
});
after(async () => {
  await new Promise((r) => supervisor.close(r));
  await h.close();
});

test("status reports version, daemon state, backups, legacy mnemonic, network and errors", async () => {
  const d = h.config.dataDir;
  await writeFile(path.join(d, "wallet"), "{}");
  await writeFile(path.join(d, "mnemonic"), "legal winner thank year wave sausage worth useful legal winner thank yellow");
  await mkdir(path.join(h.config.backupDir, "0.0.106-20260923T100000Z"), { recursive: true });
  await writeFile(
    h.config.daemonLogFile,
    [
      "2026/09/23 10:00:00 Starting node daemon",
      `2026/09/23 10:00:01 \x1b[31mERROR\x1b[0m could not connect, token ${TOKEN}`,
      "2026/09/23 10:00:02 all good",
    ].join("\n") + "\n",
  );
  const r = await h.request("GET", "/api/avado/status");
  assert.equal(r.status, 200);
  const s = r.json;
  assert.equal(s.status, "success");
  assert.equal(s.packageVersion, "1.0.0-test");
  assert.equal(s.network, "mainnet");
  assert.equal(s.networkSupported, true);
  assert.equal(s.daemon.state, "RUNNING");
  assert.equal(s.daemon.since, new Date(1790000000 * 1000).toISOString());
  assert.equal(s.apiTokenPresent, true);
  assert.equal(s.walletFilePresent, true);
  assert.equal(s.passwordFilePresent, false);
  assert.equal(s.legacyMnemonicPresent, true);
  assert.deepEqual(
    s.backups.map((b: { name: string; kind: string }) => [b.name, b.kind]),
    [["0.0.106-20260923T100000Z", "upgrade"]],
  );
  assert.equal(s.daemonErrors.length, 1);
  assert.match(s.daemonErrors[0], /ERROR could not connect/);
  assert.ok(!r.text.includes(TOKEN));
  assert.ok(!r.text.includes("legal winner"), "mnemonic content leaked");
  assert.equal(s.startupError, null);
});

test("status shows a stopped daemon and the start script's error", async () => {
  supervisorState = "FATAL";
  await writeFile(h.config.startupErrorFile, "Network holesky is not supported\n");
  const r = await h.request("GET", "/api/avado/status");
  assert.equal(r.json.daemon.state, "FATAL");
  assert.equal(r.json.daemon.exitStatus, 1);
  assert.equal(r.json.startupError, "Network holesky is not supported");
  supervisorState = "RUNNING";
});

test("status degrades when supervisord is not reachable", async () => {
  const other = await startHarness({ NETWORK: "holesky" });
  try {
    const r = await other.request("GET", "/api/avado/status");
    assert.equal(r.status, 200);
    assert.equal(r.json.daemon.state, "UNKNOWN");
    assert.equal(r.json.networkSupported, false);
    assert.deepEqual(r.json.backups, []);
  } finally {
    await other.close();
  }
});

test("status includes settings (auto-tx thresholds) when the rendered settings file is present and valid", async () => {
  const settingsFile = path.join(h.root, "user-settings.yml");
  await writeFile(
    settingsFile,
    [
      "smartnode:",
      '  manualMaxFee: "0"',
      '  priorityFee: "1"',
      '  minipoolStakeGasThreshold: "20"',
      '  distributeThreshold: "1"',
      "",
    ].join("\n"),
  );
  const other = await startHarness({ SETTINGS_FILE: settingsFile });
  try {
    const r = await other.request("GET", "/api/avado/status");
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.settings, {
      autoTxGasThreshold: "20",
      minipoolStakeGasThreshold: "20",
      manualMaxFee: "0",
      priorityFee: "1",
      distributeThreshold: "1",
      units: {
        autoTxGasThreshold: "gwei",
        minipoolStakeGasThreshold: "gwei",
        manualMaxFee: "gwei",
        priorityFee: "gwei",
        distributeThreshold: "ETH",
      },
    });
  } finally {
    await other.close();
  }
});

test("status omits settings (never fails) when the rendered settings file is missing or unparseable", async () => {
  const missing = await startHarness({ SETTINGS_FILE: path.join(h.root, "no-such-settings-file.yml") });
  try {
    const r = await missing.request("GET", "/api/avado/status");
    assert.equal(r.status, 200);
    assert.equal("settings" in r.json, false);
  } finally {
    await missing.close();
  }

  const garbageFile = path.join(h.root, "garbage-settings.yml");
  await writeFile(garbageFile, "not: yaml: at: all: {{{\n");
  const garbage = await startHarness({ SETTINGS_FILE: garbageFile });
  try {
    const r = await garbage.request("GET", "/api/avado/status");
    assert.equal(r.status, 200);
    assert.equal("settings" in r.json, false);
  } finally {
    await garbage.close();
  }
});

test("logs returns the redacted tail", async () => {
  const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`);
  lines.push(`Authorization: Bearer ${TOKEN}`);
  await writeFile(h.config.daemonLogFile, lines.join("\n") + "\n");
  const r = await h.request("GET", "/api/avado/logs?tail=5");
  assert.equal(r.status, 200);
  assert.equal(r.json.available, true);
  assert.equal(r.json.lines.length, 5);
  assert.equal(r.json.lines[0], "line 46");
  assert.ok(!r.text.includes(TOKEN));
  const bad = await h.request("GET", "/api/avado/logs?tail=abc");
  assert.equal(bad.json.lines.length, 51);
  const huge = await h.request("GET", "/api/avado/logs?tail=999999");
  assert.equal(huge.json.lines.length, 51);
});

test("logs without a log file says so", async () => {
  const other = await startHarness();
  try {
    const r = await other.request("GET", "/api/avado/logs");
    assert.deepEqual(r.json, { status: "success", error: "", available: false, lines: [] });
  } finally {
    await other.close();
  }
});

test("reconcile status: not available until the loop writes it, then passed through", async () => {
  const r1 = await h.request("GET", "/api/avado/reconcile");
  assert.equal(r1.json.available, false);
  assert.equal(r1.json.runRequested, false);
  await writeFile(h.config.reconcileStatusFile, JSON.stringify({ client: "teku", keysInSync: 3, keysTotal: 3 }));
  const r2 = await h.request("GET", "/api/avado/reconcile");
  assert.equal(r2.json.available, true);
  assert.deepEqual(r2.json.status, { client: "teku", keysInSync: 3, keysTotal: 3 });
  assert.ok(r2.json.updatedAt);
});

test("reconcile/run touches the trigger file (POST only)", async () => {
  const g = await h.request("GET", "/api/avado/reconcile/run");
  assert.equal(g.status, 405);
  const r = await h.post("/api/avado/reconcile/run");
  assert.equal(r.status, 202);
  assert.ok((await readFile(h.config.reconcileTriggerFile, "utf8")).length > 0);
  const s = await h.request("GET", "/api/avado/reconcile");
  assert.equal(s.json.runRequested, true);
});

test("own GET endpoints refuse POST", async () => {
  assert.equal((await h.post("/api/avado/status")).status, 405);
  assert.equal((await h.post("/api/avado/logs")).status, 405);
});
