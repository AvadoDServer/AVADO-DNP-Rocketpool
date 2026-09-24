import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import { inflateRawSync } from "node:zlib";
import { BACKUP_README, downloadFileName } from "../src/avado/backup-download";
import { listBackups } from "../src/backup";
import { startHarness, type Harness } from "./helpers";

/** A minimal zip reader for the tests: central directory → name → contents. */
function unzip(buf: Buffer): Map<string, Buffer> {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  assert.ok(eocd >= 0, "no end of central directory record");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();
  for (let n = 0; n < count; n++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50);
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    assert.equal(buf.readUInt32LE(local), 0x04034b50);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + csize);
    out.set(name, method === 8 ? inflateRawSync(data) : Buffer.from(data));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

const NODE_ADDRESS = "0xAbCdEf0123456789abcdef0123456789ABCDEF01";

let h: Harness;
beforeEach(async () => {
  await h?.close();
  h = await startHarness();
  h.setUpstream((call) =>
    call.path === "/api/wallet/status"
      ? { body: JSON.stringify({ status: "success", error: "", walletInitialized: true, passwordSet: true, nodeAddress: NODE_ADDRESS }) }
      : { body: '{"status":"success","error":""}' },
  );
});
after(async () => h?.close());

/** POSTs like the UI does and collects the raw answer. */
function download(body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; buf: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = http.request(`${h.base}/api/avado/backups/download`, {
      method: "POST",
      headers: {
        Host: new URL(h.base).host,
        Origin: h.base,
        "Content-Type": "application/json",
        "X-Avado-Request": "1",
        ...headers,
      },
    });
    req.on("response", (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, buf: Buffer.concat(chunks) }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(typeof body === "string" ? body : JSON.stringify(body));
  });
}

async function seedBackup(name: string): Promise<string> {
  const b = path.join(h.config.backupDir, name);
  await mkdir(path.join(b, "validators", "teku", "keys"), { recursive: true });
  await writeFile(path.join(b, "wallet"), '{"crypto":"backed-up-wallet"}', { mode: 0o600 });
  await writeFile(path.join(b, "password"), "backed-up-password", { mode: 0o600 });
  await writeFile(path.join(b, "validators", "teku", "keys", "0xabc.json"), '{"k":1}');
  await writeFile(path.join(b, "backup-info.json"), '{"kind":"package-upgrade"}');
  return b;
}

async function seedWallet() {
  const d = h.config.dataDir;
  await writeFile(path.join(d, "wallet"), '{"crypto":"live-wallet"}', { mode: 0o600 });
  await writeFile(path.join(d, "password"), "live-password", { mode: 0o600 });
  await mkdir(path.join(d, "validators", "lighthouse"), { recursive: true });
  await writeFile(path.join(d, "validators", "lighthouse", "k.json"), '{"l":2}');
  await writeFile(path.join(d, "address"), NODE_ADDRESS);
}

test("a named backup is streamed as a zip with a README, as an attachment", async () => {
  const name = "0.0.106-20260923T100000Z";
  const b = await seedBackup(name);
  // a symlink inside a backup is never followed
  await symlink(h.config.dataDir, path.join(b, "link-to-data"));
  const r = await download({ name });
  assert.equal(r.status, 200);
  assert.equal(r.headers["content-type"], "application/zip");
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  assert.equal(r.headers["content-disposition"], `attachment; filename="avado-rocketpool-backup-abcdef01-${today}.zip"`);
  assert.equal(r.headers["cache-control"], "no-store");
  const z = unzip(r.buf);
  assert.deepEqual([...z.keys()].sort(), [
    `${name}/`,
    `${name}/backup-info.json`,
    `${name}/password`,
    `${name}/validators/`,
    `${name}/validators/teku/`,
    `${name}/validators/teku/keys/`,
    `${name}/validators/teku/keys/0xabc.json`,
    `${name}/wallet`,
    "README.txt",
  ]);
  assert.equal(z.get(`${name}/wallet`)!.toString(), '{"crypto":"backed-up-wallet"}');
  assert.equal(z.get(`${name}/password`)!.toString(), "backed-up-password");
  assert.equal(z.get("README.txt")!.toString(), BACKUP_README);
  // contents are never logged; the name is
  const logs = h.logs.join("\n");
  assert.ok(logs.includes(`backup download: ${name}`), logs);
  assert.ok(!logs.includes("backed-up-wallet") && !logs.includes("backed-up-password"));
});

test("path traversal, symlinks, files and hidden names are refused with 404; nothing is streamed", async () => {
  await seedBackup("1.0.0-20260924T100000Z");
  await seedWallet();
  await writeFile(path.join(h.config.backupDir, "a-file"), "x");
  await mkdir(path.join(h.config.backupDir, ".partial-1.0.0-20260924T100000Z"));
  await symlink(h.config.dataDir, path.join(h.config.backupDir, "link-to-data"));
  for (const name of [
    "..",
    ".",
    "../data",
    "../rocketpool/data",
    "1.0.0-20260924T100000Z/../../data",
    "1.0.0-20260924T100000Z/wallet",
    "/etc",
    h.config.dataDir,
    "%2e%2e",
    "..\\data",
    "a-file",
    ".partial-1.0.0-20260924T100000Z",
    "link-to-data",
    "1.0.0-20260924T100000Z\u0000",
  ]) {
    const r = await download({ name });
    assert.equal(r.status, 404, name);
    assert.equal(JSON.parse(r.buf.toString()).status, "error", name);
  }
});

test("an unknown name is 404; a bad body is 400; not JSON is 415", async () => {
  assert.equal((await download({ name: "1.0.0-20990101T000000Z" })).status, 404);
  for (const body of [{}, { name: "" }, { name: 5 }, [], "null"]) assert.equal((await download(body)).status, 400, JSON.stringify(body));
  assert.equal((await download("{")).status, 400);
  assert.equal((await download({ name: "current" }, { "Content-Type": "text/plain" })).status, 415);
});

test("the CSRF and Host guards apply; GET is refused", async () => {
  assert.equal((await download({ name: "current" }, { "X-Avado-Request": "" })).status, 403);
  assert.equal((await download({ name: "current" }, { Origin: "http://evil.example" })).status, 403);
  assert.equal((await download({ name: "current" }, { Host: "evil.example" })).status, 421);
  const g = await h.request("GET", "/api/avado/backups/download");
  assert.equal(g.status, 405);
  await assert.rejects(readdir(h.config.backupDir));
});

test('"current" makes a fresh, never-pruned backup (kind manual) and streams it', async () => {
  await seedWallet();
  const r = await download({ name: "current" });
  assert.equal(r.status, 200);
  const dirs = await readdir(h.config.backupDir);
  assert.equal(dirs.length, 1);
  const name = dirs[0]!;
  assert.match(name, /^\d{8}T\d{6}Z-manual-download$/);
  const info = JSON.parse(await readFile(path.join(h.config.backupDir, name, "backup-info.json"), "utf8"));
  assert.equal(info.kind, "manual");
  assert.equal(info.keepForever, true);
  assert.deepEqual(info.items, ["wallet", "password", "validators", "address"]);
  const z = unzip(r.buf);
  assert.equal(z.get(`${name}/wallet`)!.toString(), '{"crypto":"live-wallet"}');
  assert.equal(z.get(`${name}/password`)!.toString(), "live-password");
  assert.equal(z.get(`${name}/validators/lighthouse/k.json`)!.toString(), '{"l":2}');
  assert.equal(z.get(`${name}/address`)!.toString(), NODE_ADDRESS);
  assert.ok(z.has("README.txt"));
  assert.deepEqual((await listBackups(h.config.backupDir)).map((b) => b.kind), ["manual"]);
  // the originals are untouched
  assert.equal(await readFile(path.join(h.config.dataDir, "wallet"), "utf8"), '{"crypto":"live-wallet"}');
  assert.ok(!h.logs.join("\n").includes("live-password"));
});

test('"current" without a wallet is 404 and leaves no directory behind', async () => {
  const r = await download({ name: "current" });
  assert.equal(r.status, 404);
  assert.equal(JSON.parse(r.buf.toString()).error, "There is no wallet to back up yet.");
  assert.deepEqual(await readdir(h.config.backupDir), []);
});

test("the file name says unknown when the daemon doesn't answer", async () => {
  await seedWallet();
  h.setUpstream(() => ({ status: 500, body: '{"status":"error","error":"down"}' }));
  const r = await download({ name: "current" });
  assert.equal(r.status, 200);
  assert.match(String(r.headers["content-disposition"]), /filename="avado-rocketpool-backup-unknown-\d{8}\.zip"/);
});

test("downloadFileName: first 8 hex of the node address, lower case; the zero address is unknown", () => {
  const d = new Date("2026-09-24T23:59:00Z");
  assert.equal(downloadFileName(NODE_ADDRESS, d), "avado-rocketpool-backup-abcdef01-20260924.zip");
  assert.equal(downloadFileName("0x" + "0".repeat(40), d), "avado-rocketpool-backup-unknown-20260924.zip");
  assert.equal(downloadFileName("nope", d), "avado-rocketpool-backup-unknown-20260924.zip");
  assert.equal(downloadFileName(undefined, d), "avado-rocketpool-backup-unknown-20260924.zip");
});

test("at most 2 downloads run at once; a third is refused with 429 until one finishes", async () => {
  const name = "1.0.0-20260924T100000Z";
  const b = await seedBackup(name);
  // incompressible and large enough that an unread download stays open (backpressure)
  await writeFile(path.join(b, "big.bin"), randomBytes(16 * 1024 * 1024));
  const open: http.ClientRequest[] = [];
  const started = (): Promise<number> =>
    new Promise((resolve, reject) => {
      const req = http.request(`${h.base}/api/avado/backups/download`, {
        method: "POST",
        headers: { Host: new URL(h.base).host, Origin: h.base, "Content-Type": "application/json", "X-Avado-Request": "1" },
      });
      req.on("response", (res) => {
        res.pause(); // never read: the server keeps the download open
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end(JSON.stringify({ name }));
      open.push(req);
    });
  try {
    assert.equal(await started(), 200);
    assert.equal(await started(), 200);
    const third = await download({ name });
    assert.equal(third.status, 429);
    // one finishes (the browser goes away): a new download is allowed again
    open.shift()!.destroy();
    let status = 0;
    for (let i = 0; i < 50 && status !== 200; i++) {
      await new Promise((r) => setTimeout(r, 20));
      const r = await download({ name: "does-not-exist" });
      status = r.status === 404 ? 200 : r.status; // 404 means it got past the limiter
    }
    assert.equal(status, 200);
  } finally {
    for (const r of open) r.destroy();
  }
  assert.ok((await stat(path.join(b, "big.bin"))).size > 0);
});
