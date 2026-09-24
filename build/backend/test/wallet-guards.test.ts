import assert from "node:assert/strict";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import { createWalletBackup, listBackups } from "../src/backup";
import { SET_PASSWORD_WALLET_EXISTS_MESSAGE, WALLET_EXISTS_MESSAGE, WALLET_UNKNOWN_MESSAGE } from "../src/guards/wallet";
import { startHarness, type Harness } from "./helpers";

let h: Harness | undefined;
const MNEMONIC = "legal winner thank year wave sausage worth useful legal winner thank yellow";
const PRIVATE_KEY = "0x" + "4c".repeat(32);

beforeEach(async () => {
  await h?.close();
  h = await startHarness();
  h.setUpstream((call) => {
    if (call.path === "/api/wallet/status")
      return { body: '{"status":"success","error":"","walletInitialized":false,"passwordSet":false}' };
    if (call.path === "/api/wallet/init")
      return { body: JSON.stringify({ status: "success", error: "", mnemonic: MNEMONIC, accountAddress: "0x1" }) };
    if (call.path === "/api/wallet/export")
      return {
        body: JSON.stringify({ status: "success", error: "", password: "s3cretpass", wallet: "{}", accountPrivateKey: PRIVATE_KEY }),
      };
    return { body: '{"status":"success","error":"","accountAddress":"0x1","validatorKeys":[]}' };
  });
});
after(async () => h?.close());

async function seedWallet(dataDir: string) {
  await writeFile(path.join(dataDir, "wallet"), '{"crypto":"original-wallet"}', { mode: 0o600 });
  await writeFile(path.join(dataDir, "password"), "original-password", { mode: 0o600 });
  await mkdir(path.join(dataDir, "validators", "teku", "keys"), { recursive: true });
  await writeFile(path.join(dataDir, "validators", "teku", "keys", "0xabc.json"), '{"k":1}');
}

const walletCalls = (hh: Harness, p: string) => hh.calls.filter((c) => c.path === p);

for (const route of ["wallet/init", "wallet/recover", "wallet/search-and-recover"]) {
  test(`${route} is refused (409) when a wallet file exists`, async () => {
    await seedWallet(h!.config.dataDir);
    const r = await h!.post(`/api/sn/${route}`, { mnemonic: MNEMONIC });
    assert.equal(r.status, 409);
    assert.equal(r.json.error, WALLET_EXISTS_MESSAGE);
    assert.equal(walletCalls(h!, `/api/${route}`).length, 0);
  });

  test(`${route} is refused when Smartnode reports a wallet even without a file`, async () => {
    h!.setUpstream(() => ({ body: '{"status":"success","error":"","walletInitialized":true,"passwordSet":true}' }));
    const r = await h!.post(`/api/sn/${route}`, { mnemonic: MNEMONIC });
    assert.equal(r.status, 409);
    assert.equal(walletCalls(h!, `/api/${route}`).length, 0);
  });
}

test("with no wallet, wallet/init is forwarded and its response is not logged", async () => {
  const r = await h!.post("/api/sn/wallet/init", { derivationPath: "" });
  assert.equal(r.status, 200);
  assert.equal(r.json.mnemonic, MNEMONIC);
  assert.ok(!h!.logs.join("\n").includes("legal winner"), "mnemonic logged");
});

test("replaceExisting=true does not bypass the guard; wallet files are never touched", async () => {
  const d = h!.config.dataDir;
  await seedWallet(d);
  for (const route of ["wallet/init", "wallet/recover", "wallet/search-and-recover"]) {
    const r = await h!.post(`/api/sn/${route}`, { mnemonic: MNEMONIC, replaceExisting: true });
    assert.equal(r.status, 409, route);
    assert.equal(r.json.error, WALLET_EXISTS_MESSAGE);
    assert.equal(walletCalls(h!, `/api/${route}`).length, 0, route);
  }
  assert.equal(await readFile(path.join(d, "wallet"), "utf8"), '{"crypto":"original-wallet"}');
  assert.equal(await readFile(path.join(d, "password"), "utf8"), "original-password");
  // no backup made, nothing moved
  await assert.rejects(readdir(h!.config.backupDir));
  assert.ok(!h!.logs.join("\n").includes("legal winner"), "mnemonic logged");
});

test("wallet/set-password is refused when a password file exists", async () => {
  await writeFile(path.join(h!.config.dataDir, "password"), "x");
  const r = await h!.post("/api/sn/wallet/set-password", { password: "newpassword1" });
  assert.equal(r.status, 409);
  assert.equal(walletCalls(h!, "/api/wallet/set-password").length, 0);
});

test("wallet/set-password is refused when Smartnode reports a password", async () => {
  h!.setUpstream(() => ({ body: '{"status":"success","error":"","walletInitialized":false,"passwordSet":true}' }));
  const r = await h!.post("/api/sn/wallet/set-password", { password: "newpassword1" });
  assert.equal(r.status, 409);
  assert.equal(walletCalls(h!, "/api/wallet/set-password").length, 0);
});

test("wallet/set-password is refused (409, contact support) when a wallet file exists but its password file is missing", async () => {
  const d = h!.config.dataDir;
  await writeFile(path.join(d, "wallet"), '{"crypto":"original-wallet"}', { mode: 0o600 });
  const r = await h!.post("/api/sn/wallet/set-password", { password: "newpassword1" });
  assert.equal(r.status, 409);
  assert.equal(r.json.error, SET_PASSWORD_WALLET_EXISTS_MESSAGE);
  assert.match(r.json.error, /support@ava\.do/);
  assert.equal(walletCalls(h!, "/api/wallet/set-password").length, 0);
  assert.equal(await readFile(path.join(d, "wallet"), "utf8"), '{"crypto":"original-wallet"}');
  await assert.rejects(readFile(path.join(d, "password")));
});

test("wallet/set-password is refused when Smartnode reports a wallet but no password", async () => {
  h!.setUpstream(() => ({ body: '{"status":"success","error":"","walletInitialized":true,"passwordSet":false}' }));
  const r = await h!.post("/api/sn/wallet/set-password", { password: "newpassword1" });
  assert.equal(r.status, 409);
  assert.equal(r.json.error, SET_PASSWORD_WALLET_EXISTS_MESSAGE);
  assert.equal(walletCalls(h!, "/api/wallet/set-password").length, 0);
});

test("wallet/set-password is forwarded when no password is set, and the password is not logged", async () => {
  const r = await h!.post("/api/sn/wallet/set-password", { password: "newpassword1" });
  assert.equal(r.status, 200);
  assert.equal(walletCalls(h!, "/api/wallet/set-password")[0]!.body, "password=newpassword1");
  assert.ok(!h!.logs.join("\n").includes("newpassword1"));
});

test("wallet/export needs the typed confirmation; its response is never logged", async () => {
  const bad = await h!.post("/api/sn/wallet/export", { typedConfirmation: "export" });
  assert.equal(bad.status, 400);
  assert.equal(walletCalls(h!, "/api/wallet/export").length, 0);
  const ok = await h!.post("/api/sn/wallet/export", { typedConfirmation: "EXPORT" });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.accountPrivateKey, PRIVATE_KEY);
  assert.equal(walletCalls(h!, "/api/wallet/export")[0]!.body, "");
  const logs = h!.logs.join("\n");
  assert.ok(!logs.includes(PRIVATE_KEY) && !logs.includes("s3cretpass"));
});

test("createWalletBackup refuses when there is no wallet, and leaves no partial directory", async () => {
  await assert.rejects(
    createWalletBackup({ dataDir: h!.config.dataDir, backupDir: h!.config.backupDir, reason: "before-wallet-change" }),
    /wallet not found/,
  );
  assert.deepEqual(await readdir(h!.config.backupDir), []);
});

test("createWalletBackup also copies address, custom-keys and custom-key-passwords when present", async () => {
  const d = h!.config.dataDir;
  await seedWallet(d);
  await writeFile(path.join(d, "address"), "0x" + "1".repeat(40));
  await mkdir(path.join(d, "custom-keys"), { recursive: true });
  await writeFile(path.join(d, "custom-keys", "k.json"), "{}");
  await writeFile(path.join(d, "custom-key-passwords"), "x: y");
  const a = await createWalletBackup({ dataDir: d, backupDir: h!.config.backupDir, reason: "manual-download", info: { kind: "manual", reason: "download" } });
  assert.deepEqual(a.items, ["wallet", "password", "validators", "address", "custom-keys", "custom-key-passwords"]);
  assert.equal(await readFile(path.join(a.path, "custom-keys", "k.json"), "utf8"), "{}");
  const info = JSON.parse(await readFile(path.join(a.path, "backup-info.json"), "utf8"));
  assert.deepEqual({ ...info, createdAt: undefined }, { kind: "manual", reason: "download", keepForever: true, items: a.items, createdAt: undefined });
});

test("createWalletBackup includes the legacy mnemonic file and never reuses a directory", async () => {
  const d = h!.config.dataDir;
  await seedWallet(d);
  await writeFile(path.join(d, "mnemonic"), MNEMONIC);
  const now = new Date("2026-09-23T10:00:00Z");
  const a = await createWalletBackup({ dataDir: d, backupDir: h!.config.backupDir, reason: "before-wallet-change", now });
  const b = await createWalletBackup({ dataDir: d, backupDir: h!.config.backupDir, reason: "before-wallet-change", now });
  assert.equal(a.name, "20260923T100000Z-before-wallet-change");
  assert.equal(b.name, "20260923T100000Z-before-wallet-change-2");
  assert.deepEqual(a.items, ["wallet", "password", "validators", "mnemonic"]);
  // no backup-info.json unless asked for
  assert.deepEqual((await readdir(a.path)).sort(), ["mnemonic", "password", "validators", "wallet"]);
  assert.equal(await readFile(path.join(a.path, "mnemonic"), "utf8"), MNEMONIC);
  assert.equal(await readFile(path.join(d, "mnemonic"), "utf8"), MNEMONIC);
});

for (const route of ["wallet/init", "wallet/recover", "wallet/search-and-recover", "wallet/set-password"]) {
  test(`${route} fails closed (503) when Smartnode's wallet/status answers with an error`, async () => {
    h!.setUpstream(() => ({ status: 500, body: '{"status":"error","error":"daemon busy"}' }));
    const r = await h!.post(`/api/sn/${route}`, { mnemonic: MNEMONIC, password: "newpassword1" });
    assert.equal(r.status, 503);
    assert.equal(r.json.error, WALLET_UNKNOWN_MESSAGE);
    assert.equal(walletCalls(h!, `/api/${route}`).length, 0);
  });
}

test("wallet/init fails closed when there is no API token yet (daemon starting)", async () => {
  await rm(path.join(h!.config.dataDir, "api-tokens.json"));
  const r = await h!.post("/api/sn/wallet/init", {});
  assert.equal(r.status, 503);
  assert.equal(r.json.error, WALLET_UNKNOWN_MESSAGE);
  assert.equal(h!.calls.length, 0);
});

test("wallet/recover fails closed when the daemon is unreachable", async () => {
  const down = await startHarness({ SN_API: "http://127.0.0.1:1" });
  try {
    const r = await down.post("/api/sn/wallet/recover", { mnemonic: MNEMONIC });
    assert.equal(r.status, 503);
    assert.equal(r.json.error, WALLET_UNKNOWN_MESSAGE);
  } finally {
    await down.close();
  }
});

test("a wallet file still wins (409) even when the daemon can't be asked", async () => {
  await seedWallet(h!.config.dataDir);
  h!.setUpstream(() => ({ status: 500, body: '{"status":"error","error":"x"}' }));
  const r = await h!.post("/api/sn/wallet/init", {});
  assert.equal(r.status, 409);
});

// ---------- backup right after the wallet is first created ----------

/** A Smartnode stand-in whose recover routes save a wallet the way the daemon does. */
function daemonThatSavesWallet(hh: Harness, reply: { status?: number; body: string } = { body: '{"status":"success","error":"","accountAddress":"0x1","validatorKeys":[]}' }) {
  hh.setUpstream(async (call) => {
    if (call.path === "/api/wallet/status")
      return { body: '{"status":"success","error":"","walletInitialized":false,"passwordSet":true}' };
    if (call.path === "/api/wallet/recover" || call.path === "/api/wallet/search-and-recover") {
      if ((reply.status ?? 200) === 200) {
        await writeFile(path.join(hh.config.dataDir, "wallet"), '{"crypto":"new-wallet"}', { mode: 0o600 });
        await mkdir(path.join(hh.config.dataDir, "validators"), { recursive: true });
      }
      return reply;
    }
    return { body: '{"status":"success","error":""}' };
  });
}

for (const route of ["wallet/recover", "wallet/search-and-recover"]) {
  test(`${route}: the new wallet is backed up right away (never-pruned <ts>-after-wallet-create with kind wallet-create)`, async () => {
    const d = h!.config.dataDir;
    await writeFile(path.join(d, "password"), "the-password", { mode: 0o600 });
    daemonThatSavesWallet(h!);
    const r = await h!.post(`/api/sn/${route}`, { mnemonic: MNEMONIC, address: "0x1" });
    assert.equal(r.status, 200);
    const dirs = await readdir(h!.config.backupDir);
    assert.equal(dirs.length, 1);
    assert.match(dirs[0]!, /^\d{8}T\d{6}Z-after-wallet-create$/);
    const b = path.join(h!.config.backupDir, dirs[0]!);
    assert.equal(await readFile(path.join(b, "wallet"), "utf8"), '{"crypto":"new-wallet"}');
    assert.equal(await readFile(path.join(b, "password"), "utf8"), "the-password");
    const info = JSON.parse(await readFile(path.join(b, "backup-info.json"), "utf8"));
    assert.equal(info.kind, "wallet-create");
    assert.equal(info.keepForever, true);
    assert.equal(info.reason, route);
    assert.deepEqual(info.items, ["wallet", "password", "validators"]);
    assert.equal((await stat(path.join(b, "backup-info.json"))).mode & 0o777, 0o600);
    // the originals are untouched and nothing secret is logged
    assert.equal(await readFile(path.join(d, "wallet"), "utf8"), '{"crypto":"new-wallet"}');
    const logs = h!.logs.join("\n");
    assert.ok(logs.includes(`wallet backed up to ${dirs[0]}`), logs);
    assert.ok(!logs.includes("legal winner") && !logs.includes("the-password"));
    // the status API lists it
    const backups = await listBackups(h!.config.backupDir);
    assert.deepEqual(backups.map((x) => [x.name, x.kind]), [[dirs[0], "wallet-create"]]);
  });
}

test("wallet/recover: no backup when the daemon refuses", async () => {
  daemonThatSavesWallet(h!, { status: 500, body: '{"status":"error","error":"invalid mnemonic"}' });
  const r = await h!.post("/api/sn/wallet/recover", { mnemonic: MNEMONIC });
  assert.equal(r.status, 500);
  await assert.rejects(readdir(h!.config.backupDir));
});

test("wallet/recover: a failed backup never fails the (already saved) recovery; it is logged", async () => {
  // the daemon answers success but no wallet file appears: the backup can't be made
  h!.setUpstream((call) =>
    call.path === "/api/wallet/status"
      ? { body: '{"status":"success","error":"","walletInitialized":false,"passwordSet":true}' }
      : { body: '{"status":"success","error":"","accountAddress":"0x1","validatorKeys":[]}' },
  );
  const r = await h!.post("/api/sn/wallet/recover", { mnemonic: MNEMONIC });
  assert.equal(r.status, 200);
  assert.deepEqual(await readdir(h!.config.backupDir), []);
  assert.ok(h!.logs.some((l) => l.includes("could not back up the new wallet")), h!.logs.join("\n"));
});
