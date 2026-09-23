import assert from "node:assert/strict";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import { createWalletBackup } from "../src/backup";
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

test("replaceExisting=true makes a verified backup first, then forwards without the flag", async () => {
  const d = h!.config.dataDir;
  await seedWallet(d);
  const r = await h!.post("/api/sn/wallet/recover", {
    mnemonic: MNEMONIC,
    skipValidatorKeyRecovery: "false",
    replaceExisting: true,
  });
  assert.equal(r.status, 200);
  assert.match(r.json.avadoBackup, /^\d{8}T\d{6}Z-before-wallet-change$/);
  const bdir = path.join(h!.config.backupDir, r.json.avadoBackup);
  assert.equal(await readFile(path.join(bdir, "wallet"), "utf8"), '{"crypto":"original-wallet"}');
  assert.equal(await readFile(path.join(bdir, "password"), "utf8"), "original-password");
  assert.equal(await readFile(path.join(bdir, "validators", "teku", "keys", "0xabc.json"), "utf8"), '{"k":1}');
  // originals untouched
  assert.equal(await readFile(path.join(d, "wallet"), "utf8"), '{"crypto":"original-wallet"}');
  assert.equal(await readFile(path.join(d, "password"), "utf8"), "original-password");
  const fwd = walletCalls(h!, "/api/wallet/recover");
  assert.equal(fwd.length, 1);
  assert.ok(!fwd[0]!.body.includes("replaceExisting"));
  assert.ok(fwd[0]!.body.includes("skipValidatorKeyRecovery=false"));
  assert.ok(!h!.logs.join("\n").includes("legal winner"), "mnemonic logged");
});

test("replaceExisting=true with a failing backup refuses and forwards nothing", async () => {
  await seedWallet(h!.config.dataDir);
  // make the backup dir unusable: a file where the directory should be
  await mkdir(path.dirname(h!.config.backupDir), { recursive: true });
  await writeFile(h!.config.backupDir, "not a dir");
  const r = await h!.post("/api/sn/wallet/recover", { mnemonic: MNEMONIC, replaceExisting: "true" });
  assert.equal(r.status, 500);
  assert.match(r.json.error, /backup failed/);
  assert.equal(walletCalls(h!, "/api/wallet/recover").length, 0);
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
  assert.equal(await readFile(path.join(a.path, "mnemonic"), "utf8"), MNEMONIC);
  assert.equal(await readFile(path.join(d, "mnemonic"), "utf8"), MNEMONIC);
});
