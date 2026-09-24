import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { ABSENCE_FILE, readAbsence, updateAbsence, writeAbsence } from "../src/reconcile/absence";
import {
  addApprovedKeys,
  APPROVED_KEYS_FILE,
  approvedKeysPath,
  checkApprovalsWritable,
  consumeApprovals,
  isUsable,
  readApprovedKeys,
} from "../src/reconcile/approved";
import { startHarness, type Harness } from "./helpers";

const pk = (c: string) => c.repeat(96);
const TX = "0x" + "ab".repeat(32);

// ---------- the approved list on disk ----------

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "rp-approved-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("approved list: missing file is empty; add is append-only, deduplicated, 0600", async () => {
  assert.deepEqual(await readApprovedKeys(dir), { entries: new Map() });
  assert.equal(await addApprovedKeys(dir, [pk("1"), "0x" + pk("2").toUpperCase(), "junk", pk("1")], "deposit", new Date("2026-09-23T10:00:00Z")), 2);
  // pk1 exists (unused deposit approval: renewed), pk3 is new
  assert.equal(await addApprovedKeys(dir, [pk("1"), pk("3")], "owner", new Date("2026-09-24T10:00:00Z")), 2);
  const file = path.join(dir, APPROVED_KEYS_FILE);
  const data = JSON.parse(await readFile(file, "utf8"));
  assert.deepEqual(
    data.keys[pk("1")],
    { source: "deposit", approvedAt: "2026-09-23T10:00:00.000Z", renewedAt: "2026-09-24T10:00:00.000Z" },
    "an existing entry keeps its source",
  );
  assert.equal(data.keys[pk("3")].source, "owner");
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual([...(await readApprovedKeys(dir)).entries.keys()].sort(), [pk("1"), pk("2"), pk("3")]);
  assert.deepEqual((await readdir(dir)).sort(), [APPROVED_KEYS_FILE], "no temp files left");
});

test("approved list: concurrent adds are serialised and none is lost", async () => {
  await Promise.all([pk("1"), pk("2"), pk("3"), pk("4"), pk("5")].map((k) => addApprovedKeys(dir, [k], "owner")));
  assert.equal((await readApprovedKeys(dir)).entries.size, 5);
});

test("approved list: a corrupt file approves nothing and is kept aside, never deleted", async () => {
  const file = path.join(dir, APPROVED_KEYS_FILE);
  await writeFile(file, "{not json");
  const r = await readApprovedKeys(dir);
  assert.equal(r.entries.size, 0);
  assert.match(r.error!, /not valid/);
  await addApprovedKeys(dir, [pk("7")], "owner");
  const names = await readdir(dir);
  const aside = names.find((n) => n.startsWith(`${APPROVED_KEYS_FILE}.corrupt-`));
  assert.ok(aside, names.join(","));
  assert.equal(await readFile(path.join(dir, aside!), "utf8"), "{not json");
  assert.deepEqual([...(await readApprovedKeys(dir)).entries.keys()], [pk("7")]);
});

test("approved list: approvals are single-use; the owner can approve again, a deposit cannot", async () => {
  const t = (h: number) => new Date(Date.UTC(2026, 8, 23, h));
  await addApprovedKeys(dir, [pk("1"), pk("2")], "deposit", t(1));
  assert.equal(await consumeApprovals(dir, [pk("1"), pk("9")], t(2)), 1);
  let e = (await readApprovedKeys(dir)).entries;
  assert.equal(e.get(pk("1"))!.loadedAt, t(2).toISOString());
  assert.equal(isUsable(e.get(pk("1"))), false);
  assert.equal(isUsable(e.get(pk("2"))), true);
  // a deposit never revives a used approval
  assert.equal(await addApprovedKeys(dir, [pk("1")], "deposit", t(3)), 0);
  assert.equal(isUsable((await readApprovedKeys(dir)).entries.get(pk("1"))), false);
  // the owner approving again gives a fresh approval; on an unused one it renews it
  assert.equal(await addApprovedKeys(dir, [pk("1"), pk("2")], "owner", t(4)), 2);
  e = (await readApprovedKeys(dir)).entries;
  assert.deepEqual(e.get(pk("1")), { source: "owner", approvedAt: t(4).toISOString() });
  assert.deepEqual(e.get(pk("2")), { source: "deposit", approvedAt: t(1).toISOString(), renewedAt: t(4).toISOString() });
});

test("absence observations persist across restarts; an unreadable file means nothing has settled", async () => {
  const t0 = new Date("2026-09-23T10:00:00Z");
  const m = updateAbsence(new Map(), new Map([[pk("1"), "absent"], [pk("2"), "present"], [pk("3"), "unknown"]]), t0);
  assert.deepEqual([...m.keys()], [pk("1")]);
  await writeAbsence(dir, m);
  assert.equal((await stat(path.join(dir, ABSENCE_FILE))).mode & 0o777, 0o600);
  assert.deepEqual(await readAbsence(dir), m);
  await writeFile(path.join(dir, ABSENCE_FILE), "garbage");
  assert.equal((await readAbsence(dir)).size, 0);
});

test("checkApprovalsWritable: passes and leaves nothing behind; throws on a read-only data dir", async () => {
  await checkApprovalsWritable(dir);
  assert.deepEqual(await readdir(dir), []);
  await chmod(dir, 0o500);
  try {
    if (process.getuid?.() !== 0) await assert.rejects(() => checkApprovalsWritable(dir));
  } finally {
    await chmod(dir, 0o700);
  }
});

test("checkApprovalsWritable: something else occupying the exact probe path is left untouched, and the real error surfaces", async () => {
  // The cleanup in the `finally` is best-effort (rm force:true, its own errors swallowed):
  // it must never remove something it didn't create itself, and it must never replace the
  // write's own error (here EISDIR: the probe path is a directory) with an unrelated one
  // from a failed cleanup attempt.
  const probe = `${approvedKeysPath(dir)}.probe-${process.pid}`;
  await mkdir(probe);
  await assert.rejects(
    () => checkApprovalsWritable(dir),
    (e: unknown) => e instanceof Error && (e as NodeJS.ErrnoException).code === "EISDIR",
  );
  // the directory that was already there is untouched
  assert.deepEqual(await readdir(probe), []);
  await rm(probe, { recursive: true, force: true });
});

// ---------- HTTP: approve endpoint and the node/deposit hook ----------

let h: Harness;
before(async () => {
  h = await startHarness();
});
after(async () => {
  await h.close();
});

const approvedFile = () => path.join(h.config.dataDir, APPROVED_KEYS_FILE);
const exists = (p: string) => stat(p).then(() => true, () => false);

async function reset() {
  await rm(approvedFile(), { force: true });
  await rm(h.config.reconcileTriggerFile, { force: true });
}

test("approve: needs the typed confirmation and valid pubkeys; nothing is written otherwise", async () => {
  await reset();
  for (const body of [
    { pubkeys: [pk("1")] },
    { pubkeys: [pk("1")], confirm: "load" },
    { pubkeys: [pk("1")], confirm: "YES" },
    { pubkeys: [], confirm: "LOAD" },
    { pubkeys: "0x" + pk("1"), confirm: "LOAD" },
    { pubkeys: [pk("1"), "0x1234"], confirm: "LOAD" },
    { pubkeys: Array.from({ length: 501 }, (_, i) => i.toString(16).padStart(96, "0")), confirm: "LOAD" },
    [pk("1")],
  ]) {
    const r = await h.post("/api/avado/reconcile/approve", body);
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  const big = await h.post("/api/avado/reconcile/approve", { pubkeys: Array.from({ length: 501 }, (_, i) => i.toString(16).padStart(96, "0")), confirm: "LOAD" });
  assert.match(big.json.error, /At most 500/);
  const max = await h.post("/api/avado/reconcile/approve", { pubkeys: Array.from({ length: 500 }, () => "0x" + pk("a")), confirm: "LOAD" });
  assert.equal(max.status, 202, "500 keys fit the body limit");
  await reset();
  assert.equal((await h.post("/api/avado/reconcile/approve", "{bad")).status, 400);
  assert.equal(
    (await h.post("/api/avado/reconcile/approve", "pubkeys=x&confirm=LOAD", { "Content-Type": "application/x-www-form-urlencoded" })).status,
    415,
  );
  assert.equal(await exists(approvedFile()), false);
  assert.equal(await exists(h.config.reconcileTriggerFile), false);
});

test("approve: CSRF and Host guards apply", async () => {
  await reset();
  const body = { pubkeys: [pk("1")], confirm: "LOAD" };
  assert.equal((await h.post("/api/avado/reconcile/approve", body, { "X-Avado-Request": "" })).status, 403);
  assert.equal((await h.post("/api/avado/reconcile/approve", body, { Origin: "http://evil.example" })).status, 403);
  assert.equal((await h.post("/api/avado/reconcile/approve", body, { Host: "evil.example" })).status, 421);
  assert.equal((await h.request("GET", "/api/avado/reconcile/approve")).status, 405);
  assert.equal(await exists(approvedFile()), false);
});

test("approve: appends the keys as owner-approved and asks for a run", async () => {
  await reset();
  const r = await h.post("/api/avado/reconcile/approve", { pubkeys: ["0x" + pk("1"), pk("2"), pk("1")], confirm: "LOAD" });
  assert.equal(r.status, 202);
  assert.deepEqual({ approved: r.json.approved, added: r.json.added, runRequested: r.json.runRequested }, { approved: 2, added: 2, runRequested: true });
  const data = JSON.parse(await readFile(approvedFile(), "utf8"));
  assert.deepEqual(Object.keys(data.keys).sort(), [pk("1"), pk("2")]);
  assert.equal(data.keys[pk("1")].source, "owner");
  assert.ok(await exists(h.config.reconcileTriggerFile));
});

test("node/deposit: a successful deposit approves the new keys; the answer is passed through unchanged", async () => {
  await reset();
  const answer = { status: "success", error: "", txHash: TX, validatorPubkeys: [pk("8"), pk("9")], scrubPeriod: 0 };
  h.setUpstream(() => ({ body: JSON.stringify(answer) }));
  const r = await h.post("/api/sn/node/deposit", { amountWei: "4000000000000000000", submit: true });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, answer);
  const data = JSON.parse(await readFile(approvedFile(), "utf8"));
  assert.deepEqual(Object.keys(data.keys).sort(), [pk("8"), pk("9")]);
  assert.equal(data.keys[pk("8")].source, "deposit");
  assert.ok(await exists(h.config.reconcileTriggerFile), "the loop is asked to load them");
});

test("node/deposit: errors, no transaction hash, or other routes approve nothing", async () => {
  await reset();
  const cases: Array<[string, unknown, number?]> = [
    ["node/deposit", { status: "error", error: "insufficient balance", validatorPubkeys: [pk("8")] }, 500],
    ["node/deposit", { status: "success", error: "", txHash: "0x" + "0".repeat(64), validatorPubkeys: [pk("8")] }],
    ["node/deposit", { status: "success", error: "", validatorPubkeys: [pk("8")] }],
    // a dry run (submit=false) also answers with a transaction hash, but saves no keys
    ["node/deposit#dry", { status: "success", error: "", txHash: TX, validatorPubkeys: [pk("8")] }],
    ["wallet/rebuild", { status: "success", error: "", txHash: TX, validatorPubkeys: [pk("8")], validatorKeys: [pk("8")] }],
  ];
  for (const [route, body, code] of cases) {
    h.setUpstream(() => ({ status: code ?? 200, body: JSON.stringify(body) }));
    const dry = route.endsWith("#dry");
    await h.post(`/api/sn/${route.replace("#dry", "")}`, dry ? { submit: false } : { submit: true });
  }
  assert.equal(await exists(approvedFile()), false);
  h.setUpstream(() => ({ body: '{"status":"success","error":""}' }));
});

test("node/deposit: a slow deposit outlives the normal timeout, and the keys are recorded even after the browser gave up", async () => {
  // the normal write timeout is far shorter than this deposit; node/deposit gets the long one
  const hh = await startHarness({ SN_TIMEOUT_MS: "100", SN_LONG_TIMEOUT_MS: "10000" });
  try {
    const answer = { status: "success", error: "", txHash: TX, validatorPubkeys: [pk("a")] };
    hh.setUpstream(async () => {
      await new Promise((r) => setTimeout(r, 400));
      return { body: JSON.stringify(answer) };
    });
    // the browser closes the request long before the daemon answers
    await new Promise<void>((resolve) => {
      const req = http.request(`${hh.base}/api/sn/node/deposit`, {
        method: "POST",
        headers: {
          Host: new URL(hh.base).host,
          "Content-Type": "application/json",
          "X-Avado-Request": "1",
        },
      });
      req.on("error", () => resolve());
      req.end(JSON.stringify({ amountWei: "4000000000000000000", submit: true }));
      setTimeout(() => {
        req.destroy();
        resolve();
      }, 50);
    });
    const file = path.join(hh.config.dataDir, APPROVED_KEYS_FILE);
    for (let i = 0; i < 100 && !(await exists(file)); i++) await new Promise((r) => setTimeout(r, 20));
    const data = JSON.parse(await readFile(file, "utf8"));
    assert.deepEqual(Object.keys(data.keys), [pk("a")]);
    assert.equal(data.keys[pk("a")].source, "deposit");
    assert.ok(hh.logs.some((l) => /POST \/api\/sn\/node\/deposit 200 /.test(l)), hh.logs.join("\n"));
  } finally {
    await hh.close();
  }
});
