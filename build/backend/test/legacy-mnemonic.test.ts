import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { archiveLegacyMnemonic, LEGACY_MNEMONIC_FILE, listBackups, MNEMONIC_ARCHIVE_CONFIRM_TEXT } from "../src/backup";
import { HttpError } from "../src/http-util";
import { startHarness, type Harness } from "./helpers";

const MNEMONIC = "legal winner thank year wave sausage worth useful legal winner thank yellow";
const exists = (p: string) => stat(p).then(() => true, () => false);

// ---------- unit: archiveLegacyMnemonic / listBackups ----------

let root: string;
let dataDir: string;
let backupDir: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "rp-mnemonic-"));
  dataDir = path.join(root, "data");
  backupDir = path.join(root, "backups");
  await mkdir(dataDir, { recursive: true });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("archiveLegacyMnemonic: refuses a wrong or missing confirmation; nothing is written", async () => {
  await writeFile(path.join(dataDir, LEGACY_MNEMONIC_FILE), MNEMONIC);
  for (const body of [{}, { confirm: "archive" }, { confirm: "Archive" }, { confirm: "YES" }, undefined, null, "ARCHIVE", []]) {
    await assert.rejects(
      () => archiveLegacyMnemonic({ dataDir, backupDir }, body),
      (e: unknown) => e instanceof HttpError && e.statusCode === 400,
      JSON.stringify(body),
    );
  }
  assert.equal(await readFile(path.join(dataDir, LEGACY_MNEMONIC_FILE), "utf8"), MNEMONIC, "original untouched");
  assert.equal(await exists(backupDir), false, "the backups dir is never even created on a bad confirmation");
});

test("archiveLegacyMnemonic: 404 when there is no legacy mnemonic file", async () => {
  await assert.rejects(
    () => archiveLegacyMnemonic({ dataDir, backupDir }, { confirm: MNEMONIC_ARCHIVE_CONFIRM_TEXT }),
    (e: unknown) => e instanceof HttpError && e.statusCode === 404,
  );
  assert.equal(await exists(backupDir), false);
});

test("archiveLegacyMnemonic: moves the file, verified, mode 0600, with a mnemonic-archive backup-info.json", async () => {
  await writeFile(path.join(dataDir, LEGACY_MNEMONIC_FILE), MNEMONIC, { mode: 0o644 });
  const now = new Date("2026-09-24T10:00:00Z");
  const r = await archiveLegacyMnemonic({ dataDir, backupDir, now }, { confirm: MNEMONIC_ARCHIVE_CONFIRM_TEXT });
  assert.equal(r.name, "mnemonic-archive-20260924T100000Z");
  assert.equal(r.path, path.join(backupDir, r.name));

  // the original is gone: the phrase now lives only in the backup
  assert.equal(await exists(path.join(dataDir, LEGACY_MNEMONIC_FILE)), false);

  const archived = path.join(backupDir, r.name, LEGACY_MNEMONIC_FILE);
  assert.equal(await readFile(archived, "utf8"), MNEMONIC);
  assert.equal((await stat(archived)).mode & 0o777, 0o600);
  assert.equal((await stat(path.join(backupDir, r.name))).mode & 0o777, 0o700);

  const info = JSON.parse(await readFile(path.join(backupDir, r.name, "backup-info.json"), "utf8"));
  assert.equal(info.kind, "mnemonic-archive");
  assert.equal(info.createdAt, now.toISOString());
  assert.equal((await stat(path.join(backupDir, r.name, "backup-info.json"))).mode & 0o777, 0o600);

  assert.deepEqual((await readdir(path.join(backupDir, r.name))).sort(), ["backup-info.json", LEGACY_MNEMONIC_FILE]);
});

test("archiveLegacyMnemonic: never reuses a directory", async () => {
  await writeFile(path.join(dataDir, LEGACY_MNEMONIC_FILE), MNEMONIC);
  const now = new Date("2026-09-24T10:00:00Z");
  const a = await archiveLegacyMnemonic({ dataDir, backupDir, now }, { confirm: MNEMONIC_ARCHIVE_CONFIRM_TEXT });
  // a fresh legacy file reappears (e.g. a downgrade back to the pre-1.0 package, then a re-upgrade)
  await writeFile(path.join(dataDir, LEGACY_MNEMONIC_FILE), MNEMONIC);
  const b = await archiveLegacyMnemonic({ dataDir, backupDir, now }, { confirm: MNEMONIC_ARCHIVE_CONFIRM_TEXT });
  assert.equal(a.name, "mnemonic-archive-20260924T100000Z");
  assert.equal(b.name, "mnemonic-archive-20260924T100000Z-2");
});

test("archiveLegacyMnemonic: the backup-info.json kind is not package-upgrade, so the shell pruning rule never removes it", async () => {
  await writeFile(path.join(dataDir, LEGACY_MNEMONIC_FILE), MNEMONIC);
  const r = await archiveLegacyMnemonic({ dataDir, backupDir }, { confirm: MNEMONIC_ARCHIVE_CONFIRM_TEXT });
  const info = JSON.parse(await readFile(path.join(backupDir, r.name, "backup-info.json"), "utf8"));
  assert.notEqual(info.kind, "package-upgrade");
});

test("listBackups classifies a mnemonic archive directory as mnemonic-archive", async () => {
  await writeFile(path.join(dataDir, LEGACY_MNEMONIC_FILE), MNEMONIC);
  const r = await archiveLegacyMnemonic({ dataDir, backupDir }, { confirm: MNEMONIC_ARCHIVE_CONFIRM_TEXT });
  await mkdir(path.join(backupDir, "1.0.0-20260924T090000Z"), { recursive: true });
  const backups = await listBackups(backupDir);
  assert.deepEqual(
    backups.map((b) => [b.name, b.kind]).sort(),
    [
      ["1.0.0-20260924T090000Z", "upgrade"],
      [r.name, "mnemonic-archive"],
    ].sort(),
  );
});

// ---------- HTTP: POST /api/avado/legacy-mnemonic/archive ----------

let h: Harness;
before(async () => {
  h = await startHarness();
});
after(async () => {
  await h.close();
});

test("legacy-mnemonic/archive: 404 with no legacy file, 400 on a wrong confirmation, nothing forwarded upstream", async () => {
  const missing = await h.post("/api/avado/legacy-mnemonic/archive", { confirm: "ARCHIVE" });
  assert.equal(missing.status, 404);

  await writeFile(path.join(h.config.dataDir, LEGACY_MNEMONIC_FILE), MNEMONIC);
  for (const body of [{}, { confirm: "archive" }, { confirm: "delete" }, { confirm: "Archive" }]) {
    const r = await h.post("/api/avado/legacy-mnemonic/archive", body);
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  assert.equal(await readFile(path.join(h.config.dataDir, LEGACY_MNEMONIC_FILE), "utf8"), MNEMONIC, "still there after every refusal");
  assert.equal(h.calls.length, 0, "no request ever reaches Smartnode");
});

test("legacy-mnemonic/archive: CSRF and Host guards apply; GET is refused", async () => {
  await writeFile(path.join(h.config.dataDir, LEGACY_MNEMONIC_FILE), MNEMONIC);
  const body = { confirm: "ARCHIVE" };
  assert.equal((await h.post("/api/avado/legacy-mnemonic/archive", body, { "X-Avado-Request": "" })).status, 403);
  assert.equal((await h.post("/api/avado/legacy-mnemonic/archive", body, { Origin: "http://evil.example" })).status, 403);
  assert.equal((await h.post("/api/avado/legacy-mnemonic/archive", body, { Host: "evil.example" })).status, 421);
  assert.equal((await h.request("GET", "/api/avado/legacy-mnemonic/archive")).status, 405);
  assert.equal(await readFile(path.join(h.config.dataDir, LEGACY_MNEMONIC_FILE), "utf8"), MNEMONIC);
});

test("legacy-mnemonic/archive: a bad JSON body is 400, a form body is 415", async () => {
  await writeFile(path.join(h.config.dataDir, LEGACY_MNEMONIC_FILE), MNEMONIC);
  assert.equal((await h.post("/api/avado/legacy-mnemonic/archive", "{bad")).status, 400);
  assert.equal(
    (await h.post("/api/avado/legacy-mnemonic/archive", "confirm=ARCHIVE", { "Content-Type": "application/x-www-form-urlencoded" })).status,
    415,
  );
  assert.equal(await readFile(path.join(h.config.dataDir, LEGACY_MNEMONIC_FILE), "utf8"), MNEMONIC);
});

test("legacy-mnemonic/archive: moves the file, and status stops reporting it as present", async () => {
  await writeFile(path.join(h.config.dataDir, LEGACY_MNEMONIC_FILE), MNEMONIC);
  const before1 = await h.request("GET", "/api/avado/status");
  assert.equal(before1.json.legacyMnemonicPresent, true);

  const r = await h.post("/api/avado/legacy-mnemonic/archive", { confirm: "ARCHIVE" });
  assert.equal(r.status, 200);
  assert.equal(r.json.status, "success");
  assert.equal(r.json.archived, true);
  assert.match(r.json.name, /^mnemonic-archive-\d{8}T\d{6}Z$/);
  assert.ok(!r.text.includes("legal winner"), "the phrase never appears in the response");
  assert.ok(!h.logs.join("\n").includes("legal winner"), "the phrase never appears in the logs");

  const after1 = await h.request("GET", "/api/avado/status");
  assert.equal(after1.json.legacyMnemonicPresent, false);
  assert.deepEqual(
    after1.json.backups.map((b: { name: string; kind: string }) => [b.name, b.kind]),
    [[r.json.name, "mnemonic-archive"]],
  );

  assert.equal(await exists(path.join(h.config.dataDir, LEGACY_MNEMONIC_FILE)), false);
  const archived = await readFile(path.join(h.config.backupDir, r.json.name, LEGACY_MNEMONIC_FILE), "utf8");
  assert.equal(archived, MNEMONIC);
});

test("legacy-mnemonic/archive: 404 once already archived (no legacy file left)", async () => {
  const r = await h.post("/api/avado/legacy-mnemonic/archive", { confirm: "ARCHIVE" });
  assert.equal(r.status, 404);
});

test("own POST endpoint refuses a non-POST method the same way other avado routes do", async () => {
  assert.equal((await h.request("HEAD", "/api/avado/legacy-mnemonic/archive")).status, 405);
});
