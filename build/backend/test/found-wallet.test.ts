import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { adoptFoundWallet, findWallets, FOUND_WALLET_MAX_ENTRIES } from "../src/avado/found-wallet";
import { restartProcess } from "../src/avado/supervisor";
import { HttpError } from "../src/http-util";
import { startHarness, type Harness } from "./helpers";

const WALLET = JSON.stringify({
  crypto: { cipher: "aes-128-ctr", ciphertext: "00", kdf: "scrypt" },
  name: "",
  version: 3,
  uuid: "6f1b3c1e-0000-4000-8000-000000000000",
  derivationPath: "m/44'/60'/0'/0/%d",
  walletIndex: 0,
  nextAccount: 1,
});
const ADDRESS = "0xAbCdEf0123456789abcdef0123456789ABCDEF01";
const exists = (p: string) => lstat(p).then(() => true, () => false);

/** A wallet directory: wallet + password (+ address, validators/, custom-keys/), wallet mtime set. */
async function makeWallet(
  dir: string,
  opts: { address?: string | null; validators?: boolean; customKeys?: boolean; mtime?: Date; password?: string } = {},
): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "wallet"), WALLET, { mode: 0o600 });
  await writeFile(path.join(dir, "password"), opts.password ?? "fixture-password", { mode: 0o600 });
  if (opts.address !== null) await writeFile(path.join(dir, "address"), (opts.address ?? ADDRESS) + "\n");
  if (opts.validators) {
    await mkdir(path.join(dir, "validators", "teku", "keys"), { recursive: true });
    await mkdir(path.join(dir, "validators", "teku", "passwords"), { recursive: true });
    await writeFile(path.join(dir, "validators", "teku", "keys", "0xaa.json"), '{"pubkey":"aa"}');
    await writeFile(path.join(dir, "validators", "teku", "passwords", "0xaa.txt"), "pw");
  }
  if (opts.customKeys) {
    await mkdir(path.join(dir, "custom-keys"), { recursive: true });
    await writeFile(path.join(dir, "custom-keys", "keystore-1.json"), '{"k":1}');
  }
  if (opts.mtime) await utimes(path.join(dir, "wallet"), opts.mtime, opts.mtime);
}

/** sha256 of every file under dir (relative path -> hash), plus modes and mtimes: proves a tree is untouched. */
async function treeSum(dir: string, rel = ""): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const abs = path.join(dir, rel);
  const st = await lstat(abs);
  out[rel || "."] = `${st.mode.toString(8)} ${st.isDirectory() ? "dir" : st.mtimeMs}`;
  if (st.isDirectory()) {
    for (const e of (await readdir(abs)).sort()) Object.assign(out, await treeSum(dir, path.join(rel, e)));
  } else if (st.isFile()) {
    out[rel] += " " + createHash("sha256").update(await readFile(abs)).digest("hex");
  }
  return out;
}

let root: string;
let vol: string;
let dataDir: string;
let opts: Parameters<typeof adoptFoundWallet>[0];
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "rp-found-"));
  vol = path.join(root, "rocketpool");
  dataDir = path.join(vol, "data");
  await mkdir(dataDir, { recursive: true });
  opts = {
    volumeRoot: vol,
    dataDir,
    supervisorSocket: path.join(root, "no-such-supervisor.sock"),
    daemonProgram: "rocketpool-node",
    reconcileTriggerFile: path.join(root, "reconcile-now"),
  };
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

// ---------- findWallets ----------

test("findWallets: a wallet in an automatic backup is one candidate with its address and validators", async () => {
  const mtime = new Date("2026-10-06T20:00:06Z");
  await makeWallet(path.join(vol, "backups", "legacy-x"), { validators: true, mtime });
  await makeWallet(path.join(vol, "backups", "legacy-y"), { address: null, mtime: new Date("2026-10-01T00:00:00Z") });
  const found = await findWallets({ volumeRoot: vol, dataDir });
  assert.deepEqual(found, [
    { dir: "backups/legacy-x", address: ADDRESS, modifiedAt: mtime.toISOString(), hasValidators: true, source: "backup" },
    {
      dir: "backups/legacy-y",
      address: null,
      modifiedAt: "2026-10-01T00:00:00.000Z",
      hasValidators: false,
      source: "backup",
    },
  ]);
});

test("findWallets: root-level and nested old layouts are found, newest first; the data dir itself is skipped", async () => {
  await makeWallet(vol, { mtime: new Date("2025-01-01T00:00:00Z") });
  await makeWallet(path.join(vol, "old", ".rocketpool", "data"), { mtime: new Date("2026-01-01T00:00:00Z") });
  await makeWallet(dataDir, { mtime: new Date("2026-12-01T00:00:00Z") });
  const found = await findWallets({ volumeRoot: vol, dataDir });
  assert.deepEqual(
    found.map((f) => [f.dir, f.source]),
    [
      ["old/.rocketpool/data", "other"],
      ["", "other"],
    ],
  );
});

test("findWallets: the data dir is skipped even when given with a trailing slash or as a relative-looking path", async () => {
  await makeWallet(dataDir);
  assert.deepEqual(await findWallets({ volumeRoot: vol, dataDir: dataDir + "/" }), []);
  assert.deepEqual(await findWallets({ volumeRoot: vol + "/", dataDir: path.join(vol, ".", "data") }), []);
});

test("findWallets: ignores everything that is not a usable wallet", async () => {
  const d = (...p: string[]) => path.join(vol, ...p);
  // wallet without password
  await mkdir(d("nopw"), { recursive: true });
  await writeFile(d("nopw", "wallet"), WALLET);
  // password without wallet
  await mkdir(d("nowallet"), { recursive: true });
  await writeFile(d("nowallet", "password"), "pw");
  // empty password, password over 4096 bytes, password that is a directory
  await makeWallet(d("emptypw"), { password: "" });
  await makeWallet(d("hugepw"), { password: "x".repeat(4097) });
  await mkdir(d("dirpw"), { recursive: true });
  await writeFile(d("dirpw", "wallet"), WALLET);
  await mkdir(d("dirpw", "password"));
  // not JSON / JSON without a crypto object / crypto not an object
  await makeWallet(d("notjson"));
  await writeFile(d("notjson", "wallet"), "not json at all");
  await makeWallet(d("nocrypto"));
  await writeFile(d("nocrypto", "wallet"), JSON.stringify({ name: "x", version: 3 }));
  await makeWallet(d("cryptostring"));
  await writeFile(d("cryptostring", "wallet"), JSON.stringify({ crypto: "fixture-wallet" }));
  await makeWallet(d("cryptonull"));
  await writeFile(d("cryptonull", "wallet"), JSON.stringify({ crypto: null }));
  await makeWallet(d("array"));
  await writeFile(d("array", "wallet"), JSON.stringify([{ crypto: {} }]));
  // over 64 KiB
  await makeWallet(d("huge"));
  await writeFile(d("huge", "wallet"), JSON.stringify({ crypto: {}, pad: "x".repeat(64 * 1024) }));
  // a wallet that is a directory
  await mkdir(d("dirwallet", "wallet"), { recursive: true });
  await writeFile(d("dirwallet", "password"), "pw");
  // symlinked wallet file; symlinked directory holding a wallet (target outside the volume)
  await makeWallet(path.join(root, "outside"));
  await mkdir(d("linkfile"), { recursive: true });
  await symlink(path.join(root, "outside", "wallet"), d("linkfile", "wallet"));
  await writeFile(d("linkfile", "password"), "pw");
  await symlink(path.join(root, "outside"), d("linkdir"));
  // skipped directories
  await makeWallet(d("data", "rewards-trees"));
  await makeWallet(d("rewards-trees", "x"));
  await makeWallet(d("node_modules"));
  await makeWallet(d("backups", ".partial-x"));
  await makeWallet(d("backups", "mnemonic-archive-20260101T000000Z"));
  // depth 7 (a/b/c/d/e/f/wallet) is too deep
  await makeWallet(d("a", "b", "c", "d", "e", "f"));

  assert.deepEqual(await findWallets({ volumeRoot: vol, dataDir }), []);
});

test("findWallets: depth 6 (a/b/c/d/e/wallet) is still found", async () => {
  await makeWallet(path.join(vol, "a", "b", "c", "d", "e"));
  assert.deepEqual(
    (await findWallets({ volumeRoot: vol, dataDir })).map((f) => f.dir),
    ["a/b/c/d/e"],
  );
});

test("findWallets: an address file with junk gives address null; any hex case is accepted", async () => {
  await makeWallet(path.join(vol, "junk"), { address: "0x1234" });
  await makeWallet(path.join(vol, "words"), { address: "not an address at all, but long enough to be forty chars" });
  await makeWallet(path.join(vol, "lower"), { address: ADDRESS.toLowerCase() });
  const byDir = Object.fromEntries((await findWallets({ volumeRoot: vol, dataDir })).map((f) => [f.dir, f.address]));
  assert.deepEqual(byDir, { junk: null, words: null, lower: ADDRESS.toLowerCase() });
});

test("findWallets: at most 10 results, the newest", async () => {
  for (let i = 0; i < 12; i++) {
    await makeWallet(path.join(vol, "backups", `b${String(i).padStart(2, "0")}`), {
      mtime: new Date(Date.UTC(2026, 0, 1 + i)),
    });
  }
  const found = await findWallets({ volumeRoot: vol, dataDir });
  assert.equal(found.length, 10);
  assert.equal(found[0]!.dir, "backups/b11");
  assert.equal(found[9]!.dir, "backups/b02");
});

test("findWallets: stops quietly after visiting the entry limit", async () => {
  const big = path.join(vol, "aaa");
  await mkdir(big, { recursive: true });
  for (let i = 0; i < FOUND_WALLET_MAX_ENTRIES; i++) await writeFile(path.join(big, `f${i}`), "");
  await makeWallet(path.join(vol, "zzz"));
  assert.deepEqual(await findWallets({ volumeRoot: vol, dataDir }), []);
  // with room to spare it is found
  // aaa itself, data/, zzz/ and zzz's address, password and wallet need 6 visits
  for (let i = 0; i < 6; i++) await rm(path.join(big, `f${i}`));
  assert.deepEqual(
    (await findWallets({ volumeRoot: vol, dataDir })).map((f) => f.dir),
    ["zzz"],
  );
});

test("findWallets: a missing volume root is an empty list", async () => {
  assert.deepEqual(await findWallets({ volumeRoot: path.join(root, "nope"), dataDir }), []);
});

test("findWallets: an unreadable directory is skipped, not thrown", { skip: process.getuid?.() === 0 }, async () => {
  await makeWallet(path.join(vol, "locked", "inner"));
  await makeWallet(path.join(vol, "open"));
  await chmod(path.join(vol, "locked"), 0o000);
  try {
    assert.deepEqual(
      (await findWallets({ volumeRoot: vol, dataDir })).map((f) => f.dir),
      ["open"],
    );
  } finally {
    await chmod(path.join(vol, "locked"), 0o755);
  }
});

// ---------- adoptFoundWallet ----------

test("adopt: copies wallet, password, address, validators and custom keys; verified; source untouched", async () => {
  const src = path.join(vol, "backups", "legacy-20261006T200006Z");
  await makeWallet(src, { validators: true, customKeys: true });
  await writeFile(path.join(src, "custom-key-passwords"), "0xaa: pw\n");
  await writeFile(path.join(src, "transactions.json"), "[]");
  await writeFile(path.join(src, "mnemonic"), "never copied");
  const before1 = await treeSum(src);

  const r = await adoptFoundWallet(opts, { dir: "backups/legacy-20261006T200006Z" });

  assert.equal(r.dir, "backups/legacy-20261006T200006Z");
  assert.deepEqual(r.copied, [
    "wallet",
    "password",
    "address",
    "custom-key-passwords",
    "transactions.json",
    "validators",
    "custom-keys",
  ]);
  assert.equal(r.restarted, false, "no supervisord in the test");
  assert.match(r.restartError ?? "", /supervisord/);

  const mode = async (p: string) => (await stat(path.join(dataDir, p))).mode & 0o777;
  assert.equal(await mode("wallet"), 0o600);
  assert.equal(await mode("password"), 0o600);
  assert.equal(await mode("address"), 0o644);
  assert.equal(await mode("custom-key-passwords"), 0o600);
  assert.equal(await mode("transactions.json"), 0o600);
  for (const rel of [
    "wallet",
    "password",
    "address",
    "custom-key-passwords",
    "transactions.json",
    "validators/teku/keys/0xaa.json",
    "validators/teku/passwords/0xaa.txt",
    "custom-keys/keystore-1.json",
  ]) {
    assert.deepEqual(await readFile(path.join(dataDir, rel)), await readFile(path.join(src, rel)), rel);
  }
  assert.equal(await exists(path.join(dataDir, "mnemonic")), false, "the plaintext phrase is never copied");
  assert.deepEqual(await treeSum(src), before1, "source untouched");
  assert.ok(await exists(opts.reconcileTriggerFile), "the key check is asked to run");
});

test("adopt: a root-level wallet (dir \"\") and a missing data dir work", async () => {
  await rm(dataDir, { recursive: true });
  await makeWallet(vol, { address: null });
  const r = await adoptFoundWallet(opts, { dir: "" });
  assert.deepEqual(r.copied, ["wallet", "password"]);
  assert.equal(await readFile(path.join(dataDir, "wallet"), "utf8"), WALLET);
});

test("adopt: identical files already in the data dir are kept, an empty validators dir is filled", async () => {
  const src = path.join(vol, "backups", "legacy-x");
  await makeWallet(src, { validators: true });
  await writeFile(path.join(dataDir, "password"), "fixture-password", { mode: 0o600 });
  await mkdir(path.join(dataDir, "validators"));
  const r = await adoptFoundWallet(opts, { dir: "backups/legacy-x" });
  assert.deepEqual(r.copied, ["wallet", "address", "validators"]);
  assert.equal(await readFile(path.join(dataDir, "validators", "teku", "keys", "0xaa.json"), "utf8"), '{"pubkey":"aa"}');
});

test("adopt: refuses a body without dir, or a dir not on the list (400); writes nothing", async () => {
  await makeWallet(path.join(vol, "backups", "legacy-x"));
  await makeWallet(path.join(root, "outside"));
  const before1 = await treeSum(vol);
  for (const body of [
    undefined,
    null,
    {},
    [],
    "backups/legacy-x",
    { dir: 1 },
    { dir: null },
    { dir: "backups/legacy-y" },
    { dir: "backups/legacy-x/" },
    { dir: "./backups/legacy-x" },
    { dir: "../outside" },
    { dir: path.join(root, "outside") },
    { dir: "data" },
  ]) {
    await assert.rejects(
      () => adoptFoundWallet(opts, body),
      (e: unknown) =>
        e instanceof HttpError &&
        e.statusCode === 400 &&
        e.message === "That wallet is not on the list any more. Reload the page and try again.",
      JSON.stringify(body),
    );
  }
  assert.deepEqual(await treeSum(vol), before1);
  assert.equal(await exists(opts.reconcileTriggerFile), false);
});

test("adopt: refuses when the data dir already has a wallet (409); writes nothing", async () => {
  await makeWallet(path.join(vol, "backups", "legacy-x"), { validators: true });
  for (const make of [
    () => writeFile(path.join(dataDir, "wallet"), "{}"),
    () => mkdir(path.join(dataDir, "wallet")),
    () => symlink(path.join(root, "nowhere"), path.join(dataDir, "wallet")),
  ]) {
    await rm(path.join(dataDir, "wallet"), { recursive: true, force: true });
    await make();
    const before1 = await treeSum(vol);
    await assert.rejects(
      () => adoptFoundWallet(opts, { dir: "backups/legacy-x" }),
      (e: unknown) =>
        e instanceof HttpError &&
        e.statusCode === 409 &&
        e.message === "This AVADO already has a Rocket Pool wallet. Nothing was changed.",
    );
    assert.deepEqual(await treeSum(vol), before1);
  }
  assert.equal(await exists(opts.reconcileTriggerFile), false);
});

test("adopt: a copy that fails midway removes everything it created (500); source untouched", async () => {
  const src = path.join(vol, "backups", "legacy-x");
  await makeWallet(src, { validators: true });
  const srcBefore = await treeSum(src);
  // a directory named password is in the way: the wallet is copied first, then this fails
  await mkdir(path.join(dataDir, "password"));
  await writeFile(path.join(dataDir, "api-tokens.json"), "{}");
  const dataBefore = await treeSum(dataDir);
  await assert.rejects(
    () => adoptFoundWallet(opts, { dir: "backups/legacy-x" }),
    (e: unknown) =>
      e instanceof HttpError &&
      e.statusCode === 500 &&
      e.message.startsWith("Putting the wallet back failed: ") &&
      e.message.endsWith(". Nothing was changed."),
  );
  assert.deepEqual(await treeSum(dataDir), dataBefore, "only what the call created is removed");
  assert.deepEqual(await treeSum(src), srcBefore, "source untouched");
  assert.equal(await exists(opts.reconcileTriggerFile), false);
});

test("adopt: a different password already in the data dir is never overwritten (500)", async () => {
  await makeWallet(path.join(vol, "backups", "legacy-x"));
  await writeFile(path.join(dataDir, "password"), "another-password");
  const dataBefore = await treeSum(dataDir);
  await assert.rejects(
    () => adoptFoundWallet(opts, { dir: "backups/legacy-x" }),
    (e: unknown) => e instanceof HttpError && e.statusCode === 500 && /password/.test(e.message),
  );
  assert.deepEqual(await treeSum(dataDir), dataBefore);
});

test("adopt: a conflict deep in validators/ removes the files and folders this call created, keeps the rest", async () => {
  const src = path.join(vol, "backups", "legacy-x");
  await makeWallet(src, { validators: true, customKeys: true });
  const srcBefore = await treeSum(src);
  await mkdir(path.join(dataDir, "validators", "teku", "passwords"), { recursive: true });
  await writeFile(path.join(dataDir, "validators", "teku", "passwords", "0xaa.txt"), "a different pw");
  const dataBefore = await treeSum(dataDir);
  await assert.rejects(
    () => adoptFoundWallet(opts, { dir: "backups/legacy-x" }),
    (e: unknown) => e instanceof HttpError && e.statusCode === 500,
  );
  assert.deepEqual(await treeSum(dataDir), dataBefore);
  assert.deepEqual(await treeSum(src), srcBefore);
});

test("adopt: symlinks inside the source are not copied", async () => {
  const src = path.join(vol, "backups", "legacy-x");
  await makeWallet(src, { validators: true });
  await writeFile(path.join(root, "secret"), "outside the volume");
  await symlink(path.join(root, "secret"), path.join(src, "validators", "teku", "keys", "0xbb.json"));
  await symlink(path.join(root, "secret"), path.join(src, "transactions.json"));
  const r = await adoptFoundWallet(opts, { dir: "backups/legacy-x" });
  assert.deepEqual(r.copied, ["wallet", "password", "address", "validators"]);
  assert.equal(await exists(path.join(dataDir, "validators", "teku", "keys", "0xbb.json")), false);
  assert.equal(await exists(path.join(dataDir, "transactions.json")), false);
});

// ---------- supervisor restartProcess ----------

function fakeSupervisor(socketPath: string, reply: (method: string) => string): Promise<{ server: http.Server; calls: string[] }> {
  const calls: string[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const m = /<methodName>([^<]+)<\/methodName>/.exec(body)?.[1] ?? "";
      calls.push(`${m} ${/<string>([^<]*)<\/string>/.exec(body)?.[1]} ${/<boolean>([01])<\/boolean>/.exec(body)?.[1]}`);
      res.writeHead(200, { "Content-Type": "text/xml" });
      res.end(reply(m));
    });
  });
  return new Promise((r) => server.listen(socketPath, () => r({ server, calls })));
}
const OK = `<?xml version="1.0"?><methodResponse><params><param><value><boolean>1</boolean></value></param></params></methodResponse>`;
const fault = (s: string) =>
  `<?xml version="1.0"?><methodResponse><fault><value><struct><member><name>faultCode</name><value><int>70</int></value></member><member><name>faultString</name><value><string>${s}</string></value></member></struct></value></fault></methodResponse>`;

test("restartProcess: stop then start; NOT_RUNNING on stop is fine", async () => {
  const sock = path.join(root, "s.sock");
  for (const stopReply of [OK, fault("NOT_RUNNING")]) {
    const { server, calls } = await fakeSupervisor(sock, (m) => (m === "supervisor.stopProcess" ? stopReply : OK));
    try {
      assert.deepEqual(await restartProcess(sock, "rocketpool-node"), { ok: true });
      assert.deepEqual(calls, ["supervisor.stopProcess rocketpool-node 1", "supervisor.startProcess rocketpool-node 1"]);
    } finally {
      await new Promise((r) => server.close(r));
    }
  }
});

test("restartProcess: any other fault, or no supervisord, is ok:false with an error", async () => {
  const sock = path.join(root, "s.sock");
  const { server } = await fakeSupervisor(sock, (m) => (m === "supervisor.startProcess" ? fault("SPAWN_ERROR: rocketpool-node") : OK));
  try {
    const r = await restartProcess(sock, "rocketpool-node");
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /SPAWN_ERROR/);
  } finally {
    await new Promise((r) => server.close(r));
  }
  const gone = await restartProcess(path.join(root, "nope.sock"), "rocketpool-node");
  assert.equal(gone.ok, false);
  assert.match(gone.error ?? "", /supervisord not reachable/);
});

test("adopt: restarts the daemon through supervisord when it is there", async () => {
  const sock = path.join(root, "s.sock");
  const { server, calls } = await fakeSupervisor(sock, () => OK);
  try {
    await makeWallet(path.join(vol, "backups", "legacy-x"));
    const r = await adoptFoundWallet({ ...opts, supervisorSocket: sock }, { dir: "backups/legacy-x" });
    assert.equal(r.restarted, true);
    assert.equal(r.restartError, undefined);
    assert.deepEqual(
      calls.map((c) => c.split(" ")[0]),
      ["supervisor.stopProcess", "supervisor.startProcess"],
    );
  } finally {
    await new Promise((r) => server.close(r));
  }
});

// ---------- HTTP: status + POST /api/avado/wallet/adopt ----------

let h: Harness;
let hVol: string;
before(async () => {
  h = await startHarness();
  hVol = path.dirname(h.config.dataDir);
});
after(async () => {
  await h.close();
});

test("config: the volume root defaults to the parent of the data dir", () => {
  assert.equal(h.config.volumeRoot, hVol);
});

test("status: foundWallets lists candidates while the data dir has no wallet, [] once it has one", async () => {
  await makeWallet(path.join(hVol, "backups", "legacy-20261006T200006Z"), { validators: true });
  const s1 = await h.request("GET", "/api/avado/status");
  assert.equal(s1.status, 200);
  assert.equal(s1.json.walletFilePresent, false);
  assert.equal(s1.json.foundWallets.length, 1);
  assert.equal(s1.json.foundWallets[0].dir, "backups/legacy-20261006T200006Z");
  assert.equal(s1.json.foundWallets[0].address, ADDRESS);
  assert.ok(!s1.text.includes("fixture-password"), "never the password");
  assert.ok(!s1.text.includes("ciphertext"), "never the wallet contents");

  await writeFile(path.join(h.config.dataDir, "wallet"), WALLET);
  const s2 = await h.request("GET", "/api/avado/status");
  assert.equal(s2.json.walletFilePresent, true);
  assert.deepEqual(s2.json.foundWallets, []);
  await rm(path.join(h.config.dataDir, "wallet"));
});

test("wallet/adopt: CSRF applies; GET is refused; a bad body is 400/415", async () => {
  const body = { dir: "backups/legacy-20261006T200006Z" };
  assert.equal((await h.post("/api/avado/wallet/adopt", body, { "X-Avado-Request": "" })).status, 403);
  assert.equal((await h.post("/api/avado/wallet/adopt", body, { Origin: "http://evil.example" })).status, 403);
  assert.equal((await h.request("GET", "/api/avado/wallet/adopt")).status, 405);
  assert.equal((await h.post("/api/avado/wallet/adopt", "{bad")).status, 400);
  assert.equal(
    (await h.post("/api/avado/wallet/adopt", "dir=x", { "Content-Type": "application/x-www-form-urlencoded" })).status,
    415,
  );
  const notListed = await h.post("/api/avado/wallet/adopt", { dir: "../../etc" });
  assert.equal(notListed.status, 400);
  assert.equal(notListed.json.error, "That wallet is not on the list any more. Reload the page and try again.");
  assert.equal(await exists(path.join(h.config.dataDir, "wallet")), false);
});

test("wallet/adopt: puts the wallet in place, asks for a key check, then 409 on a second click", async () => {
  const upstreamBefore = h.calls.length;
  const r = await h.post("/api/avado/wallet/adopt", { dir: "backups/legacy-20261006T200006Z" });
  assert.equal(r.status, 200);
  assert.equal(r.json.status, "success");
  assert.equal(r.json.dir, "backups/legacy-20261006T200006Z");
  assert.deepEqual(r.json.copied, ["wallet", "password", "address", "validators"]);
  assert.equal(r.json.restarted, false);
  assert.equal(typeof r.json.restartError, "string");
  assert.equal(await readFile(path.join(h.config.dataDir, "wallet"), "utf8"), WALLET);
  assert.ok(await exists(h.config.reconcileTriggerFile));
  assert.ok(h.logs.some((l) => l.includes("wallet adopted from backups/legacy-20261006T200006Z: wallet,password,address,validators")));
  assert.ok(!h.logs.join("\n").includes("fixture-password"));
  assert.equal(h.calls.length, upstreamBefore, "nothing is forwarded to Smartnode");

  const again = await h.post("/api/avado/wallet/adopt", { dir: "backups/legacy-20261006T200006Z" });
  assert.equal(again.status, 409);
  assert.equal(again.json.error, "This AVADO already has a Rocket Pool wallet. Nothing was changed.");
});
